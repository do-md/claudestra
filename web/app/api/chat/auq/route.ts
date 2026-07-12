export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 应答 AskUserQuestion 卡：submit(selections[][]) 或 cancel。
 * 代理 Bridge POST /api/v1/agents/:name/answer {kind:"auq"}（fork additive 端点），
 * Bridge 用 buildAuqKeystrokes 把选择翻译成 tmux 键序列发给 agent TUI。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { agent, action, selections } = await request.json().catch(() => ({}));
  if (!agent || (action !== "submit" && action !== "cancel")) {
    return NextResponse.json({ error: "agent/action 非法" }, { status: 400 });
  }
  try {
    const result = await bridgePost<{ ok: boolean; keys?: number; cancelled?: boolean }>(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/answer`,
      {
        kind: "auq",
        action,
        selections: Array.isArray(selections) ? selections : [],
      },
      { timeoutMs: 15_000 }
    );
    return NextResponse.json({ ...result, ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `AskUserQuestion 应答失败: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
