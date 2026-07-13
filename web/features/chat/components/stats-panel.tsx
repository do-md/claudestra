"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../chat-store";

/**
 * 用量/上下文看板（2026-07-14 owner：context 要成体系,web 看板可以更详细）。
 * 顶部 = 全局订阅用量(Bridge /stats);列表 = 各 agent 上下文占用条
 * (200k 参考刻度)+ 忙碌态 + 最后对话时间。侧栏 📊 进入,portal 到 body。
 */

interface GlobalStats {
  sessionPct?: number;
  sessionResets?: string;
  weekPct?: number;
  weekResets?: string;
  totalCost?: string;
  /** 账号 gauge 抓取时刻——不标年龄用户会把旧缓存当实时（owner 2026-07-14「停在 15%」） */
  scrapedAt?: number;
}

function fmtAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 90_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  return `${(ms / 3_600_000).toFixed(1)} 小时前`;
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-content/10">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function fmtRel(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}-${pad(d.getDate())}`;
}

export function StatsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useChatStore((s) => s.state.agents);
  const [g, setG] = useState<GlobalStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = (force: boolean) => {
    if (force) setRefreshing(true);
    fetch(force ? "/api/stats?refresh=1" : "/api/stats")
      .then((r) => r.json())
      .then((j: { global?: GlobalStats }) => setG(j.global ?? null))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!open) return;
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const rows = agents
    .filter((a) => typeof a.contextTokens === "number" && a.contextTokens! > 0)
    .sort((a, b) => (b.contextTokens ?? 0) - (a.contextTokens ?? 0));

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-5 pb-2 pt-4">
          <span className="text-base font-semibold">用量看板</span>
          <button
            className="btn btn-ghost btn-sm ml-auto"
            aria-label="强制刷新账号用量"
            title="强制重抓账号用量（最长约 20 秒）"
            disabled={refreshing}
            onClick={() => load(true)}
          >
            {refreshing ? <span className="loading loading-spinner loading-xs" /> : "🔄"}
          </button>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          {/* 全局订阅用量 */}
          {g && (
            <div className="mb-4 space-y-3 rounded-xl bg-base-200 p-3.5">
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-base-content/60">本时段用量</span>
                  <span className="font-mono tabular-nums">
                    {g.sessionPct ?? "?"}%
                    {g.sessionResets && <span className="ml-1.5 opacity-50">重置 {g.sessionResets}</span>}
                  </span>
                </div>
                <Bar pct={g.sessionPct ?? 0} tone={(g.sessionPct ?? 0) >= 80 ? "bg-error" : "bg-primary"} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-base-content/60">本周用量</span>
                  <span className="font-mono tabular-nums">
                    {g.weekPct ?? "?"}%
                    {g.weekResets && <span className="ml-1.5 opacity-50">重置 {g.weekResets}</span>}
                  </span>
                </div>
                <Bar pct={g.weekPct ?? 0} tone={(g.weekPct ?? 0) >= 80 ? "bg-error" : "bg-primary"} />
              </div>
              {g.totalCost && (
                <div className="flex justify-between text-xs">
                  <span className="text-base-content/60">累计成本</span>
                  <span className="font-mono tabular-nums">${g.totalCost}</span>
                </div>
              )}
              {typeof g.scrapedAt === "number" && g.scrapedAt > 0 && (
                <div className="text-[10.5px] text-base-content/35">
                  账号用量抓取于 {fmtAge(g.scrapedAt)}
                  {Date.now() - g.scrapedAt > 15 * 60_000 && " ⚠️ 数据偏旧"}
                </div>
              )}
            </div>
          )}

          {/* 各 agent 上下文占用(200k 参考刻度) */}
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-base-content/40">
            各会话上下文占用
          </div>
          <div className="space-y-3">
            {rows.map((a) => {
              const t = a.contextTokens!;
              const pct = (t / 200_000) * 100;
              const tone = t >= 170_000 ? "bg-error" : t >= 140_000 ? "bg-warning" : "bg-success";
              return (
                <div key={a.name}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs">
                    {a.busy && <span className="size-1.5 rounded-full bg-warning" />}
                    <span className="truncate">{a.displayName}</span>
                    <span className="ml-auto font-mono tabular-nums text-base-content/60">
                      {Math.round(t / 1000)}k
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-base-content/35">
                      {fmtRel(a.lastActivityTs)}
                    </span>
                  </div>
                  <Bar pct={pct} tone={tone} />
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="py-4 text-center text-xs opacity-40">暂无数据</div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
