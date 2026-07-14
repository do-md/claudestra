export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";

/**
 * 用户个人资料（头像 + 昵称）。纯前端展示层数据,存 web 自己的 SQLite,
 * 显示在自己的消息气泡旁——不写进 jsonl,产品侧零感知。
 * avatar 是前端压缩好的 data URL(128px jpeg);服务端只做 256KB 上限防滥用。
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const row = getDb("settings")
    .prepare("SELECT nickname, avatar FROM user_profile WHERE id = 1")
    .get() as { nickname: string; avatar: string } | undefined;
  return NextResponse.json({ data: { nickname: row?.nickname ?? "", avatar: row?.avatar ?? "" } });
}

export async function PUT(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { nickname, avatar } = (await request.json().catch(() => ({}))) as {
    nickname?: string;
    avatar?: string;
  };
  if (typeof nickname !== "string" || typeof avatar !== "string") {
    return NextResponse.json({ error: "nickname / avatar 必须是字符串" }, { status: 400 });
  }
  if (avatar.length > 262144) {
    return NextResponse.json({ error: "头像过大(上限 256KB)" }, { status: 413 });
  }
  if (avatar && !avatar.startsWith("data:image/")) {
    return NextResponse.json({ error: "头像必须是 data:image/* 格式" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO user_profile (id, nickname, avatar, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, updated_at = excluded.updated_at`
    )
    .run(nickname.trim().slice(0, 32), avatar, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
