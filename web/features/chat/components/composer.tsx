"use client";
import { useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";

export function Composer() {
  const [text, setText] = useState("");
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  const store = useChatStoreApi();

  const disabled = !active;

  const submit = () => {
    const t = text.trim();
    if (!t || disabled || streaming) return;
    store.send(t);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="border-t border-base-300 bg-base-100 px-3 pt-3 sm:px-4"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          className="textarea textarea-bordered max-h-40 min-h-[2.75rem] flex-1 resize-none"
          rows={1}
          placeholder={
            disabled ? "先选择一个会话…" : `发消息给 ${active}（Enter 发送）`
          }
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button
            className="btn btn-error"
            title="停止 (Ctrl+C)"
            onClick={() => store.interrupt()}
          >
            ■ 停止
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
