import type { WebPermAction, WebAuqQuestion } from "@/lib/chat/events";

export interface ToolCallView {
  name: string;
  summary: string;
  state: "running" | "done" | "error";
}

/** 待处理的权限 / session-idle 卡（一个会话同时最多一张）。 */
export interface PendingPermission {
  id: string;
  kind: "permission" | "session-idle";
  title: string;
  desc: string;
  actions: WebPermAction[];
}

/** 待处理的 AskUserQuestion 卡（一个会话同时最多一张）。 */
export interface PendingAsk {
  id: string;
  questions: WebAuqQuestion[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallView[];
  /** 由本轮流式生成（区别于历史加载） */
  streamed?: boolean;
}

export interface AgentSession {
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  status: "active" | "stopped";
  mock?: boolean;
  /** 大总管置顶入口——不显示 kill/restart，列表第一位。 */
  pinnedMaster?: boolean;
}
