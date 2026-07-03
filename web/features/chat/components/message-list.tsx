"use client";
import { useEffect, useRef } from "react";
import { useChatStore } from "../chat-store";
import type { ChatMessage, ToolCallView } from "../type";

function ToolCard({ tool }: { tool: ToolCallView }) {
  const icon =
    tool.state === "error" ? "❌" : tool.state === "running" ? "⏳" : "🔧";
  return (
    <div className="flex items-center gap-2 rounded-md bg-base-200 px-2 py-1 text-xs">
      <span>{icon}</span>
      <span className="font-mono font-medium">{tool.name}</span>
      <span className="truncate opacity-60">{tool.summary}</span>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={`chat ${isUser ? "chat-end" : "chat-start"}`}>
      <div
        className={`chat-bubble max-w-[80%] whitespace-pre-wrap break-words ${
          isUser ? "chat-bubble-primary" : "bg-base-200 text-base-content"
        }`}
      >
        {!isUser && m.toolCalls && m.toolCalls.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {m.toolCalls.map((t, i) => (
              <ToolCard key={i} tool={t} />
            ))}
          </div>
        )}
        {m.content || (isUser ? "" : <span className="opacity-40">…</span>)}
      </div>
    </div>
  );
}

export function MessageList() {
  const messages = useChatStore((s) => s.state.messages);
  const awaiting = useChatStore((s) => s.state.awaitingChunk);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const active = useChatStore((s) => s.state.activeAgent);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, awaiting]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 opacity-50">
        <p className="text-lg">选择左侧一个会话开始</p>
        <p className="text-sm">消息经 Bridge 投递到对应 Claude Code 会话</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {loadingHistory && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm opacity-40">
            <span className="loading loading-spinner loading-sm" />
            加载历史消息…
          </div>
        )}
        {!loadingHistory && messages.length === 0 && (
          <div className="py-8 text-center text-sm opacity-40">
            向 {active} 发送第一条消息
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {awaiting && (
          <div className="chat chat-start">
            <div className="chat-bubble bg-base-200">
              <span className="loading loading-dots loading-sm" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
