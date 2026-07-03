export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveSession } from "@/lib/chat/agents";
import { loadHistoryFromJsonl } from "@/lib/chat/history";
import { isAuthed } from "@/lib/api-auth";

/**
 * 某 agent 的历史消息（打开会话时先拉，刷新不丢）。
 * 直接读 CC session jsonl（同机只读盘），对已停止 agent 也有效。
 * mock / 无 sessionId → 返回空列表。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) {
    return NextResponse.json({ error: "missing agent" }, { status: 400 });
  }

  const ref = resolveSession(agent);
  if (!ref?.sessionId || !ref?.cwd) {
    // mock 或尚无 session（新建后还没跑过）→ 无历史
    return NextResponse.json({ data: [] });
  }

  try {
    const messages = loadHistoryFromJsonl(ref.cwd, ref.sessionId);
    return NextResponse.json({ data: messages });
  } catch (e) {
    return NextResponse.json(
      { error: `读取历史失败: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
