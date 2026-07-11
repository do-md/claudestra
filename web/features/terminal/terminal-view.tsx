"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ControlBar } from "./control-bar";

/**
 * 远程终端视图（仅客户端，经 dynamic ssr:false 加载）。
 *
 * 数据面（设计文档 web-terminal-design.md）：
 * - 下行：GET /api/terminal/stream?agent=&cols=&rows=（SSE 透传 Bridge PTY 输出，
 *   帧 {"t":"o","d":base64} → term.write；{"t":"open"} 带 termId；{"t":"exit"} 结束）。
 * - 上行：term.onData 的原始转义序列 → 8ms 微批 → POST /api/terminal/input
 *   {id, d: base64}。**串行 promise 链保证字节序**（并发 fetch 不保序）。
 * - resize：ResizeObserver 防抖 150ms → fit → cols/rows 变了才 POST resize。
 *
 * 渲染主题对齐 ansi2html 的 catppuccin mocha（#1e1e2e/#cdd6f4）。
 * WebGL addon 尽力加载（失败静默降级 DOM renderer——xterm v6 已无 canvas）。
 */

type TermStatus = "connecting" | "connected" | "exited" | "error";

/** UTF-8 字符串 → base64（xterm onData 给 JS 字符串，先编 UTF-8 字节再 b64） */
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(d: string): Uint8Array {
  return Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
}

export function TerminalView({ agent }: { agent: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const termIdRef = useRef<string | null>(null);
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [errMsg, setErrMsg] = useState("");
  // 手动重连计数：+1 触发 effect 重跑（销毁旧 PTY、建新的）
  const [connectSeq, setConnectSeq] = useState(0);

  /** 上行：微批 + 串行链（字节序！）。ControlBar 也走这里。 */
  const queueInput = (data: string) => {
    if (!data) return;
    pendingRef.current += data;
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const id = termIdRef.current;
      const d = pendingRef.current;
      pendingRef.current = "";
      if (!id || !d) return;
      sendChainRef.current = sendChainRef.current.then(() =>
        fetch("/api/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, d: b64encode(d) }),
        }).then(
          () => undefined,
          () => undefined
        )
      );
    }, 8);
  };
  const queueInputRef = useRef(queueInput);
  queueInputRef.current = queueInput;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const abort = new AbortController();
    setStatus("connecting");
    setErrMsg("");
    termIdRef.current = null;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", "Courier New", monospace',
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
      },
      // iOS 软键盘：xterm 隐藏 textarea 自带 autocorrect/autocapitalize off
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    // debug 句柄：后台 tab 里 WebGL 不 paint（rAF 冻结），验证数据面要靠读 buffer
    (window as unknown as Record<string, unknown>).__claudestraTerm = term;
    // WebGL 尽力（不支持/上下文丢失 → DOM renderer）。
    // ?noWebgl=1 强制 DOM renderer（后台 tab 自动化验证用：WebGL 在 hidden tab
    // 不 paint，DOM 内容 CDP 截图可见）
    const noWebgl =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("noWebgl");
    if (!noWebgl) {
      (async () => {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          term.loadAddon(webgl);
        } catch {
          /* DOM renderer 兜底 */
        }
      })();
    }

    fit.fit();
    const cols = term.cols;
    const rows = term.rows;

    term.onData((data) => queueInputRef.current(data));
    term.onBinary((data) => queueInputRef.current(data));

    // ── SSE 下行 ──
    // ⚠ 延迟 50ms 再连：React dev 双 effect 的第一个 effect 会被同步清理——若
    // 它已发出 fetch，abort 落在「Bridge 已开 PTY、Next 响应流未建立」的 race
    // 窗口时取消传导会丢（实测漏过一条 → Bridge 僵尸 PTY，靠 TTL 才能回收）。
    // 延迟让第一个 effect 的连接根本不发生；50ms 对真人无感。
    const connectTimer = window.setTimeout(connect, 50);
    async function connect() {
      let res: Response;
      try {
        res = await fetch(
          `/api/terminal/stream?agent=${encodeURIComponent(agent)}&cols=${cols}&rows=${rows}`,
          { signal: abort.signal }
        );
      } catch {
        if (!disposed) {
          setStatus("error");
          setErrMsg("连接失败");
        }
        return;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        if (!disposed) {
          setStatus("error");
          setErrMsg(text || `连接失败 (${res.status})`);
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue; // 心跳注释
            let evt: { t: string; d?: string; id?: string };
            try {
              evt = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }
            if (evt.t === "o" && evt.d) {
              term.write(b64decode(evt.d));
            } else if (evt.t === "open" && evt.id) {
              termIdRef.current = evt.id;
              if (!disposed) setStatus("connected");
            } else if (evt.t === "exit") {
              if (!disposed) setStatus("exited");
            }
          }
        }
        // 流正常收尾（Bridge 关闭）——不是用户主动关就标记结束
        if (!disposed) setStatus((s) => (s === "connected" ? "exited" : s));
      } catch {
        if (!disposed) {
          setStatus((s) => (s === "connected" || s === "connecting" ? "error" : s));
          setErrMsg("连接中断");
        }
      }
    }

    // ── resize 跟随容器 ──
    let lastCols = cols;
    let lastRows = rows;
    let resizeTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        const id = termIdRef.current;
        if (id && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          fetch("/api/terminal/resize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, cols: term.cols, rows: term.rows }),
          }).catch(() => {});
        }
      }, 150);
    });
    ro.observe(container);

    return () => {
      disposed = true;
      clearTimeout(connectTimer); // dev 双 effect：首个 effect 的连接在 fire 前取消
      ro.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        pendingRef.current = "";
      }
      abort.abort(); // 断 SSE → Bridge 销毁 PTY + viewer session
      term.dispose();
      termRef.current = null;
    };
    // agent 或手动重连时整体重建
  }, [agent, connectSeq]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      <div className="relative min-h-0 flex-1 px-2 pt-2">
        <div ref={containerRef} className="h-full w-full" />
        {status !== "connected" && (
          <div className="absolute inset-0 grid place-items-center bg-[#1e1e2e]/70">
            {status === "connecting" && (
              <span className="flex items-center gap-2 text-sm text-[#cdd6f4]/70">
                <span className="loading loading-spinner loading-sm" />
                连接终端…
              </span>
            )}
            {(status === "exited" || status === "error") && (
              <div className="flex flex-col items-center gap-2">
                <span className="text-sm text-[#cdd6f4]/70">
                  {status === "exited" ? "终端会话已结束" : errMsg || "连接出错"}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => setConnectSeq((n) => n + 1)}
                >
                  重新连接
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <ControlBar
        onKeys={(seq) => queueInputRef.current(seq)}
        onFocusTerm={() => termRef.current?.focus()}
        disabled={status !== "connected"}
      />
    </div>
  );
}

export default TerminalView;
