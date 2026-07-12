"use client";
import { useChatStore } from "../chat-store";
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

function BgTaskCard({ t }: { t: BgTaskView }) {
  const running = t.status === "running";
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
        <span className="shrink-0 opacity-30 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-3 pb-2 pt-0.5">
        {t.lines.length === 0 ? (
          <div className="py-1 text-[11px] opacity-40">等待输出…</div>
        ) : (
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-base-content/60">
            {t.lines.map(cleanLine).join("\n")}
          </pre>
        )}
      </div>
    </details>
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
