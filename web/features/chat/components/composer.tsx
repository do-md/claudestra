"use client";
import { useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";

const MAX_FILES = 5;

/** 待发送文件的预览 chip（图片缩略图 / 文件名），点 ✕ 移除。 */
function PendingFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (i: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap gap-2 pb-2">
      {files.map((f, i) => {
        const isImg = f.type.startsWith("image/");
        return (
          <div
            key={i}
            className="relative flex items-center gap-1.5 rounded-lg border border-base-300 bg-base-200 py-1 pl-1.5 pr-6 text-xs"
          >
            {isImg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={URL.createObjectURL(f)}
                alt={f.name}
                className="size-8 rounded object-cover"
              />
            ) : (
              <span className="text-base">📎</span>
            )}
            <span className="max-w-[8rem] truncate">{f.name}</span>
            <button
              type="button"
              className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-base-300 text-[10px] leading-none hover:bg-error hover:text-error-content"
              onClick={() => onRemove(i)}
              aria-label="移除"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Composer() {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  const store = useChatStoreApi();

  const disabled = !active;
  const canSend = !disabled && !streaming && (!!text.trim() || files.length > 0);

  const submit = () => {
    if (!canSend) return;
    store.send(text, files.length ? files : undefined);
    setText("");
    setFiles([]);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
    e.target.value = ""; // 允许再次选择同一文件
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
      <PendingFiles
        files={files}
        onRemove={(i) => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
      />
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={onPick}
        />
        <button
          className="btn btn-ghost btn-square"
          title="上传图片 / 文件"
          disabled={disabled || files.length >= MAX_FILES}
          onClick={() => fileRef.current?.click()}
          aria-label="上传文件"
        >
          📎
        </button>
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
          <button className="btn btn-primary" disabled={!canSend} onClick={submit}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
