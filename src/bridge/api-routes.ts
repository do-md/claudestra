/**
 * v2.9.2+ /api/v1 HTTP 路由 —— 从 bridge.ts 拆出的独立模块（多前端架构 §5）。
 *
 * 职责：Bearer 鉴权 + 限流、全部 /api/v1/* 端点分发、API 会话状态
 * （pending 请求 / 轮询结果 / 附件登记 / 限流器）。这些状态的 owner 是本模块，
 * bridge.ts 的 deliverToApi（出站回路）import 这里的 Map 读写。
 *
 * 与 bridge.ts 的耦合走 initApiRoutes(deps) 注入：clients（ws 会话表）、
 * deliver（统一投递）、镜像 / typing / 完成通知抑制、SSE 处理器。
 * 其余依赖（manager 调用、principals、session-history……）都是无状态模块，直接 import。
 */

import { existsSync } from "fs";
import { TMP_DIR } from "./config.js";
import {
  readPrincipals,
  findByBearer,
  agentInScope,
  tokenIdOf,
  SlidingWindowLimiter,
  type Principal,
} from "../lib/principals.js";
import { runManager } from "./management.js";
import { collectSessions } from "./sessions-inventory.js";
import { cleanupBgJob } from "../lib/bg-jobs.js";
import { emitEvent, type EventFilter } from "./event-bus.js";
import { listAgentSessions, readSessionHistory, isValidSessionId, isValidSubagentId } from "../lib/session-history.js";
import { formatTool } from "./jsonl-watcher.js";
import { newThreadId, type Envelope, type ApiUserEndpoint } from "./router.js";

// ── API 会话状态（v2.6.0+，原 bridge.ts Phase B 区块） ──────────────────

/**
 * 一次 POST /api/v1/agents/:name/messages 的追踪。key = `${tokenId}|${agentChannelId}`
 * （同 token 对同 agent 的并发请求按 FIFO 队列 resolve）。
 * agent 的 reply(chat_id="api:<tokenId>") 进 deliverToApi 时按 key 出队：
 * resolve 同步 waiter + emit chat_message(out)（带原请求 threadId）+ 存结果供轮询。
 */
export interface PendingApiRequest {
  tokenId: string;
  tokenName: string;
  agentChannelId: string;
  agentName: string;
  threadId: string;
  ts: number;
  /** wait 模式挂的 resolver（无 wait 则为空） */
  resolve?: (result: ApiReplyResult) => void;
}

export interface ApiReplyResult {
  reply: string | null;
  components?: unknown[];
  files?: { name: string; url: string }[];
  threadId: string;
  agent: string;
  /** true = agent 没调 reply()，文本来自 Stop-hook drain 兜底（R3） */
  viaFallback?: boolean;
}

export const pendingApiRequests = new Map<string, PendingApiRequest[]>();
/** threadId → 已完成结果（轮询兜底用，TTL 清理见 sweepApiState） */
export const apiThreadResults = new Map<string, { result: ApiReplyResult; ts: number }>();
/** 出站附件登记：opaqueId → 本地路径 + 属主 token（防任意文件读取） */
export const apiFiles = new Map<string, { path: string; tokenId: string; name: string }>();
/** per-token 限流器（30 req/min，内存态） */
const apiLimiters = new Map<string, SlidingWindowLimiter>();
const API_REQUEST_TTL_MS = 10 * 60_000;

export function apiReqKey(tokenId: string, agentChannelId: string): string {
  return `${tokenId}|${agentChannelId}`;
}

/** API 会话状态 TTL 清理（bridge 的 staleCleanup 周期里调用） */
export function sweepApiState(now = Date.now()): void {
  for (const [key, queue] of pendingApiRequests.entries()) {
    const fresh = queue.filter((p) => now - p.ts <= API_REQUEST_TTL_MS);
    if (fresh.length === 0) pendingApiRequests.delete(key);
    else if (fresh.length !== queue.length) pendingApiRequests.set(key, fresh);
  }
  for (const [tid, hit] of apiThreadResults.entries()) {
    if (now - hit.ts > API_REQUEST_TTL_MS) apiThreadResults.delete(tid);
  }
  if (apiFiles.size > 200) {
    // 附件登记只按容量截断（文件本身在 TMP_DIR，系统自己清）
    const excess = apiFiles.size - 200;
    let i = 0;
    for (const k of apiFiles.keys()) {
      if (i++ >= excess) break;
      apiFiles.delete(k);
    }
  }
}

