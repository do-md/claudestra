export const runtime = "nodejs";

import { apiAgentName, bridgeAuthHeaders, BRIDGE } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 远程终端输出流（SSE 纯透传）。
 *
 * 代理 Bridge `GET /api/v1/agents/:name/terminal?cols=&rows=`（fork 端点，
 * 见 src/bridge/web-terminal.ts）。与 chat/stream 不同：终端帧无需翻译，
 * 直接 pipe 上游 body——Bridge 已经按 SSE 格式发帧 + 5s ping。
 *
 * 浏览器断开 → request.signal abort → 上游 fetch 中止 → Bridge 销毁 PTY
 * + viewer session（生命周期跟着这条流走，无需显式 close 端点）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return new Response("未登录", { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return new Response("missing agent", { status: 400 });
  const cols = url.searchParams.get("cols") || "100";
  const rows = url.searchParams.get("rows") || "30";

  let upstream: Response;
  try {
    upstream = await fetch(
      `${BRIDGE}/api/v1/agents/${encodeURIComponent(apiAgentName(agent))}/terminal?cols=${encodeURIComponent(cols)}&rows=${encodeURIComponent(rows)}`,
      {
        headers: { ...bridgeAuthHeaders(), Accept: "text/event-stream" },
        signal: request.signal,
      }
    );
  } catch (e) {
    return new Response(`Bridge 不可达: ${(e as Error).message}`, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    let msg = `Bridge 终端不可用 (${upstream.status})`;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    return new Response(msg, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
