export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAuthed } from "@/lib/api-auth";

/**
 * Skill 快捷入口偏好（owner 2026-07-15）：置顶集合 + 使用频次。
 * GET  → { data: { pins: string[], counts: Record<string, number> } }
 * PUT  { name, pinned } → 置顶开关
 * POST { name }         → 使用计数 +1（composer 发送 /xxx 时埋点）
 * 纯前端偏好,存 web 自己的 SQLite,产品侧零感知。
 */

const NAME_RE = /^[\w:-]{1,64}$/;

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const rows = getDb("settings")
    .prepare("SELECT name, pinned, used_count, updated_at FROM skill_prefs")
    .all() as { name: string; pinned: number; used_count: number; updated_at: string }[];
  const pins = rows
    .filter((r) => r.pinned)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.used_count > 0) counts[r.name] = r.used_count;
  return NextResponse.json({ data: { pins, counts } });
}

export async function PUT(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name, pinned } = (await request.json().catch(() => ({}))) as {
    name?: string;
    pinned?: boolean;
  };
  if (!name || !NAME_RE.test(name) || typeof pinned !== "boolean") {
    return NextResponse.json({ error: "name / pinned 无效" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO skill_prefs (name, pinned, used_count, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(name) DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at`
    )
    .run(name, pinned ? 1 : 0, new Date().toISOString());
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name } = (await request.json().catch(() => ({}))) as { name?: string };
  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "name 无效" }, { status: 400 });
  }
  getDb("settings")
    .prepare(
      `INSERT INTO skill_prefs (name, pinned, used_count, updated_at) VALUES (?, 0, 1, ?)
       ON CONFLICT(name) DO UPDATE SET used_count = used_count + 1`
    )
    .run(name, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
