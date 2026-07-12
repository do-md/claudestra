export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  verifySSH,
  checkRateLimit,
  createSession,
  SESSION_COOKIE,
} from "@/lib/services/auth.service";

const SESSION_DAYS = 7;

export async function POST(request: Request) {
  const { username, password, host, port } = await request.json();

  if (!username || !password) {
    return NextResponse.json(
      { error: "用户名和密码不能为空" },
      { status: 400 }
    );
  }

  if (!checkRateLimit(username)) {
    return NextResponse.json(
      { error: "登录尝试过于频繁，请稍后再试" },
      { status: 429 }
    );
  }

  const ok = await verifySSH(
    username,
    password,
    host || "127.0.0.1",
    port ? Number(port) : 22
  );
  if (!ok) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  const session = createSession(username);
  const res = NextResponse.json({ data: { username } });
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production";

  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge,
  });

  return res;
}
