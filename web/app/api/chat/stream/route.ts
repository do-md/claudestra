export const runtime = "nodejs";

import { SSE_DONE, type WebStreamEvent, type WebAuqQuestion, type WebComponentRow } from "@/lib/chat/events";
import { apiAgentName, bridgeGet, bridgeAuthHeaders, BRIDGE } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/**
 * 某 agent 的持久输出流（SSE）。
 *
 * 2026-07-10 迁移：旧 /web/stream（web-hub tee）→ upstream 的 /api/v1/events
 * （event-bus SSE）。BFF 在 server 端带 Bearer 订阅（绕开 EventSource 不能带
 * header 的坑），按 agent 过滤 + 把 BridgeEvent 翻译成前端的 WebStreamEvent
 * （协议 v1 不变，前端 stream.ts / chat-store 零改动）。
 *
 * 事件映射：
 *   agent_status thinking → {t:"status",status:"running"}；done → {t:"done"}
 *   tool_start            → {t:"tool", state:"running"}（tool_done 不重复推卡）
 *   assistant_text        → {t:"text"}
 *   chat_message(out)     → {t:"reply"}（reply() 的最终回复，挂 replyText 与叙述分区渲染）
 *   question              → {t:"ask"}；question_cleared → {t:"ask-cleared"}（fork 事件）
 *   auto_deny             → {t:"text", "🚫 …"}
 *   bg_task_started/update/completed → {t:"bg-start"/"bg-update"/"bg-done"}（后台任务面板）
 *   其余（turn_duration / session_anomaly）v1 暂不消费
 *
 * 连流后先补拉 GET /api/v1/agents/:name/pending —— question 事件可能发生在
 * 订阅之前（切会话/刷新/回前台），对应旧 web-hub 的 pendingInteraction replay。
 */

interface BridgeEvent {
  seq: number;
  ts: string;
  agent: string;
  chatId: string;
  type: string;
  data: Record<string, unknown>;
}

function mapAuqQuestions(raw: unknown): WebAuqQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => ({
    question: String(q?.question ?? ""),
    header: String(q?.header ?? ""),
    multiSelect: !!q?.multiSelect,
    options: Array.isArray(q?.options)
      ? q.options.map((o: { label?: string; description?: string }) => ({
          label: String(o?.label ?? ""),
          description: o?.description ? String(o.description) : undefined,
        }))
      : [],
  }));
}

