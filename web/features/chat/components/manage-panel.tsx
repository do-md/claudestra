"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { NewAgentModal } from "./new-agent-modal";

/**
 * Agent 管理面板（2026-07-14 owner：大总管做成「聊天 + UI」双轨——能点按钮
 * 解决的生命周期操作不必经过 LLM）。大总管会话顶栏「管理」进入。
 * 复用 store 的 createAgent/restartAgent/killAgent(本就是 LLM-free 的 BFF 直调);
 * 破坏性操作用行内二次确认(点一下变「确认?」,3s 复原),不弹系统框。
 */
export function ManagePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useChatStore((s) => s.state.agents);
  const store = useChatStoreApi();
  const [showNew, setShowNew] = useState(false);
  /** 待二次确认的操作 key:`restart:<name>` / `kill:<name>` */
  const [arming, setArming] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [msg, setMsg] = useState("");

  if (!open) return null;

  const arm = (key: string) => {
    setArming(key);
    setTimeout(() => setArming((v) => (v === key ? "" : v)), 3000);
  };
  const run = async (kind: "restart" | "kill", name: string) => {
    const key = `${kind}:${name}`;
    setArming("");
    setBusyKey(key);
    setMsg("");
    const r = kind === "restart" ? await store.restartAgent(name) : await store.killAgent(name);
    setBusyKey("");
    setMsg(r.ok ? `${name} ${kind === "restart" ? "已重启" : "已停止"}` : r.error || "操作失败");
  };

  const rows = agents.filter((a) => !a.pinnedMaster);

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">Agent 管理</span>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
              ＋ 新建
            </button>
            <button className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        {msg && <div className="px-5 pb-1 text-xs text-base-content/60">{msg}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          <ul className="space-y-1">
            {rows.map((a) => {
              const rk = `restart:${a.name}`;
              const kk = `kill:${a.name}`;
              return (
                <li key={a.name} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-base-200">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      a.status === "stopped" ? "bg-base-content/25" : a.busy ? "bg-warning" : "bg-success"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.displayName}</div>
                    {a.purpose && (
                      <div className="truncate text-[11px] text-base-content/40">{a.purpose}</div>
                    )}
                  </div>
                  {typeof a.contextTokens === "number" && a.contextTokens >= 100_000 && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-base-content/40">
                      {Math.round(a.contextTokens / 1000)}k
                    </span>
                  )}
                  <button
                    className={`btn btn-xs shrink-0 ${arming === rk ? "btn-warning" : "btn-ghost"}`}
                    disabled={busyKey !== ""}
                    onClick={() => (arming === rk ? void run("restart", a.name) : arm(rk))}
                  >
                    {busyKey === rk ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : arming === rk ? (
                      "确认重启?"
                    ) : (
                      "重启"
                    )}
                  </button>
                  {a.status !== "stopped" && (
                    <button
                      className={`btn btn-xs shrink-0 ${arming === kk ? "btn-error" : "btn-ghost text-error/70"}`}
                      disabled={busyKey !== ""}
                      onClick={() => (arming === kk ? void run("kill", a.name) : arm(kk))}
                    >
                      {busyKey === kk ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : arming === kk ? (
                        "确认停止?"
                      ) : (
                        "停止"
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <NewAgentModal open={showNew} onClose={() => setShowNew(false)} />
    </div>,
    document.body
  );
}
