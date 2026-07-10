export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 把用户消息投给指定 agent（fire-and-forget，wait=0）。
 * 代理 Bridge POST /api/v1/agents/:name/messages；输出经 /api/chat/stream 的
 * SSE（/api/v1/events 翻译）回来。agent 离线时 Bridge 返 409。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, text } = await request.json().catch(() => ({}));
  if (!agent || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "agent 和 text 不能为空" }, { status: 400 });
  }

  try {
    await bridgePost(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/messages`,
      { text: text.trim(), wait: 0 },
      { timeoutMs: 15_000 }
    );
    return NextResponse.json({ data: { ok: true } });
  } catch (e) {
    return NextResponse.json(
      { error: `发送失败: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
