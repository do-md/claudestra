"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 水合完成前提交按钮禁用：冷启动时 JS 未就绪就点提交,表单会走原生 GET
  // 提交(地址栏变 /login?、页面刷新),看起来像「登录失败」(2026-07-14 真机)
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(json.error || "登录失败");
      return;
    }

    router.push("/");
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 px-4">
      <div className="card w-full max-w-sm bg-base-100 shadow-lg">
        <div className="card-body">
          <h1 className="text-xl font-bold text-center mb-1">Claudestra</h1>
          <p className="text-xs text-center text-base-content/60 mb-4">
            本机 SSH 账号登录
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="form-control">
              <span className="label-text text-sm mb-1">账号</span>
              <input
                type="text"
                className="input input-bordered input-sm w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </label>
            <label className="form-control">
              <span className="label-text text-sm mb-1">密码</span>
              <input
                type="password"
                className="input input-bordered input-sm w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>

            {error && (
              <div className="alert alert-error alert-sm text-sm py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-sm w-full"
              disabled={loading || !hydrated}
            >
              {loading || !hydrated ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                "登录"
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
