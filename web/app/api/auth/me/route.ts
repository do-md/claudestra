export const runtime = "nodejs";

import os from "os";
import { NextResponse } from "next/server";
import { getSessionFromCookie } from "@/lib/services/auth.service";

export async function GET() {
  const session = await getSessionFromCookie();
  if (!session) {
    return NextResponse.json({ data: null });
  }
  return NextResponse.json({
    data: { username: session.username, home: os.homedir() },
  });
}
