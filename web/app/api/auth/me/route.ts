export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSessionFromCookie } from "@/lib/services/auth.service";

export async function GET() {
  const session = await getSessionFromCookie();
  if (!session) {
    return NextResponse.json({ data: null });
  }
  // 不回显服务器 home 路径（L3：轻度信息泄露，前端不需要）
  return NextResponse.json({
    data: { username: session.username },
  });
}
