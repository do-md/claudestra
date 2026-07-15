export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * Claude 全局默认(模型 + effort)管理——代理 Bridge GET/PUT /api/v1/config/claude-defaults
 * (owner 2026-07-16:「设置里可以管理全局 model 和 effort」)。
 * 影响所有不带单独钉模型/effort 的新 session,含终端里直接开的 claude。
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const r = await bridgeGet<{ ok: boolean; model: string | null; effort: string | null }>(
      "/config/claude-defaults",
      { timeoutMs: 8000 }
    );
    return NextResponse.json({ data: { model: r.model, effort: r.effort } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { model?: string; effort?: string };
  if (typeof body.model !== "string" && typeof body.effort !== "string") {
    return NextResponse.json({ error: "需要 model 或 effort" }, { status: 400 });
  }
  try {
    const r = await bridgePost<{ ok: boolean; model: string | null; effort: string | null; error?: string }>(
      "/config/claude-defaults",
      {
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      },
      { timeoutMs: 8000, method: "PUT" }
    );
    if (!r.ok) return NextResponse.json({ error: r.error || "写入失败" }, { status: 500 });
    return NextResponse.json({ data: { model: r.model, effort: r.effort } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
