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

/** 用户消息里附带的上传文件（用于自己气泡内回显）。 */
export interface ChatAttachmentView {
  name: string;
  kind: "image" | "file";
  /** 图片本地预览 objectURL（仅本会话内有效，刷新后历史里无此字段）。 */
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallView[];
  /** 由本轮流式生成（区别于历史加载） */
  streamed?: boolean;
  /** ISO 时间戳（历史来自 session jsonl，实时由前端 stamp）。 */
  ts?: string;
  /** 用户上传的附件（仅 user 气泡回显）。 */
  attachments?: ChatAttachmentView[];
  /** 入站消息来源标签（Discord 用户名 / 来源 agent；自己发的不带）。 */
  from?: string;
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
