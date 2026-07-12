import type { WebPermAction, WebAuqQuestion, WebComponentRow } from "@/lib/chat/events";

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
  /** assistant：过程叙述文本（流式 assistant_text）。user：消息正文。 */
  content: string;
  /** [fork] assistant 的「最终回复」（reply() 正文）——与过程叙述 content 分区渲染，
   *  中间用淡分隔线隔开。历史来自 jsonl 的 reply tool_use，直播来自 chat_message(out)。 */
  replyText?: string;
  /** reply 附带的交互组件（按钮/选单）。点击回投 [button:<id>] / [select:<id>:<value>]。 */
  replyComponents?: WebComponentRow[];
  /** 已点击的按钮/选项 id —— 点后禁用整组，高亮所选（一条 reply 只作答一次）。 */
  replyClickedId?: string;
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