// ── bridge.ts 运行时依赖（initApiRoutes 注入） ──────────────────────────

export interface ApiDeps {
  /** channelId → channel-server ws 会话（在线判定 + Envelope 投递目标） */
  clients: Map<string, { ws: unknown; cwd?: string }>;
  deliver: (env: Envelope) => Promise<{ envelope: Envelope; outcome: { kind: string; [k: string]: unknown } }>;
  mirrorApiExchange: (to: ApiUserEndpoint, agentChannelId: string, text: string) => Promise<void>;
  startTypingWithSafety: (channelId: string) => void;
  /** 完成通知抑制：API 触发的 turn 不 @ owner */
  lastMessageSource: Map<string, string>;
  handleEventsRequest: (req: Request, extraFilter?: EventFilter) => Response;
}

let deps: ApiDeps | null = null;

export function initApiRoutes(d: ApiDeps): void {
  deps = d;
}

// ── 鉴权 + 通用 helper ──────────────────────────────────────────────────

function apiJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Bearer 鉴权 + 限流。失败直接返回 Response，成功返回 principal。
 * v2.10+ 也接受 ?token=<secret>（header 优先）：浏览器 EventSource 不能带
 * Authorization header，SSE 场景的标准折衷。secret 进 URL 的暴露面由「bridge
 * 默认只绑回环 + 对外自备反代/TLS」的既有边界兜住；非 SSE 调用仍应走 header。
 */
async function authApi(req: Request, url: URL): Promise<Principal | Response> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const secret = m?.[1]?.trim() || url.searchParams.get("token") || "";
  if (!secret) return apiJson(401, { ok: false, error: "missing Authorization: Bearer <secret> (SSE may use ?token=)" });
  const file = await readPrincipals();
  const p = findByBearer(file, secret);
  if (!p) return apiJson(401, { ok: false, error: "invalid or revoked token" });
  const tid = tokenIdOf(p);
  let limiter = apiLimiters.get(tid);
  if (!limiter) {
    limiter = new SlidingWindowLimiter();
    apiLimiters.set(tid, limiter);
  }
  if (!limiter.tryAcquire()) return apiJson(429, { ok: false, error: "rate limit exceeded (30 req/min)" });
  return p;
}

/** registry 名双向兼容（"worker" ↔ "agent-worker"），返回 manager list 里的条目 */
async function findApiAgent(name: string): Promise<{ name: string; channelId: string; idle?: boolean; status?: string; purpose?: string; cwd?: string; sessionId?: string } | null> {
  try {
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    return agents.find((a) => a.name === name || a.name === `agent-${name}` || `agent-${a.name}` === name) ?? null;
  } catch {
    return null;
  }
}

// ── 路由分发 ────────────────────────────────────────────────────────────

