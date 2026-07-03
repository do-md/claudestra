"use client";
import { useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { NewAgentModal } from "./new-agent-modal";

function StatusDot({ status }: { status: AgentSession["status"] }) {
  if (status === "active") {
    return (
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex size-2.5 rounded-full bg-success" />
      </span>
    );
  }
  return <span className="inline-flex size-2.5 rounded-full bg-base-content/25" />;
}

function AgentRow({ a, active }: { a: AgentSession; active: boolean }) {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState<"" | "kill" | "restart">("");
  const [error, setError] = useState("");

  const act = async (
    e: React.MouseEvent,
    action: "kill" | "restart"
  ) => {
    e.stopPropagation();
    if (busy || a.mock) return;
    setBusy(action);
    setError("");
    const res =
      action === "kill"
        ? await store.killAgent(a.name)
        : await store.restartAgent(a.name);
    setBusy("");
    if (!res.ok) setError(res.error || `${action} 失败`);
  };

  return (
    <li className="group">
      <div
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
          active ? "bg-base-300" : "hover:bg-base-300/60"
        }`}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => store.openAgent(a.name)}
        >
          <StatusDot status={a.status} />
          <span className="min-w-0 flex-1 truncate">
            {a.displayName}
            {a.mock && (
              <span className="badge badge-ghost badge-xs ml-1 align-middle">
                mock
              </span>
            )}
          </span>
        </button>

        {!a.mock && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              className="btn btn-ghost btn-xs px-1"
              title="重启"
              onClick={(e) => act(e, "restart")}
              disabled={busy !== ""}
            >
              {busy === "restart" ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                "↻"
              )}
            </button>
            {a.status === "active" && (
              <button
                className="btn btn-ghost btn-xs px-1 text-error"
                title="停止"
                onClick={(e) => act(e, "kill")}
                disabled={busy !== ""}
              >
                {busy === "kill" ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  "⏹"
                )}
              </button>
            )}
          </span>
        )}
      </div>
      {error && (
        <div className="px-2 pb-1 text-xs text-error break-words">{error}</div>
      )}
    </li>
  );
}

export function Sidebar() {
  const agents = useChatStore((s) => s.state.agents);
  const loading = useChatStore((s) => s.state.loadingAgents);
  const active = useChatStore((s) => s.state.activeAgent);
  const store = useChatStoreApi();
  const [showNew, setShowNew] = useState(false);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-base-300 bg-base-200">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold">会话</span>
        <div className="flex items-center gap-1">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => store.loadAgents()}
            title="刷新"
          >
            ↻
          </button>
          <button
            className="btn btn-primary btn-xs"
            onClick={() => setShowNew(true)}
            title="新建会话"
          >
            + 新建
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {loading && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">加载中…</div>
        )}
        {!loading && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">暂无会话</div>
        )}
        <ul className="menu w-full gap-0.5 p-0">
          {agents.map((a) => (
            <AgentRow key={a.name} a={a} active={active === a.name} />
          ))}
        </ul>
      </div>

      <div className="border-t border-base-300 px-4 py-2 text-xs opacity-50">
        Claudestra Web
      </div>

      <NewAgentModal open={showNew} onClose={() => setShowNew(false)} />
    </aside>
  );
}
