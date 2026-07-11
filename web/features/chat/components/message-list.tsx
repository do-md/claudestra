"use client";
import { useEffect, useRef } from "react";
import { useChatStore } from "../chat-store";
import type { ChatMessage, ChatAttachmentView, ToolCallView } from "../type";
import { Domd } from "@/components/domd";
import { PermissionCard } from "./permission-card";
import { AskQuestionCard } from "./ask-question-card";

/* 复刻 Claude OS features/chat 的对话观感：assistant 全宽 + ✦ Claude 头，
   user 右对齐圆角矩形，工具调用 active（转圈）/ history（可展开）两态。
   配色走 daisyUI token 跟随明暗主题：✦ 头用 accent，工具活动用 info。 */

const TOOL_ICONS: Record<string, string> = {
  Read: "📄",
  Write: "📝",
  Edit: "✏️",
  Bash: "💻",
  Grep: "🔍",
  Glob: "📂",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "📋",
  Skill: "⚡",
  WebFetch: "🌐",
  WebSearch: "🌐",
};
const toolIcon = (n: string) => TOOL_ICONS[n] || "🔧";

/** formatTool 的 Bash 摘要用 ||command|| 包裹命令，展示时去掉这对标记。 */
function cleanSummary(s: string): string {
  return s.replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
}

/** 流式期间的工具行：紧凑单行，最后一个转圈。 */
function ActiveToolRow({ tool, active }: { tool: ToolCallView; active: boolean }) {
  const summary = cleanSummary(tool.summary);
  return (
    <div className="flex items-center gap-1.5 py-0.5 font-mono text-xs">
      {active && tool.state === "running" ? (
        <span className="loading loading-spinner loading-xs text-info" />
      ) : tool.state === "error" ? (
        <span className="shrink-0">❌</span>
      ) : (
        <span className="shrink-0 opacity-60">{toolIcon(tool.name)}</span>
      )}
      <span className="font-semibold text-info">{tool.name}</span>
      {summary && (
        <span className="truncate text-base-content/50 max-w-[60vw] lg:max-w-[40vw]">
          {summary}
        </span>
      )}
    </div>
  );
}

/** 历史 / 定稿后的工具行：可展开看完整摘要。 */
function HistoryToolRow({ tool }: { tool: ToolCallView }) {
  const summary = cleanSummary(tool.summary);
  return (
    <details className="group rounded-lg border border-info/25 bg-info/[0.06] [&>summary]:list-none">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 font-mono text-xs">
        <span className="shrink-0 opacity-70">
          {tool.state === "error" ? "❌" : toolIcon(tool.name)}
        </span>
        <span className="font-semibold text-info">{tool.name}</span>
        {summary && (
          <span className="truncate text-base-content/50 max-w-[60vw] lg:max-w-[40vw]">
            {summary.slice(0, 80)}
          </span>
        )}
        <span className="ml-auto shrink-0 opacity-30 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="px-2.5 pb-2 pt-0.5">
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] text-base-content/50">
          {summary || tool.name}
        </pre>
      </div>
    </details>
  );
}

function ToolCallsBlock({
  tools,
  streamingLast,
}: {
  tools: ToolCallView[];
  streamingLast: boolean;
}) {
  return (
    <div className="mb-2 space-y-1">
      {tools.map((t, i) =>
        streamingLast ? (
          <ActiveToolRow key={i} tool={t} active={i === tools.length - 1} />
        ) : (
          <HistoryToolRow key={i} tool={t} />
        )
      )}
    </div>
  );
}

