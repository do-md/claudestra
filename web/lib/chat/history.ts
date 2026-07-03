import fs from "fs";
import os from "os";
import path from "path";
import type { ChatMessage, ToolCallView } from "@/features/chat/type";

/**
 * 历史消息加载：读 Claude Code 会话 jsonl → ChatMessage[]。
 *
 * 落点 ~/.claude/projects/-<cwd-slug>/<sessionId>.jsonl（Bridge 侧
 * jsonl-watcher.getJsonlPath 同款规则）。这是纯只读磁盘操作，与 Bridge 在同一台机
 * 器，因此直接由 Next BFF 读盘、不经 Bridge /web/*（send/stream 才需要活跃 ws）。
 * 好处：对**已停止**的 agent 也能拉历史（Bridge 已无 clients 条目），且不动
 * Discord 关键路径 bridge.ts。
 *
 * 解析忠实复刻 src/bridge/jsonl-watcher.ts 的展示逻辑，保证「刷新前看到的」= 历史：
 *   - assistant text 块（仅当本条 assistant 记录**没有** reply 工具时才展示，
 *     与 watcher 的 `!hasReply` 门控一致）
 *   - reply 工具（mcp__<mcp>__reply）的 input.text 作为最终回复文本
 *     （watcher 用 reply handler 单独 tee，这里等价合并）
 *   - 非隐藏 tool_use → 工具卡（summary 用 webToolSummary 同款）
 *   - 按「human user 消息」切分 turn：一条 human user → 一个 user 气泡；其后所有
 *     assistant 记录（文本/工具/回复）汇入同一个 assistant 气泡，直到下一条 human user
 */

// ── jsonl 路径解析（对齐 jsonl-watcher.getJsonlPath / jsonl-cost.projectJsonlPath）──

