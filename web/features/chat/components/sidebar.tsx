"use client";
import { useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";

function StatusDot({ status }: { status: AgentSession["status"] }) {
  if (status === "active") {
    // 运行中：实心核心点 + 柔和呼吸外晕（cstra-breathe，替换生硬的 animate-ping）
    return (
      <span className="relative flex size-2.5 shrink-0 items-center justify-center">
        <span className="animate-cstra-breathe absolute inline-flex size-2.5 rounded-full bg-success" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-2.5 shrink-0 rounded-full bg-base-content/25" />
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

/** 停止：电源符号（关闭该 agent，语义比「■」更贴切） */
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

function AgentRow({
  a,
  active,
  onSelect,
}: {
  a: AgentSession;
  active: boolean;
  onSelect: () => void;
}) {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState<"" | "kill" | "restart">("");
  const [error, setError] = useState("");

  const act = async (
    e: React.MouseEvent,
    action: "kill" | "restart"
  ) => {
    e.stopPropagation();
    if (busy || a.mock || a.pinnedMaster) return;
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
        className={`flex items-center gap-2.5 rounded-lg px-2 py-2.5 sm:gap-2 sm:py-1.5 ${
          active ? "bg-base-300" : "hover:bg-base-300/60"
        }`}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-2"
          onClick={() => {
            store.openAgent(a.name);
            onSelect();
          }}
        >
          {a.pinnedMaster ? (
            <span className="text-base sm:text-sm" title="大总管（总控）">
              👑
            </span>
          ) : (
            <StatusDot status={a.status} />
          )}
          <span className="min-w-0 flex-1 truncate text-[15px] sm:text-sm">
            {a.displayName}
            {a.pinnedMaster && (
              <span className="badge badge-primary badge-xs ml-1 align-middle">
                总控
              </span>
            )}
            {a.mock && (
              <span className="badge badge-ghost badge-xs ml-1 align-middle">
                mock
              </span>
            )}
          </span>
        </button>

        {!a.mock && !a.pinnedMaster && (
          // 触控设备无 hover，<sm 强制常显（max-sm:opacity-100）+ 加大触控尺寸
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100">
            <button
              className="btn btn-ghost btn-sm px-1.5 text-base-content/60 hover:text-base-content sm:btn-xs"
              title="重启"
              aria-label="重启"
              onClick={(e) => act(e, "restart")}
              disabled={busy !== ""}
            >
              {busy === "restart" ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <RestartIcon />
              )}
            </button>
            {a.status === "active" && (
              <button
                className="btn btn-ghost btn-sm px-1.5 text-base-content/60 hover:text-error sm:btn-xs"
                title="停止"
                aria-label="停止"
                onClick={(e) => act(e, "kill")}
                disabled={busy !== ""}
              >
                {busy === "kill" ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <PowerIcon />
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

/**
 * 会话列表面板。移动端是全屏「菜单」（w-full，横滑容器的基础页）；桌面端定宽常驻左栏（sm:w-64）。
 * onSelect：选中会话后回调（移动端 = 横滑到内容页 toContent；桌面端空转）。
 */
export function Sidebar({ onSelect }: { onSelect: () => void }) {
  const agents = useChatStore((s) => s.state.agents);
  const loading = useChatStore((s) => s.state.loadingAgents);
  const active = useChatStore((s) => s.state.activeAgent);

  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-base-300 bg-base-200 sm:w-64">
      {/* 安全区顶部由面板自己垫（bg=base-200，条带与列表同色无缝）。
          刷新按钮已移除（列表由 15s 轮询 + 回前台重连自动感知 roster 变化）；
          新建会话统一走大总管对话，Web 侧不再单独提供入口。 */}
      <div
        className="flex items-center px-4 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <span className="font-semibold">会话</span>
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
            <AgentRow
              key={a.name}
              a={a}
              active={active === a.name}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>

      {/* 底部安全区：max() 取大不叠加——home 条区高度只算一次，不再「env+间距」双层 */}
      <div
        className="border-t border-base-300 px-4 pt-2 text-xs opacity-50"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
      >
        Claudestra Web
      </div>
    </aside>
  );
}
