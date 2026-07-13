export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { readWebConfig, writeWebConfig } from "@/lib/web-config";

/**
 * 全局设置（目前只有语音识别 key）。GET 只回「是否已配 + 尾四位提示」,
 * 完整 key 永不回传前端;PUT { groqApiKey } 保存,空串清除。
 */

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const cfg = await readWebConfig();
  return NextResponse.json({
    groqApiKeySet: !!cfg.groqApiKey,
    groqApiKeyHint: cfg.groqApiKey ? `····${cfg.groqApiKey.slice(-4)}` : "",
  });
}

export async function PUT(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { groqApiKey?: unknown };
  if (typeof body.groqApiKey !== "string") {
    return NextResponse.json({ error: "groqApiKey 必须是字符串（空串=清除）" }, { status: 400 });
  }
  const trimmed = body.groqApiKey.trim();
  if (trimmed && !/^[\w-]{20,200}$/.test(trimmed)) {
    return NextResponse.json({ error: "key 格式不像有效的 API key" }, { status: 400 });
  }
  const cfg = await writeWebConfig({ groqApiKey: trimmed });
  return NextResponse.json({
    ok: true,
    groqApiKeySet: !!cfg.groqApiKey,
    groqApiKeyHint: cfg.groqApiKey ? `····${cfg.groqApiKey.slice(-4)}` : "",
  });
}
