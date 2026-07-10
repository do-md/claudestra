"use client";
import { useEffect, useRef } from "react";
import { useChatStore } from "../chat-store";
import type { ChatMessage, ChatAttachmentView, ToolCallView } from "../type";
import { Domd } from "@/components/domd";
import { PermissionCard } from "./permission-card";
import { AskQuestionCard } from "./ask-question-card";

function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** formatTool 的 Bash 摘要用 ||command|| 包裹命令，展示时去掉这对标记。 */
function cleanSummary(s: string): string {
  return s.replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 工具调用卡：可展开（<details>）。摘要本身自带 emoji+工具名+参数（formatTool），
 * 折叠行截断单行，展开看完整摘要（长路径/命令）。
 * 注：当前实时流只有「段级摘要」，完整入参/结果需后端补事件字段后再填。
 */
function ToolCard({ tool }: { tool: ToolCallView }) {
  const full = cleanSummary(tool.summary) || tool.name;
  return (
    <details className="group rounded-md bg-base-100/60 [&>summary]:list-none">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs">
        {tool.state === "running" ? (
          <span className="loading loading-spinner loading-xs shrink-0" />
        ) : tool.state === "error" ? (
          <span className="shrink-0">❌</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono opacity-75">
          {full}
        </span>
        <span className="shrink-0 opacity-30 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="border-t border-base-300/50 px-2 py-1.5">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">
          {full}
        </pre>
      </div>
    </details>
  );
}

/** 用户气泡里的上传附件回显：图片缩略图 / 文件名 chip。 */
function AttachmentStrip({ items }: { items: ChatAttachmentView[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {items.map((a, i) =>
        a.kind === "image" && a.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={a.url}
            alt={a.name}
            className="max-h-40 max-w-[12rem] rounded-lg object-cover"
          />
        ) : (
          <span
            key={i}
            className="flex items-center gap-1 rounded-md bg-base-100/30 px-2 py-1 text-xs"
          >
            📎 <span className="max-w-[10rem] truncate">{a.name}</span>
          </span>
        )
      )}
    </div>
  );
}

/** 助手正文：流式进行中用纯文本（DOMD initMd 只读一次不适合增量喂字），定稿/历史走 DOMD 富文本。 */
function AssistantContent({ m }: { m: ChatMessage }) {
  if (m.streamed) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {m.content || <span className="opacity-40">…</span>}
      </div>
    );
  }
  if (!m.content) return null;
  return <Domd initMd={m.content} bodyClassName="chat-domd" />;
}

function Bubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={`chat ${isUser ? "chat-end" : "chat-start"}`}>
      {isUser && m.from && (
        <div className="chat-header mb-0.5 text-[10px] opacity-50">{m.from}</div>
      )}
      <div
        className={`chat-bubble max-w-[85%] break-words ${
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
        {isUser ? (
          <>
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentStrip items={m.attachments} />
            )}
            {m.content && (
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
            )}
          </>
        ) : (
          <AssistantContent m={m} />
        )}
      </div>
      {m.ts && (
        <div className="chat-footer mt-0.5 text-[10px] opacity-40">
          {fmtTime(m.ts)}
        </div>
      )}
    </div>
  );
}

export function MessageList() {
  const messages = useChatStore((s) => s.state.messages);
  const awaiting = useChatStore((s) => s.state.awaitingChunk);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const active = useChatStore((s) => s.state.activeAgent);
  const pendingPermission = useChatStore((s) => s.state.pendingPermission);
  const pendingAsk = useChatStore((s) => s.state.pendingAsk);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, awaiting, pendingPermission, pendingAsk]);

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
        {pendingPermission && <PermissionCard p={pendingPermission} />}
        {pendingAsk && <AskQuestionCard a={pendingAsk} />}
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
