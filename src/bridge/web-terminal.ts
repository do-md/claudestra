/**
 * [fork] Web 远程终端 —— 把 agent 的 tmux window 以真 PTY 实时流到 Web 前端。
 *
 * 架构（设计文档 project-nexus reference/web-terminal-design.md，PoC 2026-07-11 全链路验证）：
 *
 *   xterm.js ⇄ Next.js BFF ⇄ 本文件 3 端点 ⇄ Bun.Terminal(PTY) ⇄ tmux attach ⇄ master:agent-X
 *
 * - 每个 viewer 一条 PTY：`tmux new-session -d -t master -s webterm-<id>`（**grouped
 *   session**——共享 master 的 window 集但 current window 独立，select-window 不会
 *   切走真 session/其他 client 的当前窗口）→ `Bun.Terminal` + `Bun.spawn(tmux attach)`。
 * - 输出：PTY 字节流 → SSE `{"t":"o","d":<base64>}`（连接即发首包 + 5s ping，
 *   Bun.serve idleTimeout≈10s 坑，同 handleEventsRequest 的 [fork] 修复）。
 * - 输入：POST base64 原始字节（xterm onData 的转义序列原样）→ term.write —— tmux
 *   自己解析方向键/Ctrl/粘贴，零翻译。
 * - resize：term.resize 后**必须手动 proc.kill("SIGWINCH")** —— Bun.Terminal spawn
 *   的子进程没有 controlling tty，TIOCSWINSZ 生效但内核不会替我们发信号（PoC 实证）。
 * - 生命周期：SSE 断开（cancel / enqueue 失败 / PTY 退出）→ kill attach 进程 +
 *   kill viewer session。Bridge 启动时 sweepStaleTerminalSessions() 清残留。
 *
 * 鉴权：Bearer + agentInScope 同 /api/v1 messaging 端点，但**不走 SlidingWindowLimiter**
 * （逐键输入秒超 30 req/min；termId 为 crypto 随机 + input/resize 校验 token 属主，
 * 服务只绑 127.0.0.1，风险面与 messaging 相同）。
 */

import { randomBytes } from "node:crypto";
import { TMUX_SOCK, MASTER_SESSION } from "../lib/tmux-helper.js";
import {
  readPrincipals,
  findByBearer,
  agentInScope,
  tokenIdOf,
  type Principal,
} from "../lib/principals.js";

// ---------- tmux 小工具（独立于 tmux-helper 的 tmuxRaw：这里需要 exitCode） ----------

