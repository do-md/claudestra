"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatStoreProvider, useChatStore, useChatStoreApi } from "../chat-store";
import { ChatNavContext, useChatNav, type ChatNav } from "./nav-context";
import { Sidebar } from "./sidebar";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { Splash } from "./splash";
import { AgentActions } from "./agent-actions";
import { TerminalButton } from "../../terminal/terminal-button";

/** 「会话内容」页的 hash 锚点：存在即处于内容视图，移动端横滑到内容栏 */
const CONTENT_HASH = "#chat";
const isContentHash = () =>
  typeof window !== "undefined" &&
  window.location.hash.split("?")[0] === CONTENT_HASH;
/** 仅移动端（< sm 640px）走 hash 横滑；桌面双栏并存 */
const isNarrow = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 639.98px)").matches;

function TopBar() {
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
  const nav = useChatNav();
  const info = agents.find((a) => a.name === active);
  return (
    // 安全区顶部由面板自己垫（bg=base-100，条带与内容同色无缝）
    <header
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 sm:px-4"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* 移动端：返回会话列表（走 history.back 触发系统返回同款滑动）。桌面端双栏，隐藏 */}
      <button
        className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden"
        onClick={nav.toList}
        aria-label="返回会话列表"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="truncate font-semibold">
        {info?.displayName || active || "Claudestra"}
      </span>
      {info?.cwd && (
        <span className="hidden truncate font-mono text-xs opacity-50 sm:inline">
          {info.cwd}
        </span>
      )}
      {/* 右侧操作组：终端（master 也有）+ 会话操作区（清空/重启/停止，大总管不渲染）。
          ⚠ 外层统一 ml-auto 靠右——两个子组件各自 ml-auto 会均分剩余空间（auto margin
          语义），终端按钮会浮到中间。内层残留的 ml-auto 无自由空间，无害。 */}
      {info && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <TerminalButton agent={info} />
          <AgentActions agent={info} />
        </span>
      )}
    </header>
  );
}

function ChatInner() {
  const store = useChatStoreApi();
  const agents = useChatStore((s) => s.state.agents);
  const activeAgent = useChatStore((s) => s.state.activeAgent);

  // ── 移动端 hash 横滑：会话列表(基础页) ↔ 会话内容(#chat 压栈页) ──
  const [showContent, setShowContent] = useState(false);
  // 首帧禁用过渡：带 #chat 进入（如会话中刷新页面）时直接定位到内容页，
  // 不从列表滑一下（用户反馈的「进来有偏移」）。首帧定位后再开启过渡。
  // popstate（含 iOS 左滑返回）时也临时关动画避免闪屏。
  const [disableTransition, setDisableTransition] = useState(true);
  // 主动 history.back() 触发的 popstate 保留滑动动画
  const skipDisableRef = useRef(false);

  // 首帧按当前 hash 初始化定位，随后开启过渡
  useLayoutEffect(() => {
    // 带 #terminal 刷新进入：终端页状态不可恢复（termId 已随连接销毁），
    // 降级回会话内容页（#chat），避免 hash 悬空
    if (window.location.hash.split("?")[0] === "#terminal") {
      window.history.replaceState(null, "", "#chat");
    }
    setShowContent(isContentHash());
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setDisableTransition(false)),
    );
  }, []);

  // 浏览器返回（系统级手势 / 返回键）：出栈回到会话列表
  useEffect(() => {
    const onPop = () => {
      if (!skipDisableRef.current) setDisableTransition(true);
      setShowContent(isContentHash());
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setDisableTransition(false)),
      );
      skipDisableRef.current = false;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const toContent = useCallback(() => {
    if (!isNarrow()) return; // 桌面双栏并存，无需压栈/位移
    if (!isContentHash()) window.history.pushState(null, "", CONTENT_HASH);
    setShowContent(true);
  }, []);

  const toList = useCallback(() => {
    if (isContentHash()) {
      skipDisableRef.current = true; // 主动返回：保留滑动动画
      window.history.back();
    } else {
      setShowContent(false);
    }
  }, []);

  const nav = useMemo<ChatNav>(
    () => ({ showContent, toContent, toList }),
    [showContent, toContent, toList],
  );

  // 画布色跟随当前面板：列表页(base-200) / 会话页(base-100)。iOS 给安全区/布局视口外
  // 的条带涂的是 html 画布色（body 不设 bg 才轮得到 html，见 globals.css + layout.tsx），
  // 跟随后条带与所在页同色 → 列表页上下色差消失（claude-os 未解决的问题）。
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("canvas-list", !showContent);
    return () => el.classList.remove("canvas-list");
  }, [showContent]);

  // 会话恢复：iOS 把后台页整个回收重载后，URL 还带 #chat 但 store 是全新的
  // （activeAgent=""）——之前就卡在空内容页要手动返回重选（2026-07-12 真机）。
  // agents 列表首次到位后：上次会话还在 → 自动重开；不在 → 退回列表页。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || activeAgent || agents.length === 0) return;
    restoredRef.current = true;
    let saved = "";
    try { saved = localStorage.getItem("cstra_last_agent") || ""; } catch { /* 隐私模式 */ }
    if (saved && agents.some((a) => a.name === saved)) {
      void store.openAgent(saved);
    } else if (isContentHash()) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setShowContent(false);
    }
  }, [agents, activeAgent, store]);

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
    <ChatNavContext.Provider value={nav}>
      {/* PWA 应用壳（对齐 claude-os）：出流的 fixed inset-0 overflow-hidden 就是锁滚动的
          全部——body 里没有流内容 → 文档天然不滚，滚动只在内部 overflow-y-auto。⚠ 不要给
          html/body 加 overflow:hidden（会干扰 viewport-fit 撑满、底部不贴屏底，见 globals.css）。
          安全区 padding 归各面板自己垫、条带色=面板色（不放根层，避免异色面板成色差条）。
          onScroll 归零守卫：overflow:hidden 只是视觉裁剪，程序（iOS 键盘聚焦滚动 /
          scrollIntoView 类调用）仍可给它塞 scrollLeft/scrollTop——残留量会叠在横滑
          translate 上，让会话页「弹过头」渲染不满视窗。任何此类滚动立即归零。 */}
      <div
        className="fixed inset-0 flex overflow-hidden bg-base-100"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
          if (el.scrollTop !== 0) el.scrollTop = 0;
        }}
      >
        {/* 横滑容器：移动端 sidebar + main 各 w-full 并排溢出，showContent 时整体 -100% 切到内容；
            桌面端（sm+）sidebar 定宽 + main flex-1 双栏并存，translate 恒 0。 */}
        <div
          className={`flex min-h-0 w-full flex-1 transform-gpu ${
            disableTransition
              ? "transition-none"
              : "transition-transform duration-300 ease-out will-change-transform"
          } ${
            showContent
              ? "-translate-x-full sm:translate-x-0"
              : "translate-x-0"
          }`}
        >
          <Sidebar onSelect={toContent} />

          <main className="flex w-full min-w-0 shrink-0 flex-col bg-base-100 sm:w-0 sm:flex-1">
            <TopBar />
            <MessageList />
            <Composer />
          </main>
        </div>
        {/* 全屏启动页：在横滑 transform 容器之外（规则 5.5——fixed 不能在
            transform 祖先内定位），盖住整个入场加载过程 */}
        <Splash />
      </div>
    </ChatNavContext.Provider>
  );
}

export function Chat() {
  return (
    <ChatStoreProvider>
      <ChatInner />
    </ChatStoreProvider>
  );
}
