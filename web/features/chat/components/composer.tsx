"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";

const MAX_FILES = 5;

/* 复刻 Claude OS features/chat/composer 的卡片式输入：圆角卡 + 内嵌「正在回复」条
   + 附件缩略图 + 无边框 textarea + 图标控件。功能保留 claudestra 侧：流式中可插话、
   粘贴上传、停止与发送并列。 */

function PaperclipIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** 待发送文件的缩略图 / 文件卡片，点 ✕ 移除。 */
function PendingFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (i: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3">
      {files.map((f, i) => {
        const isImg = f.type.startsWith("image/");
        return isImg ? (
          <div
            key={i}
            className="group relative size-16 overflow-hidden rounded-lg border border-base-content/10 bg-base-300"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={URL.createObjectURL(f)}
              alt={f.name}
              className="size-full object-cover"
            />
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        ) : (
          <div
            key={i}
            title={f.name}
            className="group relative flex h-16 w-44 items-center gap-2.5 overflow-hidden rounded-lg border border-base-content/10 bg-base-300 px-3"
          >
            <span className="text-lg">📎</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-base-content/85">
                {f.name}
              </div>
              <div className="text-[10.5px] text-base-content/40">文件</div>
            </div>
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        );
      })}
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="移除"
      aria-label="移除"
      className="absolute right-0.5 top-0.5 flex size-[18px] items-center justify-center rounded-full bg-black/60 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100"
    >
      ✕
    </button>
  );
}

export function Composer() {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  const store = useChatStoreApi();

  const disabled = !active;
  const hasContent = !!text.trim() || files.length > 0;
  // 流式中也可发（插入会话）——不再要求 !streaming。
  const canSend = !disabled && hasContent;

  // textarea 自适应高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    store.send(text, files.length ? files : undefined);
    setText("");
    setFiles([]);
  };

  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = ""; // 允许再次选择同一文件
  };

  // 粘贴带文件（截图 / 复制的文件）直接收下；纯文本粘贴 files 为空，不影响输入
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const picked = Array.from(e.clipboardData.files);
    if (picked.length) {
      e.preventDefault();
      addFiles(picked);
    }
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
      className="bg-base-100 px-6 pb-3 pt-2 sm:px-7"
      // max() 取大不叠加：home 条区(env≈34pt)本身就够输入卡与屏底的间距，
      // 再 +12px 双层叠出「过高的底部」（owner 真机反馈）。无安全区时回退 12px。
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
    >
      <div className="mx-auto max-w-3xl">
        <div
          className={`overflow-hidden rounded-2xl border bg-base-200 transition-colors ${
            streaming
              ? "border-info/40"
              : hasContent
                ? "border-accent/50"
                : "border-base-content/10"
          }`}
        >
          {/* 正在回复状态条：流式期间常驻，告知此刻发送会插入当前会话（回合边界后生效），
              暂停按钮就在下方。刷新 / 切回进行中的会话也会经 SSE 补拉进入此态。 */}
          {streaming && (
            <div className="flex items-center gap-2 border-b border-base-content/[0.06] bg-info/[0.06] px-3.5 py-1.5 text-[11.5px]">
              <span className="relative flex size-2 shrink-0 items-center justify-center">
                <span className="animate-cstra-breathe absolute inline-flex size-2 rounded-full bg-info" />
                <span className="relative inline-flex size-1.5 rounded-full bg-info" />
              </span>
              <span className="font-medium text-base-content/70">正在回复…</span>
              <span className="ml-auto text-base-content/40 max-sm:hidden">
                发送即插入当前会话，将在当前步骤后生效
              </span>
            </div>
          )}

          <PendingFiles
            files={files}
            onRemove={(i) =>
              setFiles((prev) => prev.filter((_, idx) => idx !== i))
            }
          />

          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={onPick}
          />

          <textarea
            ref={taRef}
            className="block max-h-[180px] min-h-[46px] w-full resize-none bg-transparent px-4 pb-1.5 pt-[14px] text-[14.5px] leading-[1.55] text-base-content outline-none placeholder:text-base-content/35"
            rows={1}
            placeholder={
              disabled
                ? "先选择一个会话…"
                : streaming
                  ? "继续输入，随时插话…（Enter 发送）"
                  : `发消息给 ${active}（Enter 发送）`
            }
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />

          {/* 控件行 */}
          <div className="flex items-center gap-1.5 px-2.5 pb-[9px] pt-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              title="添加附件（也可直接粘贴）"
              aria-label="添加附件"
              disabled={disabled || files.length >= MAX_FILES}
              className="flex size-8 items-center justify-center rounded-[9px] text-base-content/60 transition-colors hover:bg-base-content/[0.06] hover:text-base-content disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <PaperclipIcon />
            </button>

            <div className="ml-auto flex items-center gap-1.5">
              {/* 流式期间：暂停与发送并列（不互斥替换）——可一边看回复一边输入插话 */}
              {streaming && (
                <button
                  onClick={() => store.interrupt()}
                  title="暂停（停止当前回复，Ctrl+C）"
                  aria-label="暂停"
                  className="flex size-[34px] items-center justify-center rounded-[10px] bg-base-content/15 text-base-content transition-colors hover:bg-base-content/25"
                >
                  <span className="block size-3 rounded-[2px] bg-current" />
                </button>
              )}
              <button
                onClick={submit}
                disabled={!canSend}
                title={
                  streaming ? "插入当前会话（当前步骤后生效）" : "发送"
                }
                aria-label="发送"
                className={`flex size-[34px] items-center justify-center rounded-[10px] transition-colors ${
                  canSend
                    ? "bg-accent text-white"
                    : "bg-base-300 text-base-content/40"
                }`}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
