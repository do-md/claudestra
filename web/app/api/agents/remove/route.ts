export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/** 永久移除 agent（kill + registry 条目删除,归档保留）：
 *  代理 Bridge POST /api/v1/agents/:name/remove（fork additive 端点）。
 *  owner 2026-07-14:「临时起的 agent 不想在列表里污染我,永久删除」。 */
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
      `/agents/${encodeURIComponent(name.trim())}/remove`,
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