function jsonlPath(cwd: string, sessionId: string): string {
  const slug = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/** 兜底：路径推不准时遍历 projects 子目录找 <sessionId>.jsonl。 */
function findBySessionId(sessionId: string): string | null {
  const root = path.join(os.homedir(), ".claude", "projects");
  let slugs: string[];
  try {
    slugs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const p = path.join(root, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveJsonlPath(cwd: string, sessionId: string): string | null {
  const primary = jsonlPath(cwd, sessionId);
  if (fs.existsSync(primary)) return primary;
  return findBySessionId(sessionId);
}

// ── 工具展示（对齐 jsonl-watcher）───────────────────────────────────

// Bridge 通信相关的隐藏工具（与 jsonl-watcher.HIDDEN_TOOLS 一致）
const HIDDEN_TOOLS = new Set([
  "reply",
  "react",
  "edit_message",
  "fetch_messages",
  "download_attachment",
]);

// MCP_NAME 默认 "claudestra"（对齐 src/bridge/config.ts）。channel-server 的 MCP 工具
// （含 reply）以此为前缀，对用户隐藏。
const MCP_NAME = process.env.MCP_NAME || "claudestra";
const MCP_TOOL_PREFIX = `mcp__${MCP_NAME.replace(/-/g, "_")}__`;

function isHiddenTool(name: string): boolean {
  if (HIDDEN_TOOLS.has(name)) return true;
  if (name.startsWith(MCP_TOOL_PREFIX)) return true;
  if (name.startsWith("mcp__plugin_discord_discord__")) return true;
  return false;
}

/** reply 工具（channel-server 暴露的隐藏回复工具）—— 其 input.text 是权威回复。 */
function isReplyTool(name: string): boolean {
  return name === "reply" || name.endsWith("__reply");
}

/** 工具卡的 summary（对齐 jsonl-watcher.webToolSummary）。 */
function toolSummary(name: string, input: any): string {
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return input?.file_path?.split("/").pop() || "";
    case "Bash":
      return String(input?.description || input?.command || "")
        .replace(/\n/g, " ")
        .slice(0, 120);
    case "Glob":
    case "Grep":
      return String(input?.pattern || "");
    case "Agent":
      return String(input?.description || input?.prompt || "").slice(0, 80);
    default:
      return "";
  }
}

// ── 用户消息文本抽取 ────────────────────────────────────────────

/**
 * 剥离 Bridge 的 <channel …>\n{内容}\n</channel> 包装，取回 human 实际输入。
 * 非包装文本原样返回。
 */
function stripChannelWrapper(text: string): string {
  const m = text.match(/^<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/);
  return (m ? m[1] : text).trim();
}

/**
 * 判断并抽取一条 type:"user" 记录里的 human 文本。
 * 非 human（tool_result 回灌、CC 内部 meta 标签）返回 null → 跳过。
 */
function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    // <channel> 包装 → human；strip 后取内容
    if (/^<channel\b/.test(content)) {
      const inner = stripChannelWrapper(content);
      return inner || null;
    }
    // 其它以 "<" 开头的（<command-name> / <local-command-stdout> / 系统提醒标签）当 meta 跳过
    if (content.trimStart().startsWith("<")) return null;
    const t = content.trim();
    return t || null;
  }
  if (Array.isArray(content)) {
    // 含 tool_result → 是工具回灌（属 assistant turn 的一部分），非 human
    if (content.some((b: any) => b?.type === "tool_result")) return null;
    const texts = content
      .filter((b: any) => b?.type === "text" && b.text?.trim())
      .map((b: any) => b.text.trim());
    return texts.length ? texts.join("\n") : null;
  }
  return null;
}

// ── 主解析 ─────────────────────────────────────────────────────

interface AssistantAccum {
  text: string;
  toolCalls: ToolCallView[];
  /** 本 turn 已收录的文本段，去重（reply 工具文本常被后续 text 块原样重复）。 */
  seen: Set<string>;
}

/** 追加一个文本段到 assistant turn，跳过 turn 内完全相同的重复段。 */
function pushSeg(acc: AssistantAccum, seg: string): void {
  const s = seg.trim();
  if (!s || acc.seen.has(s)) return;
  acc.seen.add(s);
  acc.text += (acc.text ? "\n" : "") + s;
}

/** 把累积的 assistant turn 落成一条 ChatMessage（若有内容）。 */
function flushAssistant(
  acc: AssistantAccum | null,
  out: ChatMessage[],
  idBase: number
): void {
  if (!acc) return;
  if (!acc.text.trim() && acc.toolCalls.length === 0) return;
  out.push({
    id: `h${idBase}`,
    role: "assistant",
    content: acc.text.trim(),
    toolCalls: acc.toolCalls.length ? acc.toolCalls : undefined,
    streamed: false,
  });
}

/**
 * 解析一个 jsonl 文件为 ChatMessage[]。找不到文件返回 []。
 */
export function loadHistoryFromJsonl(cwd: string, sessionId: string): ChatMessage[] {
  const file = resolveJsonlPath(cwd, sessionId);
  if (!file) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const out: ChatMessage[] = [];
  let idx = 0;
  let assistant: AssistantAccum | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec.type === "user") {
      const humanText = extractUserText(rec.message?.content);
      if (humanText === null) continue; // tool_result / meta → 不切 turn
      // 遇到真正的 human 消息 → 先定稿上一个 assistant turn
      flushAssistant(assistant, out, idx++);
      assistant = null;
      out.push({
        id: `h${idx++}`,
        role: "user",
        content: humanText,
        streamed: false,
      });
      continue;
    }

    if (rec.type === "assistant") {
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      if (!assistant) assistant = { text: "", toolCalls: [], seen: new Set() };

      const hasReply = content.some(
        (b: any) => b?.type === "tool_use" && isReplyTool(b.name)
      );

      for (const block of content) {
        if (block?.type === "tool_use" && block.name) {
          if (isReplyTool(block.name)) {
            const rt = block.input?.text;
            if (typeof rt === "string") pushSeg(assistant, rt);
          } else if (!isHiddenTool(block.name)) {
            assistant.toolCalls.push({
              name: block.name,
              summary: toolSummary(block.name, block.input),
              state: "done",
            });
          }
        }
        // 与 watcher 的 `!hasReply` 门控一致：本条 assistant 记录有 reply 工具时
        // 抑制其 text 块（reply.text 才是权威回复），避免重复展示。
        if (block?.type === "text" && block.text?.trim() && !hasReply) {
          pushSeg(assistant, block.text);
        }
      }
      continue;
    }

    // 其它 type（system / queue-operation / attachment / mode / …）跳过
  }

  flushAssistant(assistant, out, idx++);
  return out;
}
