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

/** [fork] reply() 附带的交互组件（按钮/选单），点击回投 [button:id]/[select:id:v]。
 *  形状与 bridge NeutralMessage 的 components 对齐，历史里原样透传给前端渲染。 */
export type ReplyComponentRow =
  | { type: "buttons"; buttons: { id: string; label: string; style?: string; emoji?: string }[] }
  | { type: "select"; id: string; placeholder?: string; options: { label: string; value: string; description?: string }[] };

export interface HistoryMessage {
  /** jsonl 行号（0-based），分页锚点，同一文件内稳定 */
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: HistoryToolCall[];
  /** [fork] reply() 工具的正文——发给用户的「最终回复」，与过程叙述 text 分开渲染 */
  replyText?: string;
  /** [fork] reply() 附带的按钮/选单——历史里也渲染（否则用户不在直播那刻就看不到按钮） */
  replyComponents?: ReplyComponentRow[];
  /** compact 产生的摘要条目（不是真实用户输入） */
  compactSummary?: boolean;
  model?: string;
  /** [fork] 入站消息的发送者标签（<channel> 的 user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
}

/** [fork] MCP reply 工具名：mcp__<MCP_NAME>__reply（MCP_NAME 可配，按前后缀匹配）。 */
function isReplyTool(name: string): boolean {
  return name.startsWith("mcp__") && name.endsWith("__reply");
}

/** jsonl 里的 components 不可信——只放行结构完整的按钮行/选单行，其余丢弃。 */
function sanitizeComponents(raw: unknown): ReplyComponentRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyComponentRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.type === "buttons" && Array.isArray(r.buttons)) {
      const buttons = r.buttons
        .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
        .filter((b) => typeof b.id === "string" && typeof b.label === "string")
        .map((b) => ({
          id: b.id as string,
          label: b.label as string,
          ...(typeof b.style === "string" ? { style: b.style } : {}),
          ...(typeof b.emoji === "string" ? { emoji: b.emoji } : {}),
        }));
      if (buttons.length) out.push({ type: "buttons", buttons });
    } else if (r.type === "select" && typeof r.id === "string" && Array.isArray(r.options)) {
      const options = r.options
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .filter((o) => typeof o.label === "string" && typeof o.value === "string")
        .map((o) => ({
          label: o.label as string,
          value: o.value as string,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        }));
      if (options.length) {
        out.push({
          type: "select",
          id: r.id,
          ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
          options,
        });
      }
    }
  }
  return out;
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

// [fork] channel 送达的入站消息在 CC jsonl 里落成 isMeta:true + "<channel …>…</channel>"
// 包装的 user 记录（CC channel 协议原生格式）。这是真实对话输入（web/API 用户、
// Discord 用户、agent↔agent），不解包的话历史 API 里看不到任何用户消息，web 端
// 回合结构也随之丢失（连续 assistant 记录跨回合粘连成巨型气泡）。
const CHANNEL_WRAP_RE = /^\s*<channel\s+([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/channel>\s*$/;

/**
 * [fork] 剥掉 bridge renderContentForLocal 注入的 framing header：正文开头的
 * [🌐 …] / [🤖 …] 方括号块是给 agent 的路由/行为指示，不是用户输入。header 内可能
 * 出现 "]"（如 [DIRECT] 标记），所以用 "]\n\n" 或行尾 "]" + 空行做块边界，而不是
 * 第一个 "]"。没匹配到已知 emoji 开头就原样保留（不误伤以 [ 开头的真实输入）。
 */
function stripChannelHeader(body: string): string {
  if (!/^\[(🌐|🤖|📢|📣)/.test(body)) return body;
  // header 块与正文用空行分隔——兼容 LF 与 CRLF（L7：CRLF jsonl 下 "]\n\n" 匹配不到
  // 会把 framing 头留在正文）。仍要求"]"+空行做边界，不用单个换行（正文里可能出现
  // "]\n"，会误切）。
  const m = body.match(/]\r?\n\r?\n/);
  if (!m || m.index === undefined) return body;
  return body.slice(m.index + m[0].length).trim();
}

/**
 * [fork] 解包一条 <channel> 入站消息：返回 { text, from }；不是 channel 包装
 * （caveat / local-command 等真 meta）返回 null。
 */
export function unwrapChannelMessage(raw: string): { text: string; from?: string } | null {
  const m = raw.match(CHANNEL_WRAP_RE);
  if (!m) return null;
  const from = /(?:^|\s)user="([^"]*)"/.exec(m[1])?.[1] || undefined;
  const text = stripChannelHeader(m[2].trim()).trim();
  if (!text) return null;
  return { text, from };
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
      const c = rec.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n")
            : "";
      if (rec.isMeta === true) {
        // [fork] isMeta + <channel> 包装 = channel 送达的真实入站消息，解包进历史；
        // 其余 isMeta（caveat / local-command 输出等）照旧过滤
        const un = unwrapChannelMessage(text);
        if (!un) continue;
        const msg: HistoryMessage = { seq: i, ts, role: "user", text: un.text };
        if (un.from) msg.from = un.from;
        all.push(msg);
        continue;
      }
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
      const replyTexts: string[] = [];
      const replyComponents: ReplyComponentRow[] = [];
      const tools: HistoryToolCall[] = [];
      for (const b of content) {
        if (b?.type === "text" && b.text?.trim()) texts.push(b.text);
        else if (b?.type === "tool_use" && b.name) {
          // [fork] reply() 的正文是「发给用户的消息」，不是工具动作——提取成文本，别当
          // 工具卡（否则 formatTool 只剩「🔧 <server>/reply」，回复内容在历史里蒸发，
          // 直播能看到、进历史就没了）。这样历史与直播都渲染同一份 reply。
          if (isReplyTool(b.name) && typeof b.input?.text === "string" && b.input.text.trim()) {
            replyTexts.push(b.input.text);
            // reply 附带的按钮/选单也进历史（否则用户不在直播那刻就看不到按钮）
            replyComponents.push(...sanitizeComponents(b.input?.components));
          } else {
            tools.push({ name: b.name, summary: fmt(b.name, b.input) });
          }
        }
      }
      if (!texts.length && !replyTexts.length && !tools.length) continue;
      const msg: HistoryMessage = { seq: i, ts, role: "assistant", text: texts.join("\n") };
      if (replyTexts.length) msg.replyText = replyTexts.join("\n");
      if (replyComponents.length) msg.replyComponents = replyComponents;
      if (tools.length) msg.tools = tools;
      if (typeof rec.message?.model === "string") msg.model = rec.message.model;
      all.push(msg);
    }
  }

  const eligible = opts.before != null ? all.filter((m) => m.seq < opts.before!) : all;
  const messages = eligible.slice(-limit);
  return { messages, total: all.length, hasMore: eligible.length > messages.length };
}