/** 流式「思考中」三点。 */
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 py-1.5">
      {[0, 0.2, 0.4].map((d) => (
        <span
          key={d}
          className="chat-dot size-1.5 rounded-full bg-base-content/45"
          style={{ animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}

/** ✦ Claude 头（assistant 消息 / 独立思考态共用）。 */
function ClaudeHeader() {
  return (
    <div className="mb-[9px] flex items-center gap-2">
      <span className="flex size-[21px] items-center justify-center rounded-md bg-accent text-[11px] text-white">
        ✦
      </span>
      <span className="text-xs font-semibold text-base-content/60">Claude</span>
    </div>
  );
}

/** 用户气泡里的上传附件回显：图片缩略图 / 文件名 chip。 */
function AttachmentStrip({ items }: { items: ChatAttachmentView[] }) {
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {items.map((a, i) =>
        a.kind === "image" && a.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={a.url}
            alt={a.name}
            className="max-h-52 max-w-[220px] rounded-[12px] border border-base-content/10 object-cover"
          />
        ) : (
          <span
            key={i}
            title={a.name}
            className="flex max-w-[220px] items-center gap-2 rounded-[12px] border border-base-content/10 bg-base-300 px-3 py-2 text-[12.5px] text-base-content/80"
          >
            📎 <span className="truncate">{a.name}</span>
          </span>
        )
      )}
    </div>
  );
}

/** 助手正文：流式进行中用纯文本（DOMD 只读一次不适合增量喂字），定稿/历史走 DOMD 富文本。 */
function AssistantBody({
  m,
  liveEmpty,
}: {
  m: ChatMessage;
  liveEmpty: boolean;
}) {
  if (m.streamed) {
    if (liveEmpty) return <ThinkingDots />;
    return (
      <div className="whitespace-pre-wrap break-words text-[14.5px] leading-[1.7]">
        {m.content || <span className="opacity-40">…</span>}
      </div>
    );
  }
  if (!m.content) return null;
  return <Domd initMd={m.content} bodyClassName="chat-domd" />;
}

function Message({
  m,
  streaming,
  isLast,
  awaiting,
}: {
  m: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  awaiting: boolean;
}) {
  if (m.role === "user") {
    const atts = m.attachments ?? [];
    return (
      <div className="chat-msg-in mb-[22px] flex flex-col items-end gap-2">
        {m.from && (
          <div className="pr-1 text-[10px] opacity-50">{m.from}</div>
        )}
        {atts.length > 0 && <AttachmentStrip items={atts} />}
        {m.content && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[15px_15px_4px_15px] border border-base-content/5 bg-base-300 px-[15px] py-[11px] text-[14.5px] leading-[1.6] text-base-content/90">
            {m.content}
          </div>
        )}
      </div>
    );
  }

  // assistant
  const streamingLast = streaming && isLast;
  const liveEmpty = streamingLast && awaiting && !m.content;
  return (
    <div className="chat-msg-in mb-[22px] w-full">
      <ClaudeHeader />
      {!!m.toolCalls?.length && (
        <ToolCallsBlock tools={m.toolCalls} streamingLast={streamingLast} />
      )}
      <AssistantBody m={m} liveEmpty={liveEmpty} />
    </div>
  );
}

export function MessageList() {
  const messages = useChatStore((s) => s.state.messages);
  const awaiting = useChatStore((s) => s.state.awaitingChunk);
  const streaming = useChatStore((s) => s.state.streaming);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const active = useChatStore((s) => s.state.activeAgent);
  const pendingPermission = useChatStore((s) => s.state.pendingPermission);
  const pendingAsk = useChatStore((s) => s.state.pendingAsk);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 滚到底部：直接设本滚动容器的 scrollTop，不用 scrollIntoView——后者会同时滚动
  // 「所有可滚祖先、双轴」，包括 overflow:hidden 的应用壳根（视觉裁剪但可被程序滚动）。
  // 移动端横滑动画进行中历史恰好落地时，scrollIntoView 会给根容器塞 scrollLeft 把
  // 半途的锚点「拉进来」，残留量叠在 translate -100% 上 → 会话页越过目标位、渲染不满视窗
  // （owner 真机截图 2026-07-11）。scrollTop 只动纵轴、只动本容器，无此副作用。
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, awaiting, pendingPermission, pendingAsk]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 opacity-50">
        <p className="text-lg">选择左侧一个会话开始</p>
        <p className="text-sm">消息经 Bridge 投递到对应 Claude Code 会话</p>
      </div>
    );
  }

  // 首个 chunk 到达前（last 还是用户气泡）单独渲染一条 ✦ Claude + 思考点；
  // 若最后一条已是流式助手，思考点由该消息内部（liveEmpty）渲染，此处不重复。
  const last = messages[messages.length - 1];
  const standaloneThinking =
    awaiting && !(last && last.role === "assistant" && last.streamed);

  return (
    <div ref={scrollerRef} className="flex-1 overflow-y-auto">
      {/* 横向留白对齐 claude-os thread（px-7=28px + 居中限宽），手机端稍收到 24px，
          原 px-4(16px) 太满不透气（owner 反馈）。滚动条落在最外层边缘更干净。 */}
      <div className="mx-auto flex max-w-3xl flex-col px-6 pb-4 pt-6 sm:px-7">
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
        {messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            streaming={streaming}
            isLast={i === messages.length - 1}
            awaiting={awaiting}
          />
        ))}
        {pendingPermission && <PermissionCard p={pendingPermission} />}
        {pendingAsk && <AskQuestionCard a={pendingAsk} />}
        {standaloneThinking && (
          <div className="chat-msg-in mb-[22px] w-full">
            <ClaudeHeader />
            <ThinkingDots />
          </div>
        )}
      </div>
    </div>
  );
}