export async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  if (!deps) return apiJson(503, { ok: false, error: "api routes not initialized" });
  const auth = await authApi(req, url);
  if (auth instanceof Response) return auth;
  const principal = auth;
  const tokenId = tokenIdOf(principal);
  const path = url.pathname.slice("/api/v1".length);

  // GET /api/v1/agents —— scope 内的 agent 快照
  if (path === "/agents" && req.method === "GET") {
    try {
      const listResult = await runManager("list");
      const agents = ((listResult.agents || []) as any[])
        .filter((a) => agentInScope(principal, a.name))
        .map((a) => ({ name: a.name, status: a.status, idle: a.idle, purpose: a.purpose }));
      return apiJson(200, { ok: true, agents });
    } catch (e) {
      return apiJson(500, { ok: false, error: (e as Error).message });
    }
  }

  // v2.7+ GET /api/v1/sessions —— 全机器 Claude 会话清单（agents 模式适配，
  // 中性 NeutralSessionInfo；Discord 面板与 web 前端共用同一数据源）。
  // scope 规则：全权 token（"*"）看全部（含野生会话）；受限 token 只看 scope
  // 内 agent 的正式会话及其分身。
  if (path === "/sessions" && req.method === "GET") {
    const list = await collectSessions();
    if (list === null) return apiJson(503, { ok: false, error: "claude agents --json unavailable" });
    const full = principal.agents.includes("*");
    const visible = full
      ? list
      : list.filter((s) => {
          const owner = s.registeredAgent ?? s.doppelgangerOf;
          return owner ? agentInScope(principal, owner) : false;
        });
    return apiJson(200, { ok: true, sessions: visible });
  }

  // v2.7+ POST /api/v1/sessions/:bgId/cleanup —— 清理 bg job（死分身/残留）。
  // 耗时操作（kill → 等 daemon 静默 → 隔离目录，最长 ~90s）→ 202 后台执行，
  // 结果以 session_anomaly kind=cleanup_result 进事件流。仅全权 token。
  const cleanupMatch = path.match(/^\/sessions\/([^/]+)\/cleanup$/);
  if (cleanupMatch && req.method === "POST") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "cleanup requires a full-scope token" });
    }
    const bgId = decodeURIComponent(cleanupMatch[1]);
    const list = await collectSessions();
    const target = list?.find((s) => s.bgId === bgId && s.kind === "background");
    if (!target) return apiJson(404, { ok: false, error: `bg session "${bgId}" not found` });
    cleanupBgJob(bgId, { pid: target.pid })
      .then((r) => {
        emitEvent({
          agent: target.doppelgangerOf ?? target.name ?? bgId,
          chatId: "",
          type: "session_anomaly",
          data: { kind: "cleanup_result", bgId, ...r },
        });
      })
      .catch(() => {});
    return apiJson(202, {
      ok: true,
      accepted: true,
      hint: "cleanup runs in background; watch /api/v1/events for session_anomaly kind=cleanup_result",
    });
  }

  // v2.7+ POST /api/v1/sessions/:sessionId/adopt —— 收编：把该 session 立为
  // 某正式 agent 的会话并重启拉起（body: {"agent": "<name>"}）。仅全权 token。
  const adoptMatch = path.match(/^\/sessions\/([^/]+)\/adopt$/);
  if (adoptMatch && req.method === "POST") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "adopt requires a full-scope token" });
    }
    const sid = decodeURIComponent(adoptMatch[1]);
    let agentName = "";
    try {
      agentName = String(((await req.json()) as any)?.agent || "");
    } catch {
      /* fallthrough → 400 */
    }
    if (!agentName) return apiJson(400, { ok: false, error: 'body must be {"agent": "<name>"}' });
    runManager("adopt", agentName, sid)
      .then((r) => {
        emitEvent({
          agent: agentName,
          chatId: "",
          type: "session_anomaly",
          data: { kind: "adopt_result", sessionId: sid, ok: !!r?.ok, ...r },
        });
      })
      .catch(() => {});
    return apiJson(202, {
      ok: true,
      accepted: true,
      hint: "adoption runs in background (~1-2 min); watch /api/v1/events for session_anomaly kind=adopt_result",
    });
  }

  // GET /api/v1/events —— token 版 SSE（scope 过滤）
  if (path === "/events" && req.method === "GET") {
    let scopeAgents: string[] | undefined;
    if (!principal.agents.includes("*")) {
      // 双向兼容前缀：scope 里存裸名时补 agent- 前缀的变体
      scopeAgents = principal.agents.flatMap((a) => [a, `agent-${a}`]);
    }
    return deps.handleEventsRequest(req, scopeAgents ? { agents: scopeAgents } : undefined);
  }

  // GET /api/v1/threads/:threadId —— wait 超时后的轮询兜底
  const threadMatch = path.match(/^\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    const hit = apiThreadResults.get(threadMatch[1]);
    if (!hit) return apiJson(404, { ok: false, error: "thread not found (not answered yet, or expired)" });
    return apiJson(200, { ok: true, ...hit.result });
  }

  // GET /api/v1/files/:id —— 出站附件下载（校验属主 token）
  const fileMatch = path.match(/^\/files\/([^/]+)$/);
  if (fileMatch && req.method === "GET") {
    const entry = apiFiles.get(fileMatch[1]);
    if (!entry || entry.tokenId !== tokenId) return apiJson(404, { ok: false, error: "file not found" });
    const f = Bun.file(entry.path);
    if (!(await f.exists())) return apiJson(410, { ok: false, error: "file no longer on disk" });
    return new Response(f, {
      headers: { "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.name)}"` },
    });
  }

  // v2.9+ GET /api/v1/agents/:name/history —— session 清单（live + 归档快照）。
  // agent 已被 kill 时归档仍可读（这正是归档存在的意义），所以 registry 查不到
  // 不算 404，降级为只列归档。响应不含服务器路径（path 字段剥掉）。
  const histListMatch = path.match(/^\/agents\/([^/]+)\/history$/);
  if (histListMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(histListMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    const sessions = await listAgentSessions(canonical, {
      cwd: agent?.cwd,
      currentSessionId: agent?.sessionId,
    });
    if (!agent && !sessions.length) {
      return apiJson(404, { ok: false, error: `agent "${agentParam}" not found (no registry entry, no archives)` });
    }
    return apiJson(200, {
      ok: true,
      agent: canonical,
      sessions: sessions.map(({ path: _p, ...rest }) => rest),
    });
  }

  // v2.9+ GET /api/v1/agents/:name/history/:sessionId —— 消息分页
  //   ?limit=100（1..500）&before=<seq 往前翻页>&subagent=agent-xxx（读 subagent 会话）
  const histSessMatch = path.match(/^\/agents\/([^/]+)\/history\/([^/]+)$/);
  if (histSessMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(histSessMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const sid = decodeURIComponent(histSessMatch[2]);
    if (!isValidSessionId(sid)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    const agent = await findApiAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    const sessions = await listAgentSessions(canonical, {
      cwd: agent?.cwd,
      currentSessionId: agent?.sessionId,
    });
    const found = sessions.find((s) => s.sessionId === sid);
    if (!found) return apiJson(404, { ok: false, error: `session "${sid}" not found for agent "${canonical}"` });

    let file = found.path;
    const subagent = url.searchParams.get("subagent");
    if (subagent) {
      if (!isValidSubagentId(subagent)) return apiJson(400, { ok: false, error: "invalid subagent id" });
      file = `${found.path.replace(/\.jsonl$/, "")}/subagents/${subagent}.jsonl`;
      if (!existsSync(file)) return apiJson(404, { ok: false, error: `subagent "${subagent}" not found in session` });
    }
    const limitRaw = Number(url.searchParams.get("limit") || 100);
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw != null ? Number(beforeRaw) : undefined;
    try {
      const page = await readSessionHistory(file, {
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        before: before != null && Number.isFinite(before) ? before : undefined,
        formatToolFn: formatTool,
      });
      return apiJson(200, {
        ok: true,
        agent: canonical,
        sessionId: sid,
        source: found.source,
        ...(subagent ? { subagent } : {}),
        ...page,
      });
    } catch (e) {
      return apiJson(500, { ok: false, error: (e as Error).message });
    }
  }

  // POST /api/v1/agents/:name/messages —— 给 agent 发消息（同步 wait / 202+轮询）
  const msgMatch = path.match(/^\/agents\/([^/]+)\/messages$/);
  if (msgMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(msgMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const client = deps.clients.get(agent.channelId);
    if (!client) return apiJson(409, { ok: false, error: `agent "${agent.name}" is offline (no active session)` });

    // body：JSON {text, wait} 或 multipart（text 字段 + files，R5 入站附件）
    let text = "";
    let waitSec = 0;
    const attachments: string[] = [];
    const contentType = req.headers.get("Content-Type") || "";
    try {
      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        text = String(form.get("text") || "");
        waitSec = Number(form.get("wait") || 0);
        const inboxDir = `${TMP_DIR}/inbox`;
        await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
        const files = form.getAll("files").filter((f): f is File => f instanceof File).slice(0, 5);
        for (const f of files) {
          if (f.size > 10 * 1024 * 1024) return apiJson(413, { ok: false, error: `file "${f.name}" exceeds 10MB` });
          const dest = `${inboxDir}/api_${Date.now()}_${f.name.replace(/[^\w.\-]/g, "_")}`;
          await Bun.write(dest, f);
          attachments.push(dest);
        }
      } else {
        const body = (await req.json()) as { text?: string; wait?: number };
        text = String(body.text || "");
        waitSec = Number(body.wait || 0);
      }
    } catch {
      return apiJson(400, { ok: false, error: "invalid body (JSON {text, wait?} or multipart with text/files)" });
    }
    if (!text.trim() && attachments.length === 0) {
      return apiJson(400, { ok: false, error: "text is required" });
    }
    waitSec = Math.min(Math.max(waitSec, 0), 300);

    const tokenName = principal.name || tokenId;
    const threadId = newThreadId();
    const env: Envelope = {
      from: { kind: "api", tokenId, name: tokenName },
      to: { kind: "local", agentName: agent.name, channelId: agent.channelId, ws: client.ws as any, cwd: client.cwd },
      intent: "request",
      content: text,
      meta: {
        messageId: `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        triggerKind: "system",
        ts: new Date().toISOString(),
        threadId,
        attachments: attachments.length ? attachments : undefined,
        // API 请求不需要 inter-agent watchdog（有自己的 wait/轮询语义）
        skipInterAgentWatchdog: true,
      },
    };

    // 挂 pending（无论是否 wait —— deliverToApi 靠它关联 threadId / R3 兜底靠它找 waiter）
    const key = apiReqKey(tokenId, agent.channelId);
    const entry: PendingApiRequest = {
      tokenId,
      tokenName,
      agentChannelId: agent.channelId,
      agentName: agent.name,
      threadId,
      ts: Date.now(),
    };
    const queue = pendingApiRequests.get(key) || [];
    queue.push(entry);
    pendingApiRequests.set(key, queue);

    const delivery = await deps.deliver(env);
    if (delivery.outcome.kind !== "sent") {
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      const reason = delivery.outcome.kind === "dropped" ? (delivery.outcome as any).reason : (delivery.outcome as any).error?.message;
      return apiJson(502, { ok: false, error: `delivery failed: ${reason || "unknown"}` });
    }

    // R2 入站镜像
    deps.mirrorApiExchange({ kind: "api", tokenId, name: tokenName }, agent.channelId, `[🌐 API←${tokenName}] ${text}`).catch(() => {});
    deps.startTypingWithSafety(agent.channelId);
    // API 触发的 turn 不发 Stop 完成通知 @ owner（回复走 API 回路 + R2 镜像已可见）
    deps.lastMessageSource.set(agent.channelId, "agent");

    if (waitSec === 0) {
      return apiJson(202, { ok: true, accepted: true, threadId, agent: agent.name, hint: `poll GET /api/v1/threads/${threadId} or subscribe /api/v1/events` });
    }

    const result = await new Promise<ApiReplyResult | null>((resolve) => {
      entry.resolve = resolve;
      setTimeout(() => resolve(null), waitSec * 1000);
    });
    if (!result) {
      entry.resolve = undefined; // 超时后 deliverToApi/R3 仍会把结果写进 apiThreadResults
      return apiJson(202, { ok: true, accepted: true, timedOut: true, threadId, agent: agent.name, hint: `poll GET /api/v1/threads/${threadId}` });
    }
    return apiJson(200, { ok: true, ...result });
  }

  return apiJson(404, { ok: false, error: "unknown endpoint" });
}
