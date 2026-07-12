/**
 * Web 会话流事件协议（v1）。
 *
 * 对应架构文档 §3：v1 复用 jsonl-watcher 的「段级」摘要流，而非 claude-os 的 token 级
 * Anthropic stream_event。因此事件比 claude-os 精简：工具摘要、助手文本段、回复、收尾。
 *
 * 2026-07-10 迁移后：BFF 的 /api/chat/stream 订阅 Bridge /api/v1/events
 * （upstream event-bus SSE），并把 BridgeEvent 翻译成这里的 WebStreamEvent
 * 逐条下发（`data: <json>\n\n`）——前端协议 v1 不变，消费代码零改动。
 */
/** 权限/AUQ 卡的一个操作按钮（回传时 action 让 bridge 打对应 tmux 键序列）。 */
export interface WebPermAction {
  action: string;
  label: string;
  style: "success" | "primary" | "danger" | "secondary";
}
/** AskUserQuestion 一个选项 / 一道题的 Web 形状（与 bridge/web-hub.ts 对齐）。 */
export interface WebAuqOption {
  label: string;
  description?: string;
}
export interface WebAuqQuestion {
  question: string;
  header: string;
  options: WebAuqOption[];
  multiSelect: boolean;
}

export type WebStreamEvent =
  | { t: "status"; status: "running" | "done" }
  /** 一次工具调用的段级摘要（📖 Read xxx / ✏️ Edit xxx / ⚙️ Bash ...） */
  | { t: "tool"; name: string; summary: string; state: "running" | "done" | "error" }
  /** 助手文本段（过程叙述，追加到当前流式助手消息的 content） */
  | { t: "text"; text: string }
  /** [fork] reply() 的最终回复（挂到当前 assistant 气泡的 replyText，与叙述分区渲染） */
  | { t: "reply"; text: string }
  /** 本轮结束 */
  | { t: "done" }
  | { t: "error"; error: string }
  // Phase 2 富交互：需要用户抉择的「待处理卡」。回传经 BFF → bridge → tmux 按键。
  | {
      t: "permission";
      /** 稳定 dedup key（modal 语义） */
      id: string;
      kind: "permission" | "session-idle";
      title: string;
      desc: string;
      actions: WebPermAction[];
    }
  | { t: "permission-cleared" }
  | { t: "ask"; id: string; questions: WebAuqQuestion[] }
  | { t: "ask-cleared" };

export const SSE_DONE = "[DONE]";
