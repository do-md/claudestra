export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 某 agent 的 Claude Code 原生任务清单——代理 Bridge GET /api/v1/agents/:name/tasks
 * (owner 2026-07-16:「console 里的 todo 适配到 Web UI 上」)。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return NextResponse.json({ error: "missing agent" }, { status: 400 });
  try {
    const r = await bridgeGet<{
      ok: boolean;
      tasks: { id: string; subject: string; activeForm?: string; status: string; blockedBy: string[] }[];
    }>(`/agents/${encodeURIComponent(apiAgentName(agent))}/tasks`, { timeoutMs: 8000 });
    return NextResponse.json({ data: r.tasks || [] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
