export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { mockBridge } from "@/lib/chat/mock-bridge";
import { resolveChannelId } from "@/lib/chat/agents";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

/**
 * 把用户消息投给指定 agent（fire-and-forget）。
 * 真实 agent（registry 有 channelId）→ POST Bridge /web/inject。
 * mock agent（无 channelId）→ 触发 mock-bridge 模拟回复（后端未起时的开发体验）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, text } = await request.json().catch(() => ({}));
  if (!agent || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "agent 和 text 不能为空" }, { status: 400 });
  }

  const channelId = resolveChannelId(agent);
  if (channelId) {
    // 真实 Bridge 路径
    try {
      const res = await fetch(`${BRIDGE}/web/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, text: text.trim() }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        return NextResponse.json({ error: `Bridge inject 失败: ${err}` }, { status: 502 });
      }
      return NextResponse.json({ data: { ok: true } });
    } catch (e) {
      return NextResponse.json({ error: `Bridge 不可达: ${(e as Error).message}` }, { status: 502 });
    }
  }

  // mock 回退（无真实会话时）
  mockBridge.simulateAgentReply(agent, text.trim());
  return NextResponse.json({ data: { ok: true } });
}
