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
  // host/port 不再从 body 取——verifySSH 硬编码本机（防未认证 SSH-target 注入 + SSRF）
  const { username, password } = await request.json();

  if (!username || !password) {
    return NextResponse.json(
      { error: "用户名和密码不能为空" },
      { status: 400 }
    );
  }

  // 限流按客户端 IP（反代设置 x-forwarded-for），换 username 也换不掉桶；
  // 无 IP 时回退 username 至少有个限。
  const xff = request.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || "";
  const rlKey = ip ? `ip:${ip}` : `user:${username}`;
  if (!checkRateLimit(rlKey)) {
    return NextResponse.json(
      { error: "登录尝试过于频繁，请稍后再试" },
      { status: 429 }
    );
  }

  const ok = await verifySSH(username, password);
  if (!ok) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  const session = createSession(username);
  const res = NextResponse.json({ data: { username } });
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  // Secure 默认**关**：这套 web 常经 Tailscale / 本机的明文 HTTP 访问，Secure cookie
  // 在 HTTP 下会被浏览器直接丢弃 → 登录成功但 cookie 存不下、一直跳回登录页。
  // 只有前面是 HTTPS 反代终止 TLS 的部署才设 COOKIE_SECURE=on 显式开。
  // (httpOnly + sameSite=strict 已提供 XSS/CSRF 防护，Secure 只防明文窃听。)
  const secure = process.env.COOKIE_SECURE === "on";

  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge,
  });

  return res;
}
