"use client";
import { useEffect, useState } from "react";
import { ChatStoreProvider, useChatStore, useChatStoreApi } from "../chat-store";
import { Sidebar } from "./sidebar";
import { MessageList } from "./message-list";
import { Composer } from "./composer";

function TopBar({ onMenu }: { onMenu: () => void }) {
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
  const store = useChatStoreApi();
  const info = agents.find((a) => a.name === active);
  return (
    <header
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-base-300 px-3 sm:px-4"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* 移动端汉堡：打开会话抽屉。桌面端侧栏常驻，隐藏此按钮 */}
      <button
        className="btn btn-ghost btn-sm -ml-1 px-2 md:hidden"
        onClick={onMenu}
        aria-label="打开会话列表"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <span className="truncate font-semibold">{active || "Claudestra"}</span>
      {info?.cwd && (
        <span className="hidden truncate font-mono text-xs opacity-50 sm:inline">
          {info.cwd}
        </span>
      )}
      {active && (
        // 拉取最新历史（丢弃缓存快照，从 jsonl 重拉）——重开会话默认保持你上次看到的那份，
        // 想看最新用这个，不必整页刷新。
        <button
          className="btn btn-ghost btn-xs ml-auto px-1.5"
          onClick={() => store.reloadHistory()}
          title="拉取最新历史"
          aria-label="拉取最新历史"
        >
          ⟳
        </button>
      )}
    </header>
  );
}

function ChatInner() {
  const store = useChatStoreApi();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    store.loadAgents();
    // 回前台时若流断了则重连，并立即刷一次列表（后台期间可能有新 agent）
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        store.maybeReconnect();
        store.refreshAgents();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    // 轮询感知本端之外的 roster 变化（master/CLI/其他端 创建/kill/restart agent）——
    // 无实时事件可挂，只能轮询；仅前台，diff-guard 只在列表真变时才 re-render。
    // ⚠ 间隔受 Bridge 限流约束：web-ui token 限 30 req/min（bridge.ts SlidingWindowLimiter，
    // 每 token 独立）。这条轮询和「持久 SSE 流 + 历史 + 发送」共用同一 token 的额度，
    // 太密会把额度打爆 → Bridge 429 → BFF 转 502 → SSE 流被掐断（实时推送失效）+ 列表间歇 502。
    // 4s(=15/min) 曾把额度吃掉一半引发此故障；15s(=4/min) 留足 26/min 给交互。别再调低。
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") store.refreshAgents();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, [store]);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setDrawerOpen(true)} />
        <MessageList />
        <Composer />
      </div>
    </div>
  );
}

export function Chat() {
  return (
    <ChatStoreProvider>
      <ChatInner />
    </ChatStoreProvider>
  );
}
