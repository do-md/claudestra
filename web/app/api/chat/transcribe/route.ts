export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";

/**
 * 语音转文字（2026-07-14 owner：应用内语音输入,根治豆包输入法跳 App 黑屏）。
 *
 * v1 后端 = Groq 免费层（whisper-large-v3-turbo,每天 2000 次转写额度）。
 * 前端录音 blob → 这里转发 Groq OpenAI 兼容接口 → {text}。
 * key 放 web/.env.local 的 GROQ_API_KEY;未配置返回 501（前端提示配置）。
 * 结构上留了换后端的口子（火山/阿里只改这一个文件）。
 */

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "语音识别未配置（缺 GROQ_API_KEY）" },
      { status: 501 }
    );
  }
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "missing audio" }, { status: 400 });
  }
  if (audio.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "音频过大（>20MB）" }, { status: 400 });
  }

  const fd = new FormData();
  fd.append("file", audio, audio.name || "audio.m4a");
  fd.append("model", "whisper-large-v3-turbo");
  // 不锁 language：whisper 自动判中英混说；temperature 0 求稳
  fd.append("temperature", "0");
  fd.append("response_format", "json");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!res.ok) {
      return NextResponse.json(
        { error: `识别失败: ${j.error?.message || `HTTP ${res.status}`}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ text: (j.text || "").trim() });
  } catch (e) {
    return NextResponse.json(
      { error: `识别服务不可达: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
