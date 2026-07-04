export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { loadAgents, getMasterInfo, masterAgentSession } from "@/lib/chat/agents";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  // 置顶大总管（若 Bridge 配了 CONTROL_CHANNEL_ID），其余是 registry 里的 worker agent
  const master = await getMasterInfo();
  const list = [
    ...(master ? [masterAgentSession(master)] : []),
    ...loadAgents(),
  ];
  return NextResponse.json({ data: list });
}

/** 新建 agent：代理 Bridge POST /web/agents（内部 runManager create）。 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name, dir, purpose } = await request.json().catch(() => ({}));
  if (!name || !dir || typeof name !== "string" || typeof dir !== "string") {
    return NextResponse.json({ error: "name 和 dir 不能为空" }, { status: 400 });
  }
  try {
    const res = await fetch(`${BRIDGE}/web/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), dir: dir.trim(), purpose }),
    });
    const result = await res.json().catch(() => ({ ok: false, error: "Bridge 返回非 JSON" }));
    return NextResponse.json(result, { status: res.ok ? 200 : res.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
