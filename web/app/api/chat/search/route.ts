export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

interface BridgeSearchHit {
  agent: string;
  sessionId: string;
  source: string;
  seq: number;
  ts: string | null;
  role: string;
  snippet: string;
  from?: string;
  compact?: boolean;
}

/** 聊天记录全局搜索：代理 Bridge GET /api/v1/history/search（fork additive）。
 *  跨 agent 跨 session（live+归档，含已删 agent），对话正文级命中。
 *  owner 2026-07-14：「compact 后降质忘事,模糊记得有件事——搜聊天记录找回」。 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return NextResponse.json({ error: "至少 2 个字符" }, { status: 400 });
  }
  try {
    const result = await bridgeGet<{ ok: boolean; hits: BridgeSearchHit[] }>(
      `/history/search?q=${encodeURIComponent(q)}&limit=30`,
      { timeoutMs: 30_000 }
    );
    // agent 名映射成前端会话名（agent-xxx → xxx，master → __master__）
    const data = (result.hits || []).map((h) => ({
      ...h,
      agent: h.agent === "master" ? "__master__" : h.agent.replace(/^agent-/, ""),
    }));
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}