function tmuxArgs(args: string[]): string[] {
  return ["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args];
}

async function tmuxRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(tmuxArgs(args), { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

// ---------- 会话表 ----------

interface TermSession {
  id: string;
  tokenId: string;
  agent: string;
  viewerSession: string;
  term: InstanceType<typeof Bun.Terminal>;
  proc: ReturnType<typeof Bun.spawn>;
  createdAt: number;
  destroy: () => void;
}

const termSessions = new Map<string, TermSession>();
/** 并发 viewer 上限（防泄漏兜底；正常一人用 1-2 个） */
const MAX_TERM_SESSIONS = 8;
const VIEWER_PREFIX = "webterm-";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Bearer 鉴权（同 authApi 但不限流——终端输入逐键回传，30 req/min 秒超）。 */
async function authNoLimit(req: Request): Promise<Principal | Response> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json(401, { ok: false, error: "missing Authorization: Bearer <secret>" });
  const file = await readPrincipals();
  const p = findByBearer(file, m[1].trim());
  if (!p) return json(401, { ok: false, error: "invalid or revoked token" });
  return p;
}

/**
 * agent 名 → master session 里的 window 引用。
 * master → 索引 0（grouped session 的 window 索引与原 session 一致，已实测）；
 * 其余按窗口名匹配（registry 名 "x" ↔ 窗口名 "agent-x" 双向兼容）。
 * 返回 null = 找不到活的 tmux window。
 */
async function resolveWindowRef(agentParam: string): Promise<string | null> {
  if (agentParam === "master") return "0";
  const { code, out } = await tmuxRun(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"]);
  if (code !== 0) return null;
  const names = new Set(out.split("\n"));
  for (const cand of [agentParam, `agent-${agentParam}`]) {
    if (names.has(cand)) return cand;
  }
  return null;
}

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? NaN : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------- 端点 ----------

/**
 * 路由入口。匹配不到终端路径时返回 null（调用方 fallthrough 到 handleApiRequest）。
 *   GET  /api/v1/agents/:name/terminal?cols=&rows=   → SSE 输出流（创建 PTY）
 *   POST /api/v1/terminal/:termId/input  {d: base64} → 写 PTY
 *   POST /api/v1/terminal/:termId/resize {cols,rows} → resize + SIGWINCH
 */
export async function handleTerminalApi(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.slice("/api/v1".length);

  const openMatch = path.match(/^\/agents\/([^/]+)\/terminal$/);
  if (openMatch && req.method === "GET") {
    return openTerminal(req, url, decodeURIComponent(openMatch[1]));
  }

  const ioMatch = path.match(/^\/terminal\/([^/]+)\/(input|resize)$/);
  if (ioMatch && req.method === "POST") {
    const auth = await authNoLimit(req);
    if (auth instanceof Response) return auth;
    const sess = termSessions.get(ioMatch[1]);
    if (!sess) return json(404, { ok: false, error: "terminal session not found (expired?)" });
    if (sess.tokenId !== tokenIdOf(auth)) {
      return json(403, { ok: false, error: "terminal session belongs to another token" });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (ioMatch[2] === "input") {
      const d = typeof body.d === "string" ? body.d : "";
      if (!d) return json(400, { ok: false, error: "missing d (base64 bytes)" });
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(d, "base64"));
      } catch {
        return json(400, { ok: false, error: "invalid base64" });
      }
      try {
        sess.term.write(bytes);
      } catch (e) {
        return json(500, { ok: false, error: `pty write failed: ${(e as Error).message}` });
      }
      return json(200, { ok: true });
    }
    // resize
    const cols = clampInt(String(body.cols ?? ""), 0, 20, 500);
    const rows = clampInt(String(body.rows ?? ""), 0, 5, 200);
    if (!cols || !rows) return json(400, { ok: false, error: "missing/invalid cols,rows" });
    try {
      sess.term.resize(cols, rows);
      // 无 controlling tty → 内核不发 SIGWINCH，必须手动补（PoC 实证，勿删）
      sess.proc.kill("SIGWINCH");
    } catch (e) {
      return json(500, { ok: false, error: `resize failed: ${(e as Error).message}` });
    }
    return json(200, { ok: true, cols, rows });
  }

  return null;
}

/** GET /api/v1/agents/:name/terminal —— 建 PTY + SSE 输出流 */
async function openTerminal(req: Request, url: URL, agentParam: string): Promise<Response> {
  const auth = await authNoLimit(req);
  if (auth instanceof Response) return auth;
  const principal = auth;
  if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
    return json(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
  }
  const windowRef = await resolveWindowRef(agentParam);
  if (windowRef === null) {
    return json(404, { ok: false, error: `no live tmux window for agent "${agentParam}"` });
  }
  if (termSessions.size >= MAX_TERM_SESSIONS) {
    return json(429, { ok: false, error: `too many terminal sessions (max ${MAX_TERM_SESSIONS})` });
  }

  const cols = clampInt(url.searchParams.get("cols"), 100, 20, 500);
  const rows = clampInt(url.searchParams.get("rows"), 30, 5, 200);
  const termId = randomBytes(12).toString("hex");
  const viewerSession = `${VIEWER_PREFIX}${termId}`;

  // grouped session：共享 master 的 windows，current window 独立
  const created = await tmuxRun([
    "new-session", "-d", "-t", MASTER_SESSION, "-s", viewerSession,
    "-x", String(cols), "-y", String(rows),
  ]);
  if (created.code !== 0) {
    return json(500, { ok: false, error: `tmux new-session failed: ${created.err}` });
  }
  const selected = await tmuxRun(["select-window", "-t", `${viewerSession}:${windowRef}`]);
  if (selected.code !== 0) {
    await tmuxRun(["kill-session", "-t", viewerSession]);
    return json(500, { ok: false, error: `tmux select-window failed: ${selected.err}` });
  }
  // 滚动支持：CC TUI 在 alternate screen（无滚动缓冲），滚轮要靠 tmux 的
  // copy-mode——viewer session 开 mouse（session 级选项，master/本地 attach
  // 不受影响），tmux 会向 PTY 请求鼠标上报，xterm.js 自动转发滚轮 → tmux
  // 进 copy-mode 翻 pane 历史（Esc/q 或滚到底退出，与 iTerm 体验一致）。
  await tmuxRun(["set-option", "-t", viewerSession, "mouse", "on"]);

  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const destroy = () => {
        if (closed) return;
        closed = true;
        if (ping) { clearInterval(ping); ping = null; }
        termSessions.delete(termId);
        try { sess.proc.kill(); } catch { /* 已退出 */ }
        try { sess.term.close(); } catch { /* 已关闭 */ }
        // fire-and-forget：viewer session 清理失败由启动 sweep 兜底
        tmuxRun(["kill-session", "-t", viewerSession]).catch(() => {});
        try { controller.close(); } catch { /* 已关闭 */ }
        console.log(`🖥️ [term] closed id=${termId.slice(0, 8)} agent=${agentParam}`);
      };
      const send = (payload: string) => {
        try {
          controller.enqueue(enc.encode(payload));
        } catch {
          destroy(); // controller 已关（客户端断开）
        }
      };

      const term = new Bun.Terminal({
        cols,
        rows,
        data(_t: unknown, bytes: Uint8Array) {
          send(`data: {"t":"o","d":"${Buffer.from(bytes).toString("base64")}"}\n\n`);
        },
      });
      const proc = Bun.spawn(tmuxArgs(["attach", "-t", viewerSession]), {
        terminal: term,
        env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8" },
      });
      const sess: TermSession = {
        id: termId,
        tokenId: tokenIdOf(principal),
        agent: agentParam,
        viewerSession,
        term,
        proc,
        createdAt: Date.now(),
        destroy,
      };
      termSessions.set(termId, sess);

      // 首包立即 flush（Bun idleTimeout 坑）+ 告知前端 termId（input/resize 用）
      send(`: connected\n\n`);
      send(`data: {"t":"open","id":"${termId}","cols":${cols},"rows":${rows}}\n\n`);
      ping = setInterval(() => send(`: ping\n\n`), 5_000);

      // PTY 进程退出（window 被 kill / tmux server 重启）→ 通知前端并收尾
      proc.exited.then(() => {
        if (closed) return;
        send(`data: {"t":"exit"}\n\n`);
        destroy();
      });

      console.log(`🖥️ [term] open id=${termId.slice(0, 8)} agent=${agentParam} ${cols}x${rows} (token=${sess.tokenId})`);
    },
    cancel() {
      termSessions.get(termId)?.destroy();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/** 单条 PTY 会话的最长存活（TTL 兜底）。正常关闭走 SSE 断开；这里防的是
 *  取消传导失败的僵尸（实测过一例：dev 双 effect + BFF 透传 body 漏 abort）。 */
const MAX_TERM_AGE_MS = 12 * 60 * 60 * 1000;

function reapExpiredTerminalSessions(): void {
  const now = Date.now();
  for (const sess of [...termSessions.values()]) {
    if (now - sess.createdAt > MAX_TERM_AGE_MS) {
      console.log(`🖥️ [term] TTL reap id=${sess.id.slice(0, 8)} agent=${sess.agent}（存活超 ${MAX_TERM_AGE_MS / 3600_000}h）`);
      sess.destroy();
    }
  }
}

/**
 * Bridge 启动时清扫残留 viewer session（上次进程被 kill -9 / 崩溃时的孤儿），
 * 并拉起 TTL 兜底回收（每 10 分钟）。孤儿判定：tmux 里 webterm-* 但不在本进程
 * termSessions 表里的（同进程活跃 viewer 不能误杀——本函数只在启动时调，表必空）。
 * grouped session 只是 window 集的视图，kill 不伤 master 本体。
 */
export async function sweepStaleTerminalSessions(): Promise<void> {
  const { code, out } = await tmuxRun(["list-sessions", "-F", "#{session_name}"]);
  if (code === 0 && out) {
    for (const name of out.split("\n")) {
      if (name.startsWith(VIEWER_PREFIX)) {
        await tmuxRun(["kill-session", "-t", name]);
        console.log(`🖥️ [term] swept stale viewer session ${name}`);
      }
    }
  }
  setInterval(reapExpiredTerminalSessions, 10 * 60 * 1000);
}
