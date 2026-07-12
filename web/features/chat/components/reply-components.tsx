"use client";
import { useState } from "react";
import type { ChatMessage } from "../type";
import type { WebComponentRow } from "@/lib/chat/events";
import { useChatStoreApi } from "../chat-store";

/**
 * reply() 附带的交互组件（按钮 / 选单）Web 渲染。点击 → 回投
 * [button:<id>] / [select:<id>:<value>] 给 agent（与 Discord 侧语义一致），
 * 展示气泡用人类可读 label。一条 reply 只作答一次：点后整组禁用、高亮所选。
 */

const BTN_STYLE: Record<string, string> = {
  primary: "btn-primary",
  success: "btn-success",
  danger: "btn-error",
  secondary: "btn-ghost border border-base-content/15",
};
const btnClass = (style?: string) => BTN_STYLE[style ?? "secondary"] ?? BTN_STYLE.secondary;

export function ReplyComponents({ m }: { m: ChatMessage }) {
  const store = useChatStoreApi();
  const rows = m.replyComponents;
  const [busy, setBusy] = useState("");
  if (!rows || rows.length === 0) return null;
  // Discord 同款语义：没点过的按钮一直可点（用户习惯隔几条消息再回来点），
  // 只有点过的那组禁用+高亮所选。曾试过「翻篇即禁用」防误点旧确认按钮——真机
  // 反馈跟实际工作流冲突（2026-07-12），回滚；stale 点击由 agent 凭上下文兜底。
  const disabled = !!m.replyClickedId;

  const choose = async (choiceId: string, label: string, wire: string) => {
    if (disabled || busy) return;
    setBusy(choiceId);
    await store.clickReplyComponent(m.id, choiceId, label, wire);
    setBusy("");
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {rows.map((row: WebComponentRow, ri) => {
        if (row.type === "buttons") {
          return (
            <div key={ri} className="flex flex-wrap gap-2">
              {row.buttons.map((b) => {
                const label = `${b.emoji ? `${b.emoji} ` : ""}${b.label}`;
                const chosen = m.replyClickedId === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    disabled={disabled || busy !== ""}
                    onClick={() => choose(b.id, label, `[button:${b.id}]`)}
                    className={`btn btn-sm ${btnClass(b.style)} ${
                      disabled && !chosen ? "opacity-40" : ""
                    } ${chosen ? "ring-2 ring-offset-1 ring-base-content/30" : ""}`}
                  >
                    {busy === b.id ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      label
                    )}
                    {chosen && <span className="ml-1">✓</span>}
                  </button>
                );
              })}
            </div>
          );
        }
        // select：选项竖排按钮，点一个即回投 [select:<id>:<value>]
        return (
          <div key={ri} className="flex flex-col gap-1">
            {row.placeholder && (
              <span className="text-[11px] opacity-50">{row.placeholder}</span>
            )}
            {row.options.map((o) => {
              const choiceId = `${row.id}:${o.value}`;
              const chosen = m.replyClickedId === choiceId;
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled || busy !== ""}
                  onClick={() => choose(choiceId, o.label, `[select:${row.id}:${o.value}]`)}
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    chosen
                      ? "border-primary bg-primary/15"
                      : "border-base-content/10 bg-base-100/40 hover:bg-base-content/[0.04]"
                  } ${disabled && !chosen ? "opacity-40" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="font-medium opacity-90">{o.label}</span>
                    {o.description && (
                      <span className="ml-1 opacity-50">{o.description}</span>
                    )}
                  </span>
                  {chosen && <span className="ml-auto shrink-0">✓</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
