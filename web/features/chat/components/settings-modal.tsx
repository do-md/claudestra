"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";

/** 选中的图片 → 128×128 居中裁剪 jpeg data URL（~10-20KB,存库直出）。 */
async function fileToAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * 全局设置弹窗（侧栏 ⚙️ 进入）：个人资料（头像+昵称,owner 2026-07-14）
 * + 语音识别的 Groq API Key。portal 到 body（规则 5.5）。
 * 完整 key 永不回显——已配置时展示尾四位提示。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useChatStoreApi();
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 个人资料草稿（打开时从 store 取当前值,保存才写回）
  const [nick, setNick] = useState("");
  const [avatar, setAvatar] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMsg("");
    setProfileMsg("");
    const p = store.state.profile;
    setNick(p.nickname);
    setAvatar(p.avatar);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: { groqApiKeySet?: boolean; groqApiKeyHint?: string }) => {
        setHint(j.groqApiKeySet ? j.groqApiKeyHint || "已配置" : "");
      })
      .catch(() => {});
  }, [open, store]);

  if (!open) return null;

  const pickAvatar = async (f: File | undefined) => {
    if (!f) return;
    try {
      setAvatar(await fileToAvatar(f));
      setProfileMsg("");
    } catch {
      setProfileMsg("图片读取失败");
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    setProfileMsg("");
    const ok = await store.saveProfile(nick.trim(), avatar);
    setProfileMsg(ok ? "已保存" : "保存失败");
    setBusy(false);
  };

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

        {/* ── 个人资料 ─────────────────────────────── */}
        <label className="mb-1.5 block text-sm font-medium">个人资料</label>
        <p className="mb-2 text-xs text-base-content/50">
          头像和昵称显示在你自己的消息旁（只影响本界面展示）。
        </p>
        <div className="mb-3 flex items-center gap-3">
          <button
            className="group relative size-14 shrink-0 overflow-hidden rounded-full border border-base-300 bg-base-200"
            title="选择头像"
            onClick={() => fileRef.current?.click()}
          >
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatar} alt="头像" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-xl opacity-40">👤</span>
            )}
            <span className="absolute inset-0 grid place-items-center bg-black/40 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
              更换
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void pickAvatar(e.target.files?.[0])}
          />
          <input
            type="text"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder="昵称"
            maxLength={32}
            autoComplete="off"
            className="input input-bordered w-full text-sm"
          />
        </div>
        <div className="mb-5 flex items-center gap-2">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveProfile()}>
            保存资料
          </button>
          {avatar && (
            <button className="btn btn-ghost btn-sm text-error/80" disabled={busy} onClick={() => setAvatar("")}>
              移除头像
            </button>
          )}
          {profileMsg && <span className="text-xs text-base-content/60">{profileMsg}</span>}
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
