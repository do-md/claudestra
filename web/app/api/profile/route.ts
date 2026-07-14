export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";

/**
 * 个人资料（用户头像+昵称 / Claude 头像+名称）。纯前端展示层数据,存 web
 * 自己的 SQLite,显示在消息气泡上方——不写进 jsonl,产品侧零感知。
 * avatar 是前端压缩好的 data URL(128px jpeg);服务端只做 256KB 上限防滥用。
 */

const AVATAR_MAX = 262144;

function validAvatar(v: unknown): v is string {
  return typeof v === "string" && v.length <= AVATAR_MAX && (v === "" || v.startsWith("data:image/"));
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const row = getDb("settings")
    .prepare("SELECT nickname, avatar, claude_nickname, claude_avatar FROM user_profile WHERE id = 1")
    .get() as { nickname: string; avatar: string; claude_nickname: string; claude_avatar: string } | undefined;
  return NextResponse.json({
    data: {
      nickname: row?.nickname ?? "",
      avatar: row?.avatar ?? "",
      claudeNickname: row?.claude_nickname ?? "",
      claudeAvatar: row?.claude_avatar ?? "",
    },
  });
}

export async function PUT(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { nickname, avatar, claudeNickname, claudeAvatar } = (await request.json().catch(() => ({}))) as {
    nickname?: string;
    avatar?: string;
    claudeNickname?: string;
    claudeAvatar?: string;
  };
  if (typeof nickname !== "string" || typeof claudeNickname !== "string") {
    return NextResponse.json({ error: "昵称必须是字符串" }, { status: 400 });
  }
  if (!validAvatar(avatar) || !validAvatar(claudeAvatar)) {
    return NextResponse.json({ error: "头像必须是 data:image/* 且不超过 256KB" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO user_profile (id, nickname, avatar, claude_nickname, claude_avatar, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nickname = excluded.nickname, avatar = excluded.avatar,
         claude_nickname = excluded.claude_nickname, claude_avatar = excluded.claude_avatar,
         updated_at = excluded.updated_at`
    )
    .run(nickname.trim().slice(0, 32), avatar, claudeNickname.trim().slice(0, 32), claudeAvatar, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
