"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("22");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, host, port }),
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
    <div className="min-h-screen flex items-center justify-center bg-base-200 px-4">
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

            {/* Advanced: Host & Port */}
            <button
              type="button"
              className="text-xs text-base-content/40 hover:text-base-content/60"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? "▾ 收起" : "▸ SSH 主机设置"}
            </button>

            {showAdvanced && (
              <div className="flex gap-2">
                <label className="form-control flex-1">
                  <span className="label-text text-xs mb-1">Host</span>
                  <input
                    type="text"
                    className="input input-bordered input-sm w-full"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="localhost"
                  />
                </label>
                <label className="form-control w-20">
                  <span className="label-text text-xs mb-1">Port</span>
                  <input
                    type="text"
                    className="input input-bordered input-sm w-full"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                  />
                </label>
              </div>
            )}

            {error && (
              <div className="alert alert-error alert-sm text-sm py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-sm w-full"
              disabled={loading}
            >
              {loading ? (
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
