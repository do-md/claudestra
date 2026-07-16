export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";
import { getVapidKeys } from "@/lib/push/vapid";
import { startPushDispatcher } from "@/lib/push/dispatcher";

// lazy 双保险:instrumentation 在 dev server 不重启时不会执行,任何推送 API
// 被碰到就把派发器拉起来(幂等单例)
startPushDispatcher();

/**
 * Web Push 订阅管理(owner 2026-07-16「做 pwa 推送」)。
 * GET    → { publicKey, subscribed: number } 前端拿 VAPID 公钥发起订阅
 * POST   { subscription } → 保存(endpoint 主键 upsert)
 * DELETE { endpoint }     → 退订
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const count = getDb("settings").prepare("SELECT COUNT(*) AS c FROM push_subscriptions").get() as { c: number };
  return NextResponse.json({ data: { publicKey: getVapidKeys().publicKey, subscribed: count.c } });
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { subscription } = (await request.json().catch(() => ({}))) as {
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  };
  const endpoint = subscription?.endpoint;
  const keys = subscription?.keys;
  if (!endpoint || !keys?.p256dh || !keys?.auth || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json({ error: "subscription 无效" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, keys, ua, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys`
    )
    .run(endpoint, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }), request.headers.get("user-agent") || "", new Date().toISOString());
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { endpoint } = (await request.json().catch(() => ({}))) as { endpoint?: string };
  if (!endpoint) return NextResponse.json({ error: "missing endpoint" }, { status: 400 });
  getDb("settings").prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  return NextResponse.json({ ok: true });
}
