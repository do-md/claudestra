export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

/** kill agent：代理 Bridge POST /web/agents/kill（内部 runManager kill）。 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name } = await request.json().catch(() => ({}));
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name 不能为空" }, { status: 400 });
  }
  try {
    const res = await fetch(`${BRIDGE}/web/agents/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
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
