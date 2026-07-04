export const runtime = "nodejs";

import { mockBridge } from "@/lib/chat/mock-bridge";
import { SSE_DONE, type WebStreamEvent } from "@/lib/chat/events";
import { resolveChannelId, getMasterInfo, MASTER_AGENT_NAME } from "@/lib/chat/agents";
import { isAuthed } from "@/lib/api-auth";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/**
 * 某 agent 的持久输出流（SSE）。
 * 真实 agent（有 channelId）→ 代理 Bridge /web/stream。
 * mock agent → 订阅 mock-bridge（后端未起时的开发体验）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return new Response("未登录", { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return new Response("missing agent", { status: 400 });

  const channelId =
    agent === MASTER_AGENT_NAME
      ? (await getMasterInfo())?.channelId ?? null
      : resolveChannelId(agent);
  if (channelId) {
    // 真实 Bridge：透传其 SSE 流（事件格式一致）
    try {
      const upstream = await fetch(
        `${BRIDGE}/web/stream?channelId=${encodeURIComponent(channelId)}`,
        { signal: request.signal }
      );
      if (!upstream.ok || !upstream.body) {
        return new Response("Bridge stream 不可用", { status: 502 });
      }
      return new Response(upstream.body, { headers: SSE_HEADERS });
    } catch (e) {
      return new Response(`Bridge 不可达: ${(e as Error).message}`, { status: 502 });
    }
  }

  // mock 回退
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          /* 已关闭 */
        }
      };
      send(JSON.stringify({ t: "status", status: "running" } satisfies WebStreamEvent));
      unsubscribe = mockBridge.subscribe(agent, (event) => send(JSON.stringify(event)));
      heartbeat = setInterval(() => send(SSE_DONE), 30000);
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
