"use client";
import { memo, useEffect, useRef } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { BgTaskView } from "../type";

/**
 * 后台任务（subagent / bg shell）跟踪面板 —— Discord 子区在 web 的对应物。
 * 每个任务一张可折叠卡：running 时转圈、done 时 ✓+时长；展开看流式进度行。
 * subagent 行带 markdown 前缀（-# 🔧 / 💬），shell 行是原始输出。
 */

const KIND_ICON = { subagent: "🧵", shell: "💻" } as const;

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  const m = ms / 60_000;
  if (m >= 1) return `${m.toFixed(1)}min`;
  return `${Math.round(ms / 1000)}s`;
}

/** subagent 行去掉 Discord 的 `-# ` 小字前缀；shell 行原样。 */
function cleanLine(s: string): string {
  return s.replace(/^-#\s+/, "");
}

// memo：bg-update 事件只替换被更新任务的对象引用（immer），其余卡不重渲染
const BgTaskCard = memo(function BgTaskCard({ t }: { t: BgTaskView }) {
  const running = t.status === "running";
  const store = useChatStoreApi();
  return (
    <details className="group rounded-lg border border-warning/25 bg-warning/[0.06] [&>summary]:list-none" open={running}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-xs">
        <span className="shrink-0">{KIND_ICON[t.kind]}</span>
        <span className="truncate font-medium text-warning/90 max-w-[55vw] lg:max-w-[30vw]">
          {t.title || (t.kind === "shell" ? "后台命令" : "subagent")}
        </span>
        {running ? (
          <span className="loading loading-spinner loading-xs ml-1 text-warning" />
        ) : (
          <span className="ml-1 shrink-0 text-success">✓ {fmtDuration(t.durationMs)}</span>
        )}
        {t.lines.length > 0 && (
          <span className="ml-auto shrink-0 opacity-40">{t.lines.length} 行</span>
        )}
        {/* 停止 = 请 agent 用 TaskStop(bridge 无 kill 权柄);✕ = 收起卡片(纯前端)。
            preventDefault 防触发 details 开合 */}
        {running && (
          <button
            className="shrink-0 rounded px-1 text-error/70 hover:bg-error/10"
            title="请求 agent 停止此任务"
            aria-label="停止任务"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              store.requestStopBgTask(t);
            }}
          >
            ⏹
          </button>
        )}
        <button
          className="shrink-0 rounded px-1 opacity-40 hover:bg-base-content/10 hover:opacity-80"
          title="收起"
          aria-label="收起任务卡"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            store.dismissBgTask(t.id);
          }}
        >
          ✕
        </button>
        <span className="shrink-0 opacity-30 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-3 pb-2 pt-0.5">
        {t.lines.length === 0 ? (
          <div className="py-1 text-[11px] opacity-40">等待输出…</div>
        ) : (
          <BgLines lines={t.lines} />
        )}
      </div>
    </details>
  );
});

/**
 * 进度行视口：固定高度内滚动（不撑开页面），新行吸底跟随（像 tail -f）,
 * 用户上翻离底 >30px 就不打扰、回底恢复。overscroll-contain 防滚动链
 * 穿透到消息列表（iOS 嵌套滚动）。
 */
function BgLines({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
      className="max-h-48 touch-pan-y overflow-y-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-base-content/60"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      {lines.map(cleanLine).join("\n")}
    </pre>
  );
}

export function BgTaskPanel() {
  const tasks = useChatStore((s) => s.state.bgTasks);
  if (!tasks.length) return null;
  // running 排前，其余按到达序
  const ordered = [...tasks].sort((a, b) => {
    if (a.status === b.status) return 0;
    return a.status === "running" ? -1 : 1;
  });
  return (
    <div className="mb-[22px] flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/35">
        <span>后台任务</span>
        <span className="opacity-60">{tasks.length}</span>
      </div>
      {ordered.map((t) => (
        <BgTaskCard key={t.id} t={t} />
      ))}
    </div>
  );
}
