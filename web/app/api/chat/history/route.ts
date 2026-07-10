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
  compactSummary?: boolean;
}

function toChatMessages(items: NeutralMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of items) {
    // compact 生成的长摘要不是真实用户输入（guide §6 建议默认折叠），v1 先不展示
    if (m.compactSummary) continue;
    if (m.role === "system") {
      // 目前只有 compact 分隔线 → 一条轻量 assistant 提示
      out.push({ id: `h${m.seq}`, role: "assistant", content: `── ${m.text || "上下文已压缩"} ──` });
      continue;
    }
    const toolCalls: ToolCallView[] | undefined = m.tools?.length
      ? m.tools.map((t) => ({ name: t.name, summary: t.summary, state: "done" as const }))
      : undefined;
    if (!m.text && !toolCalls) continue;
    out.push({
      id: `h${m.seq}`,
      role: m.role,
      content: m.text || "",
      toolCalls,
    });
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

    // 2) 最新 session 的尾部 300 条
    const page = await bridgeGet<{ ok: boolean; messages: NeutralMessage[] }>(
      `/agents/${name}/history/${encodeURIComponent(latest.sessionId)}?limit=300`,
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
