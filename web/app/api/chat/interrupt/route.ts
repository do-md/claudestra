export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  resolveChannelId,
  getMasterInfo,
  MASTER_AGENT_NAME,
} from "@/lib/chat/agents";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

/**
 * 一键中断：给指定 agent 的 Claude Code 会话发 Ctrl+C（复用 Bridge 的 interrupt 逻辑）。
 * 真实 agent（有 channelId）→ POST Bridge /web/interrupt。
 * mock agent（无 channelId）→ 无后端，直接 ok（no-op）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent } = await request.json().catch(() => ({}));
  if (!agent) {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }

  const channelId =
    agent === MASTER_AGENT_NAME
      ? (await getMasterInfo())?.channelId ?? null
      : resolveChannelId(agent);
  if (!channelId) {
    // mock / 无真实会话：无操作
    return NextResponse.json({ ok: true, mock: true });
  }

  try {
    const res = await fetch(`${BRIDGE}/web/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      return NextResponse.json(
        { ok: false, error: json.error || "打断失败" },
        { status: res.status === 404 ? 404 : 502 }
      );
    }
    return NextResponse.json({ ok: true, agent: json.agent });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
