export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/** kill agent：代理 Bridge POST /api/v1/agents/:name/kill（fork additive 端点）。 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name } = await request.json().catch(() => ({}));
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name 不能为空" }, { status: 400 });
  }
  try {
    const result = await bridgePost(
      `/agents/${encodeURIComponent(name.trim())}/kill`,
      {},
      { timeoutMs: 60_000 }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}