/** BridgeEvent → WebStreamEvent（null = 该事件 v1 不消费）。 */
function translate(evt: BridgeEvent): WebStreamEvent | null {
  const d = evt.data || {};
  switch (evt.type) {
    case "agent_status":
      return d.status === "done" ? { t: "done" } : { t: "status", status: "running" };
    case "tool_start":
      return { t: "tool", name: String(d.name ?? "?"), summary: String(d.summary ?? ""), state: "running" };
    case "assistant_text":
      return { t: "text", text: String(d.text ?? "") };
    case "chat_message":
      // direction=in 是自己发出去的消息回声；out 才是 agent 的回复
      if (d.direction !== "out") return null;
      // [fork] reply() 的最终回复 → 独立 reply 事件（挂 replyText，与过程叙述分区、
      // 走 Domd 富文本、且回合 done 之后到达也能定稿——修「回复完又冒一条纯文本」）
      // components：reply 附带的按钮/选单（后端 #29 起 chat_message 事件带上），原样透传
      return {
        t: "reply",
        text: String(d.text ?? ""),
        ...(Array.isArray(d.components) ? { components: d.components as WebComponentRow[] } : {}),
      };
    case "question":
      return { t: "ask", id: `auq-${evt.seq}`, questions: mapAuqQuestions(d.questions) };
    case "question_cleared":
      return { t: "ask-cleared" };
    case "auto_deny":
      return { t: "text", text: `🚫 一个操作被 auto 模式拦下${d.reason ? `：${String(d.reason)}` : ""}` };
    case "bg_task_started":
      return {
        t: "bg-start",
        id: String(d.id ?? ""),
        kind: d.kind === "shell" ? "shell" : "subagent",
        title: String(d.title ?? ""),
      };
    case "bg_task_update":
      // items 缺失（老 bridge）→ 无内容可渲染，丢弃（避免空更新扰动 UI）
      if (!Array.isArray(d.items) || d.items.length === 0) return null;
      return { t: "bg-update", id: String(d.id ?? ""), items: (d.items as unknown[]).map(String) };
    case "bg_task_completed":
      return { t: "bg-done", id: String(d.id ?? ""), durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined };
    case "compact_done":
      // jsonl compact_boundary → 系统分隔线 + ctx 徽章即时回落（不等 15s 轮询）
      return {
        t: "compact",
        pre: typeof d.preTokens === "number" ? d.preTokens : 0,
        post: typeof d.postTokens === "number" ? d.postTokens : 0,
      };
    default:
      return null;
  }
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return new Response("未登录", { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return new Response("missing agent", { status: 400 });
  const apiName = apiAgentName(agent);
  // 事件里的 agent 字段是 registry 名（agent-xxx）或 "master"
  const nameVariants = new Set([apiName, `agent-${apiName}`]);

  let upstream: Response;
  try {
    upstream = await fetch(`${BRIDGE}/api/v1/events`, {
      headers: { ...bridgeAuthHeaders(), Accept: "text/event-stream" },
      signal: request.signal,
    });
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    console.error(`[stream] Bridge events fetch 失败 agent=${agent}:`, (e as Error).message, "| cause:", cause);
    return new Response(`Bridge 不可达: ${(e as Error).message}`, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    console.error(`[stream] Bridge events 非 2xx agent=${agent}: status=${upstream.status} body=${body.slice(0, 200)}`);
    return new Response("Bridge events 不可用", { status: 502 });
  }
  const upstreamBody = upstream.body;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: WebStreamEvent | typeof SSE_DONE) => {
        try {
          const payload = evt === SSE_DONE ? SSE_DONE : JSON.stringify(evt);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          /* 已关闭 */
        }
      };
      heartbeat = setInterval(() => send(SSE_DONE), 30_000);

      // 连流即补拉当前挂起态（question 事件 + 回合进行态可能早于本次订阅：
      // 切会话 / 刷新 / 回前台）。thinking 时先补一条 status:running，让 composer
      // 立刻进入「停止」态（对应旧 web-hub 的 pendingInteraction replay）。
      try {
        const pending = await bridgeGet<{
          ok: boolean;
          question: { questions: unknown; ts: number } | null;
          thinking?: boolean;
        }>(`/agents/${encodeURIComponent(apiName)}/pending`, { timeoutMs: 5000 });
        if (pending.thinking) {
          send({ t: "status", status: "running" });
        }
        if (pending.question) {
          send({
            t: "ask",
            id: `auq-pending-${pending.question.ts}`,
            questions: mapAuqQuestions(pending.question.questions),
          });
        }
      } catch {
        /* pending 补拉失败不阻塞流 */
      }

      // bg 任务 replay：SSE 只带增量,刷新/重连后活跃任务面板会空——连流即补拉
      // 快照,合成 bg-start + bg-update 下发（已积累的尾部行一次性给到）。
      try {
        const bg = await bridgeGet<{
          ok: boolean;
          tasks: { id: string; kind: "subagent" | "shell"; title: string; lines: string[] }[];
        }>(`/agents/${encodeURIComponent(apiName)}/bg-tasks`, { timeoutMs: 5000 });
        for (const t of bg.tasks || []) {
          send({ t: "bg-start", id: t.id, kind: t.kind, title: t.title });
          if (t.lines?.length) send({ t: "bg-update", id: t.id, items: t.lines });
        }
        // 快照全集下发（空数组也发）：前端把不在此列的 running 卡标完成——
        // bridge 重启丢 bg_task_completed 事件时,幽灵「working」卡靠它收敛
        send({ t: "bg-sync", ids: (bg.tasks || []).map((t) => t.id) });
      } catch {
        /* bg 补拉失败不阻塞流 */
      }

      const reader = upstreamBody.getReader();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: BridgeEvent;
            try {
              evt = JSON.parse(dataLines.join("\n")) as BridgeEvent;
            } catch {
              continue; // 心跳/坏帧
            }
            if (!nameVariants.has(evt.agent)) continue;
            const mapped = translate(evt);
            if (mapped) send(mapped);
          }
        }
      } catch {
        /* 上游断开（bridge 重启等）→ 结束本流，前端重连 */
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
