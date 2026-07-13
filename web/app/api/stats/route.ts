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
  // ?refresh=1：强制重抓账号 gauge（bridge force 路径最长 ~20s,超时给足 30s）
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const res = force
      ? await fetch(`${BRIDGE}/stats/refresh`, { method: "POST", signal: AbortSignal.timeout(30_000) })
      : await fetch(`${BRIDGE}/stats`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json(
      { error: `Bridge 不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
