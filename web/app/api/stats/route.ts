export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { BRIDGE } from "@/lib/chat/bridge-api";

/**
 * 全局用量看板数据（2026-07-14 owner：context/用量要成体系,web 端做看板）。
 * 代理 Bridge 的 /stats（bridge 本地无鉴权端点,BFF 加登录门）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const res = await fetch(`${BRIDGE}/stats`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json(
      { error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
