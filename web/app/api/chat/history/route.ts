export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import type { ChatMessage, ToolCallView } from "@/features/chat/type";

/**
 * 某 agent 的历史消息（打开会话时先拉，刷新不丢）。
 *
 * 2026-07-10 迁移：BFF 直读 jsonl（旧 lib/chat/history.ts）→ Bridge 只读历史
 * API（v2.9+，live+归档合并、对已 kill 的 agent 也有效、解析与 jsonl-watcher
 * 同源）。取 mtime 最新的 session 的最后 300 条。
 */

interface NeutralMessage {
  seq: number;
  ts?: string;
  role: "user" | "assistant" | "system";
  text?: string;
  tools?: { name: string; summary: string }[];
  /** [fork] reply() 的最终回复正文（后端从 jsonl 的 reply tool_use 提取） */
  replyText?: string;
  compactSummary?: boolean;
  /** 入站消息发送者标签（<channel> user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
}

/** 本前端自己的 token 名（manager token-add web-ui）——自己发的消息不用再标来源。 */
const SELF_FROM = new Set(["web-ui"]);

/**
 * 把中性消息映射成 ChatMessage，并**合并同一回合的连续 assistant 记录**。
 *
 * CC 的 jsonl 里，一个 assistant 回合会被拆成很多条记录——每个 tool_use 单独一条、
 * 每段 text 单独一条。若 1:1 映射成气泡，刷新后一个回合会碎成几十个小气泡
 * （"稀碎"）。实时链路不碎，是因为 ensureLiveAssistant 把整回合的 text/工具都并进
 * 同一个气泡。这里让历史对齐实时：连续的 assistant 记录累积进一个气泡（text 用
 * 空行拼接、工具按序收集），遇到 user / system 分隔线 / compact 边界就断开分组。
 */
function toChatMessages(items: NeutralMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let group: ChatMessage | null = null; // 当前正在累积的 assistant 回合气泡

  for (const m of items) {
    // compact 生成的长摘要不是真实用户输入（guide §6 建议默认折叠），v1 先不展示
    if (m.compactSummary) continue;

    if (m.role === "system") {
      // 目前只有 compact 分隔线 → 一条轻量 assistant 提示（独立气泡，不并组）
      group = null;
      out.push({ id: `h${m.seq}`, role: "assistant", content: `── ${m.text || "上下文已压缩"} ──`, ts: m.ts });
      continue;
    }

    const toolCalls: ToolCallView[] | undefined = m.tools?.length
      ? m.tools.map((t) => ({ name: t.name, summary: t.summary, state: "done" as const }))
      : undefined;
    if (!m.text && !toolCalls && !m.replyText) continue;

    if (m.role === "user") {
      group = null; // 用户消息断开 assistant 分组
      // CC 写入的中断标记不是用户打的字 → 渲染成轻分隔线
      if (/^\[Request interrupted/.test(m.text || "")) {
        out.push({ id: `h${m.seq}`, role: "assistant", content: "── 已被用户中断 ──", ts: m.ts });
        continue;
      }
      // TUI 斜杠命令记录（如 clear 后新会话首条 <command-name>/clear</command-name>）
      // 不是用户打的字 → 渲染成轻分隔线
      const cmdMatch = (m.text || "").match(/^<command-name>(\/[\w-]+)<\/command-name>/);
      if (cmdMatch) {
        out.push({ id: `h${m.seq}`, role: "assistant", content: `── ${cmdMatch[1]} ──`, ts: m.ts });
        continue;
      }
      const from = m.from && !SELF_FROM.has(m.from) ? m.from : undefined;
      out.push({ id: `h${m.seq}`, role: "user", content: m.text || "", ts: m.ts, from });
      continue;
    }

    // assistant：累积进当前回合气泡（首条建组并入 out，后续 mutate 同一引用）
    if (!group) {
      group = { id: `h${m.seq}`, role: "assistant", content: m.text || "", toolCalls, ts: m.ts };
      if (m.replyText) group.replyText = m.replyText;
      out.push(group);
    } else {
      if (m.text) group.content = group.content ? `${group.content}\n\n${m.text}` : m.text;
      if (toolCalls) group.toolCalls = [...(group.toolCalls ?? []), ...toolCalls];
      if (m.replyText) group.replyText = group.replyText ? `${group.replyText}\n${m.replyText}` : m.replyText;
    }
  }
  return out;
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) {
    return NextResponse.json({ error: "missing agent" }, { status: 400 });
  }
  const name = encodeURIComponent(apiAgentName(agent));

  try {
    // 1) session 清单（mtime 降序，[0] = 最新）
    const list = await bridgeGet<{
      ok: boolean;
      sessions: { sessionId: string; source: string }[];
    }>(`/agents/${name}/history`, { timeoutMs: 8000 });
    const latest = list.sessions?.[0];
    if (!latest) return NextResponse.json({ data: [] });

    // 2) 最新 session 的尾部 N 条（合并同回合后约为 N/每回合条数 个气泡）
    const page = await bridgeGet<{ ok: boolean; messages: NeutralMessage[] }>(
      `/agents/${name}/history/${encodeURIComponent(latest.sessionId)}?limit=500`,
      { timeoutMs: 10_000 }
    );
    return NextResponse.json({ data: toChatMessages(page.messages || []) });
  } catch (e) {
    const msg = (e as Error).message;
    // agent 尚无历史（新建）不是错误
    if (/not found/i.test(msg)) return NextResponse.json({ data: [] });
    return NextResponse.json({ error: `读取历史失败: ${msg}` }, { status: 502 });
  }
}
