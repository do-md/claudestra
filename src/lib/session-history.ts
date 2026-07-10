/**
 * v2.9+ 会话历史解析 —— 只读历史 API 的核心（存储设计 2026-07-10 owner 拍板：
 * 文件为权威源，不入库，历史走只读 API 现场解析 jsonl）。
 *
 * 数据源两处，目录布局刻意同构（session-archive.ts 落盘时保持镜像）：
 *   - live:    ~/.claude/projects/<slug>/<sessionId>.jsonl（+ <sessionId>/subagents/）
 *   - archive: ~/.claude-orchestrator/archive/<agent>/<sessionId>.jsonl（+ 同名目录 subagents/）
 * 因此「主 jsonl 路径去掉 .jsonl + /subagents/」对两边都成立。
 *
 * 性能权衡（v1）：readSessionHistory 每次全量逐行解析。几十 MB 的 jsonl 在 Bun
 * 下是百毫秒级，API 侧有 30 req/min 限流兜底；等 web UI 出现高频翻页需求再上
 * byte-offset 索引，不提前优化。
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { projectJsonlPath } from "./jsonl-cost.js";
import { ARCHIVE_ROOT } from "./session-archive.js";

export interface HistoryToolCall {
  name: string;
  summary: string;
}

export interface HistoryMessage {
  /** jsonl 行号（0-based），分页锚点，同一文件内稳定 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: HistoryToolCall[];
  /** compact 产生的摘要条目（不是真实用户输入） */
  compactSummary?: boolean;
  model?: string;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  /** 文件内可显示消息总数（不含被过滤的 meta/tool_result 载荷） */
  total: number;
  /** messages[0].seq 之前还有更早的消息（用 before=该 seq 翻上一页） */
  hasMore: boolean;
}

export interface SessionSummary {
  sessionId: string;
  /** 读取来源：live = CC projects 原文件（更全时优先），archive = 退役快照 */
  source: "live" | "archive";
  /** 服务器本地绝对路径 —— API 响应里不要外泄，仅供内部继续读文件 */
  path: string;
  sizeBytes: number;
  mtime: string;
  createdAt: string | null;
  subagents: string[];
}

// sessionId / subagent 参数会拼进文件路径，白名单校验防穿越
const SESSION_ID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
const SUBAGENT_RE = /^agent-[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(s: string): boolean {
  return SESSION_ID_RE.test(s);
}

export function isValidSubagentId(s: string): boolean {
  return SUBAGENT_RE.test(s);
}

/** 主 jsonl 旁的 subagent 会话 id 列表（live / archive 布局同构，统一适用） */
export function listSubagentFiles(mainJsonlPath: string): string[] {
  const dir = join(mainJsonlPath.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function summarize(sessionId: string, source: "live" | "archive", path: string): SessionSummary | null {
  try {
    const st = statSync(path);
    const birth = st.birthtime?.getTime?.() ? st.birthtime.toISOString() : null;
    return {
      sessionId,
      source,
      path,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
      createdAt: birth,
      subagents: listSubagentFiles(path),
    };
  } catch {
    return null;
  }
}

/**
 * 一个 agent 的全部可读 session：归档目录打底 + live 覆盖。
 *
 * live 覆盖两种情况：当前活 session（registry sessionId），以及归档过但 CC 侧
 * 源文件还在且不小于归档（copy-if-larger 语义 → 更大 = 更全）。刻意不扫
 * projects/<slug>/ 下的其他 jsonl —— 同 cwd 可能有用户手动开的无关会话，
 * agent 的 session 清单以「归档目录 + registry 当前值」为权威边界。
 */
export async function listAgentSessions(
  agentName: string,
  opts: {
    cwd?: string;
    currentSessionId?: string;
    archiveRoot?: string;
    /** 测试注入：live 路径推导，默认 projectJsonlPath */
    livePathFor?: (cwd: string, sessionId: string) => string;
  } = {},
): Promise<SessionSummary[]> {
  const livePathFor = opts.livePathFor ?? projectJsonlPath;
  const byId = new Map<string, SessionSummary>();

  const archiveDir = join(opts.archiveRoot ?? ARCHIVE_ROOT, agentName);
  if (existsSync(archiveDir)) {
    try {
      for (const f of readdirSync(archiveDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const sid = f.replace(/\.jsonl$/, "");
        const s = summarize(sid, "archive", join(archiveDir, f));
        if (s) byId.set(sid, s);
      }
    } catch { /* best-effort */ }
  }

  if (opts.cwd) {
    const candidates = new Set(byId.keys());
    if (opts.currentSessionId) candidates.add(opts.currentSessionId);
    for (const sid of candidates) {
      const lp = livePathFor(opts.cwd, sid);
      if (!existsSync(lp)) continue;
      const live = summarize(sid, "live", lp);
      if (!live) continue;
      const prev = byId.get(sid);
      if (!prev || live.sizeBytes >= prev.sizeBytes) byId.set(sid, live);
    }
  }

  return [...byId.values()].sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * 解析一个会话 jsonl 为中性消息页（transport / 前端无关）。
 *
 * 过滤规则：isMeta 条目、纯 tool_result 载荷的 user 条目、空 assistant 条目
 * 不进历史；compact_boundary 渲染成一条 system 分隔线；isCompactSummary 的
 * user 条目保留全文并打标（web UI 可折叠展示）。
 *
 * 分页语义（聊天视图习惯）：默认返回最尾部 limit 条；传 before=<seq> 拿更早
 * 的一页；hasMore 指「本页之前还有没有」。
 */
export async function readSessionHistory(
  filePath: string,
  opts: {
    limit?: number;
    before?: number;
    /** tool_use 摘要渲染器（bridge 传 jsonl-watcher 的 formatTool），默认只回工具名 */
    formatToolFn?: (name: string, input: any) => string;
  } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const fmt = opts.formatToolFn ?? ((name: string) => name);
  const raw = await Bun.file(filePath).text();
  const lines = raw.split("\n");
  const all: HistoryMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      all.push({ seq: i, ts, role: "system", text: "── 上下文已压缩（compact）──" });
      continue;
    }

    if (rec.type === "user") {
      if (rec.isMeta === true) continue;
      const c = rec.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n")
            : "";
      if (!text.trim()) continue; // 纯 tool_result 载荷
      const msg: HistoryMessage = { seq: i, ts, role: "user", text };
      if (rec.isCompactSummary === true) msg.compactSummary = true;
      all.push(msg);
      continue;
    }

    if (rec.type === "assistant") {
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      const tools: HistoryToolCall[] = [];
      for (const b of content) {
        if (b?.type === "text" && b.text?.trim()) texts.push(b.text);
        else if (b?.type === "tool_use" && b.name) tools.push({ name: b.name, summary: fmt(b.name, b.input) });
      }
      if (!texts.length && !tools.length) continue;
      const msg: HistoryMessage = { seq: i, ts, role: "assistant", text: texts.join("\n") };
      if (tools.length) msg.tools = tools;
      if (typeof rec.message?.model === "string") msg.model = rec.message.model;
      all.push(msg);
    }
  }

  const eligible = opts.before != null ? all.filter((m) => m.seq < opts.before!) : all;
  const messages = eligible.slice(-limit);
  return { messages, total: all.length, hasMore: eligible.length > messages.length };
}
