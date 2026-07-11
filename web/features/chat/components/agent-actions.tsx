"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { ClearAgentModal } from "./clear-agent-modal";

/** 清空：橡皮擦（lucide eraser，比扫帚干净利落） */
function EraserIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  );
}

/** 重启：循环箭头（refresh） */
function RestartIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** 停止：电源符号（关闭该 agent） */
function PowerIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v9" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </svg>
  );
}

/**
 * 会话详情顶栏右侧的操作区（清空 / 重启 / 停止）。
 * - 大总管不渲染任何操作（clear 底层能力保留，UI 不放；生命周期归 launcher）。
 * - 清空：仅 active 时可用（要有活着的 TUI 才能打 /clear）→ 确认弹窗（开机指令）。
 * - 停止：仅 active 时显示；重启恒显。
 */
export function AgentActions({ agent }: { agent: AgentSession }) {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState<"" | "kill" | "restart">("");
  const [error, setError] = useState("");
  const [showClear, setShowClear] = useState(false);

  if (agent.pinnedMaster || agent.mock) return null;

  const act = async (action: "kill" | "restart") => {
    if (busy) return;
    setBusy(action);
    setError("");
    const res =
      action === "kill"
        ? await store.killAgent(agent.name)
        : await store.restartAgent(agent.name);
    setBusy("");
    if (!res.ok) setError(res.error || `${action} 失败`);
  };

  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {error && (
        <span className="mr-1 max-w-40 truncate text-xs text-error" title={error}>
          {error}
        </span>
      )}
      {agent.status === "active" && (
        <button
          className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-warning"
          title="清空会话（/clear + 开机指令）"
          aria-label="清空会话"
          onClick={() => setShowClear(true)}
          disabled={busy !== ""}
        >
          <EraserIcon />
        </button>
      )}
      <button
        className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content"
        title="重启"
        aria-label="重启"
        onClick={() => act("restart")}
        disabled={busy !== ""}
      >
        {busy === "restart" ? (
          <span className="loading loading-spinner loading-xs" />
        ) : (
          <RestartIcon />
        )}
      </button>
      {agent.status === "active" && (
        <button
          className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-error"
          title="停止"
          aria-label="停止"
          onClick={() => act("kill")}
          disabled={busy !== ""}
        >
          {busy === "kill" ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <PowerIcon />
          )}
        </button>
      )}

      {showClear && (
        <ClearAgentModal agent={agent} onClose={() => setShowClear(false)} />
      )}
    </span>
  );
}
