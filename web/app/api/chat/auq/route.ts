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
 * 应答 AskUserQuestion 卡：submit(selections[][]) 或 cancel。转发给 Bridge，
 * Bridge 用 buildAuqKeystrokes 把选择翻译成 tmux 键序列（Down/Enter/Right/…）发给 agent TUI。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, action, selections } = await request.json().catch(() => ({}));
  if (!agent || (action !== "submit" && action !== "cancel")) {
    return NextResponse.json({ error: "agent/action 非法" }, { status: 400 });
  }

  const channelId =
    agent === MASTER_AGENT_NAME
      ? (await getMasterInfo())?.channelId ?? null
      : resolveChannelId(agent);
  if (!channelId) {
    return NextResponse.json({ ok: true, mock: true });
  }

  try {
    const res = await fetch(`${BRIDGE}/web/auq`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId,
        action,
        selections: Array.isArray(selections) ? selections : [],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      return NextResponse.json(
        { ok: false, error: json.error || "AskUserQuestion 应答失败" },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, summary: json.summary });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
