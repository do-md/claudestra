export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveChannelId } from "@/lib/chat/agents";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

/**
 * 应答权限 / session-idle 卡：把 action（perm_allow / session_full / …）转发给 Bridge，
 * Bridge 翻译成 tmux 键序列打给 agent 的 Claude Code TUI。
 * 权限弹窗只出现在真实 agent 上（大总管不被 permission-watcher 轮询），故不特判 master。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, action } = await request.json().catch(() => ({}));
  if (!agent || !action) {
    return NextResponse.json({ error: "agent 和 action 不能为空" }, { status: 400 });
  }

  const channelId = resolveChannelId(agent);
  if (!channelId) {
    return NextResponse.json({ ok: true, mock: true });
  }

  try {
    const res = await fetch(`${BRIDGE}/web/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, action }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      return NextResponse.json(
        { ok: false, error: json.error || "应答失败" },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, dialogClosed: json.dialogClosed });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
