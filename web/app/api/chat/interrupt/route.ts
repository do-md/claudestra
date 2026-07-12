export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 一键中断：代理 Bridge POST /api/v1/agents/:name/interrupt（fork additive
 * 端点，tmux C-c；master → master:0）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent } = await request.json().catch(() => ({}));
  if (!agent) {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }
  try {
    const result = await bridgePost<{ ok: boolean; agent?: string }>(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/interrupt`,
      {},
      { timeoutMs: 10_000 }
    );
    return NextResponse.json({ ok: true, agent: result.agent });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `打断失败: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
