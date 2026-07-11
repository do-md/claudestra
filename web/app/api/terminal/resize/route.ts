export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 远程终端 resize：代理 Bridge `POST /api/v1/terminal/:termId/resize`。
 * body: { id: termId, cols, rows }。Bridge 侧 term.resize 后手动补
 * SIGWINCH（Bun.Terminal 子进程无 controlling tty，内核不自动发）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id, cols, rows } = (await request.json().catch(() => ({}))) as {
    id?: string;
    cols?: number;
    rows?: number;
  };
  if (!id || !cols || !rows) {
    return NextResponse.json({ error: "缺少 id/cols/rows" }, { status: 400 });
  }
  try {
    await bridgePost(
      `/terminal/${encodeURIComponent(id)}/resize`,
      { cols, rows },
      { timeoutMs: 5_000 }
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}
