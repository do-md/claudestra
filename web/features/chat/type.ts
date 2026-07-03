export interface ToolCallView {
  name: string;
  summary: string;
  state: "running" | "done" | "error";
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
}
