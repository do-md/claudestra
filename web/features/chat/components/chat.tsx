"use client";
import { useEffect, useState } from "react";
import { ChatStoreProvider, useChatStore, useChatStoreApi } from "../chat-store";
import { Sidebar } from "./sidebar";
import { MessageList } from "./message-list";
import { Composer } from "./composer";

function TopBar({ onMenu }: { onMenu: () => void }) {
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
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
    </header>
  );
}

function ChatInner() {
  const store = useChatStoreApi();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    store.loadAgents();
    // 回前台时若流断了则重连
    const onVisible = () => {
      if (document.visibilityState === "visible") store.maybeReconnect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
