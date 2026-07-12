import type { WebStreamEvent, WebComponentRow } from "@/lib/chat/events";
import type { PendingPermission, PendingAsk } from "./type";

/**
 * 消费流式事件的最小接口。ChatStore 实现它。
 * 事件是「段级」的（对应 v1 jsonl-watcher 摘要流），比 claude-os 的 token 级简单。
 */
export interface StreamSink {
  addToolCall(
    name: string,
    summary: string,
    state: "running" | "done" | "error"
  ): void;
  appendAssistantText(text: string): void;
  /** [fork] reply() 的最终回复：挂到当前 assistant 气泡的 replyText（回合外到达也定稿）。
   *  components：reply 附带的按钮/选单，挂到同一气泡供渲染。 */
  setReplyText(text: string, components?: WebComponentRow[]): void;
  setStatus(status: "running" | "done"): void;
  endTurn(): void;
  /** Phase 2：待处理交互卡（null=清卡）。 */
  setPermission(p: PendingPermission | null): void;
  setAsk(a: PendingAsk | null): void;
}

/** 处理一条已解析的 Web 流事件。初次发送与断线重连共用。 */
export function processStreamEvent(sink: StreamSink, evt: WebStreamEvent) {
  switch (evt.t) {
    case "tool":
      sink.addToolCall(evt.name, evt.summary, evt.state);
      break;
    case "text":
      sink.appendAssistantText(evt.text);
      break;
    case "reply":
      sink.setReplyText(evt.text, evt.components);
      break;
    case "status":
      sink.setStatus(evt.status);
      break;
    case "done":
      sink.endTurn();
      break;
    case "error":
      sink.appendAssistantText(`\n[Error: ${evt.error}]`);
      break;
    case "permission":
      sink.setPermission({
        id: evt.id,
        kind: evt.kind,
        title: evt.title,
        desc: evt.desc,
        actions: evt.actions,
      });
      break;
    case "permission-cleared":
      sink.setPermission(null);
      break;
    case "ask":
      sink.setAsk({ id: evt.id, questions: evt.questions });
      break;
    case "ask-cleared":
      sink.setAsk(null);
      break;
  }
}

/**
 * 读取 SSE 响应流并逐事件回调。流结束（连接关闭）即 resolve。
 * `data: [DONE]` 是心跳/占位，跳过。
 */
export async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: WebStreamEvent) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data) as WebStreamEvent);
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}
