"use client";
import { useEffect } from "react";
import { ChatStoreProvider, useChatStore, useChatStoreApi } from "../chat-store";
import { Sidebar } from "./sidebar";
import { MessageList } from "./message-list";
import { Composer } from "./composer";

function TopBar() {
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
  const info = agents.find((a) => a.name === active);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-base-300 px-4">
      <span className="font-semibold">{active || "Claudestra"}</span>
      {info?.cwd && (
        <span className="truncate font-mono text-xs opacity-50">{info.cwd}</span>
      )}
    </header>
  );
}

function ChatInner() {
  const store = useChatStoreApi();

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
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
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
