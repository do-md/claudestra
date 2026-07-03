/**
 * Web 会话流事件协议（v1）。
 *
 * 对应架构文档 §3：v1 复用 jsonl-watcher 的「段级」摘要流，而非 claude-os 的 token 级
 * Anthropic stream_event。因此事件比 claude-os 精简：工具摘要、助手文本段、回复、收尾。
 *
 * Bridge 侧 GET /web/stream 会以 SSE `data: <json>\n\n` 逐条下发这些事件；
 * mock 阶段由 lib/chat/mock-bridge.ts 产生同样形状的事件，前端消费代码保持一致。
 */
export type WebStreamEvent =
  | { t: "status"; status: "running" | "done" }
  /** 一次工具调用的段级摘要（📖 Read xxx / ✏️ Edit xxx / ⚙️ Bash ...） */
  | { t: "tool"; name: string; summary: string; state: "running" | "done" | "error" }
  /** 助手文本段（追加到当前流式助手消息） */
  | { t: "text"; text: string }
  /** 本轮结束 */
  | { t: "done" }
  | { t: "error"; error: string };

export const SSE_DONE = "[DONE]";
