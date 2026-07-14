"use client";
import { useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { SettingsModal } from "./settings-modal";
import { InstallBanner } from "./install-banner";
import { StatsPanel } from "./stats-panel";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";

function StatusDot({ status, busy }: { status: AgentSession["status"]; busy?: boolean }) {
  if (status === "active") {
    // 运行中：实心核心点 + 柔和呼吸外晕（cstra-breathe，替换生硬的 animate-ping）。
    // 正在干活（tmux 非空闲 / 本端流式中）→ 黄色；空闲 → 绿色。
    const tone = busy ? "bg-warning" : "bg-success";
    return (
      <span className="relative flex size-2.5 shrink-0 items-center justify-center">
        <span className={`animate-cstra-breathe absolute inline-flex size-2.5 rounded-full ${tone}`} />
        <span className={`relative inline-flex size-2 rounded-full ${tone}`} />
      </span>
    );
  }
  return (
    <span className="inline-flex size-2.5 shrink-0 rounded-full bg-base-content/25" />
  );
}

/** 最近对话时间：当天 HH:mm，昨天，今年 M-D，跨年 YYYY-M-D。 */
function fmtLastActive(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${pad(d.getDate())}`;
}

/**
 * 会话列表行——纯选择项。会话操作（清空/重启/停止）已迁到会话详情顶栏
 * （agent-actions.tsx），列表保持干净。
 */
function AgentRow({
  a,
  active,
  busyLive,
  onSelect,
}: {
  a: AgentSession;
  active: boolean;
  /** 本端正在流式对话（active agent 的实时忙碌,比 15s 轮询的 busy 快） */
  busyLive: boolean;
  onSelect: () => void;
}) {
  const store = useChatStoreApi();
  const lastAt = fmtLastActive(a.lastActivityTs);
  // ctx 用量背景条（owner 2026-07-14:用量看板藏太深,列表行内直接可视化）:
  // 行背景自左向右填充,宽=占 1M 窗口比例;色阶同顶栏 ctx 徽章
  // (≥750k 深红 / ≥500k 红 / ≥200k 黄 / 其余中性淡灰),平时几乎隐形,超标一眼看见。
  const ctx = a.status === "active" && typeof a.contextTokens === "number" ? a.contextTokens : 0;
  const ctxPct = Math.min(100, Math.round((ctx / CTX_WINDOW) * 100));
  const ctxTone = {
    deep: "bg-error/35",
    high: "bg-error/15",
    mid: "bg-warning/15",
    none: "bg-base-content/[0.05]",
  }[ctxLevel(ctx)];

  return (
    <li>
      <div
        className={`relative flex items-center gap-2.5 overflow-hidden rounded-lg px-2 py-2.5 sm:gap-2 sm:py-1.5 ${
          active ? "bg-base-300" : "hover:bg-base-300/60"
        }`}
      >
        {ctx > 0 && (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 ${ctxTone}`}
            style={{ width: `${ctxPct}%` }}
          />
        )}
        <button
          className="relative flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-2"
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
            <StatusDot status={a.status} busy={a.busy || busyLive} />
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
          {lastAt && (
            <span className="shrink-0 pl-1 font-mono text-[11px] tabular-nums text-base-content/35">
              {lastAt}
            </span>
          )}
        </button>
      </div>
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
  const ready = useChatStore((s) => s.state.agentsReady);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  // agent 搜索（2026-07-13 owner）：名称/用途 大小写不敏感即时过滤，纯前端
  const [query, setQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter((a) => `${a.displayName} ${a.name} ${a.purpose}`.toLowerCase().includes(q))
    : agents;

  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-base-300 bg-base-200 sm:w-64">
      {/* 安全区顶部由面板自己垫（bg=base-200，条带与列表同色无缝）。
          刷新按钮已移除（列表由 15s 轮询 + 回前台重连自动感知 roster 变化）；
          新建会话统一走大总管对话，Web 侧不再单独提供入口。 */}
      <div
        className="px-4 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <div className="flex items-center pb-2.5">
          <span className="font-semibold">会话</span>
          <button
            className="ml-auto flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title="用量看板"
            aria-label="用量看板"
            onClick={() => setShowStats(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v16a2 2 0 0 0 2 2h16" />
              <path d="M7 13v4" />
              <path d="M12 9v8" />
              <path d="M17 5v12" />
            </svg>
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title="设置"
            aria-label="设置"
            onClick={() => setShowSettings(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <label className="flex items-center gap-2 rounded-lg bg-base-300/60 px-2.5 py-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 opacity-40">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-base-content/35 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              className="shrink-0 text-xs text-base-content/40"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              ✕
            </button>
          )}
        </label>
      </div>

      {/* 添加到主屏幕引导（浏览器标签页访问且未 dismiss 时显示） */}
      <InstallBanner />

      {/* touch-pan-y + overscroll-contain：iOS 到边界时滚动链会穿透到不可滚的
          fixed 应用壳，橡皮筋吃掉手势看着像「滑不动」（BgLines 同款修法）。 */}
      <div
        className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 pb-3"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {/* 首拉未完成（!ready）时绝不显示「暂无会话」——SSR 首帧就渲染空态
            是入场卡顿的观感元凶（2026-07-13）；入场期由全屏 Splash 盖住。 */}
        {(!ready || loading) && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">加载中…</div>
        )}
        {ready && !loading && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">暂无会话</div>
        )}
        {agents.length > 0 && filtered.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">没有匹配「{query.trim()}」的会话</div>
        )}
        {/* 不用 daisyUI menu 类——它给每行自带 :hover/:active 按压高亮，iOS 上
            手指一碰就闪（滑动时「一直触发 hover 特效」，2026-07-13 真机）；
            行样式本来就是自定义的。 */}
        <ul className="flex w-full list-none flex-col gap-0.5 p-0">
          {filtered.map((a) => (
            <AgentRow
              key={a.name}
              a={a}
              active={active === a.name}
              busyLive={active === a.name && streaming}
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
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      <StatsPanel open={showStats} onClose={() => setShowStats(false)} />
    </aside>
  );
}
