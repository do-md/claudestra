"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";

/**
 * 新建 agent 弹窗：填 name / dir / purpose → store.createAgent → Bridge runManager create。
 * daisyUI modal（遵 prin b8ce13：只用 DaisyUI + Tailwind）。
 */
export function NewAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = useChatStoreApi();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setName("");
    setDir("");
    setPurpose("");
    setError("");
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const n = name.trim();
    const d = dir.trim();
    if (!n || !d) {
      setError("name 和 dir 必填");
      return;
    }
    setBusy(true);
    setError("");
    const res = await store.createAgent(n, d, purpose.trim() || undefined);
    setBusy(false);
    if (res.ok) {
      reset();
      onClose();
    } else {
      setError(res.error || "创建失败");
    }
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="text-lg font-semibold">新建会话</h3>
        <p className="mt-1 text-xs opacity-60">
          在指定目录起一个 Claude Code agent（经 Bridge）。
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="form-control">
            <span className="label-text mb-1 text-sm">名称</span>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="worker-alpha"
              value={name}
              disabled={busy}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-sm">工作目录</span>
            <input
              className="input input-bordered input-sm w-full font-mono"
              placeholder="~/code/project 或 /abs/path"
              value={dir}
              disabled={busy}
              onChange={(e) => setDir(e.target.value)}
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1 text-sm">用途（可选）</span>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="这个 agent 干什么"
              value={purpose}
              disabled={busy}
              onChange={(e) => setPurpose(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 text-sm text-error break-words">{error}</div>
        )}

        <div className="modal-action">
          <button className="btn btn-ghost btn-sm" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={busy}
          >
            {busy && <span className="loading loading-spinner loading-xs" />}
            创建
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={close} />
    </div>
  );
}
