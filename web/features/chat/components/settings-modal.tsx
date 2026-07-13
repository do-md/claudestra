"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 全局设置弹窗（侧栏 ⚙️ 进入）。目前只有语音识别的 Groq API Key
 * （2026-07-14 owner：key 要有地方在界面上填）。portal 到 body（规则 5.5）。
 * 完整 key 永不回显——已配置时展示尾四位提示。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMsg("");
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: { groqApiKeySet?: boolean; groqApiKeyHint?: string }) => {
        setHint(j.groqApiKeySet ? j.groqApiKeyHint || "已配置" : "");
      })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const save = async (value: string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groqApiKey: value }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; groqApiKeyHint?: string };
      if (res.ok && j.ok) {
        setHint(j.groqApiKeyHint || "");
        setKeyInput("");
        setMsg(value ? "已保存,语音输入即时生效" : "已清除");
      } else {
        setMsg(j.error || "保存失败");
      }
    } catch {
      setMsg("保存失败");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-base-100 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-base font-semibold">设置</span>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="mb-1.5 block text-sm font-medium">
          语音识别 · Groq API Key
        </label>
        <p className="mb-2 text-xs text-base-content/50">
          {hint ? `当前:${hint}（输入新值覆盖）` : "未配置。console.groq.com 免费注册,API Keys 页生成。"}
        </p>
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="gsk_…"
          autoComplete="off"
          className="input input-bordered w-full text-sm"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !keyInput.trim()}
            onClick={() => save(keyInput.trim())}
          >
            保存
          </button>
          {hint && (
            <button className="btn btn-ghost btn-sm text-error/80" disabled={busy} onClick={() => save("")}>
              清除
            </button>
          )}
          {msg && <span className="text-xs text-base-content/60">{msg}</span>}
        </div>
      </div>
    </div>,
    document.body
  );
}
