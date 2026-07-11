"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";

// xterm 依赖 window，必须 ssr:false 动态加载（设计文档 §前端）
const TerminalView = dynamic(
  () => import("./terminal-view").then((m) => m.TerminalView),
  {
    ssr: false,
    loading: () => (
      <div className="grid flex-1 place-items-center bg-[#1e1e2e] text-sm text-[#cdd6f4]/60">
        加载终端…
      </div>
    ),
  }
);

/**
 * 远程终端模态框。移动端全屏 / 桌面近全屏。
 *
 * - createPortal 到 body：会话页在 transform 横滑容器内，容器内渲染 fixed
 *   会定位到屏幕外一屏（web/CLAUDE.md 规则 5.5）。
 * - iOS 软键盘：visualViewport resize 时把 modal 高度钳到可视高度，
 *   控制键条不被键盘盖住。
 * - 安全区由面板自己垫（顶部 header / 底部 ControlBar 内），规则 2/3。
 */
export function TerminalModal({
  agent,
  displayName,
  onClose,
}: {
  agent: string;
  displayName: string;
  onClose: () => void;
}) {
  // iOS 软键盘：visualViewport 缩小时，modal-box 不能再走 daisyUI 的「居中」
  // 布局——modal 容器是整个布局视口，矮了的 box 会被居中到中间：上面露出
  // 半截背景页、下半截（控制键条）沉进键盘（真机 2026-07-11 实测塌陷）。
  // 修法：键盘在场时把 box 改为 fixed 钉在可视视口顶部（top=vv.offsetTop，
  // iOS 聚焦可能滚动布局视口），height=vv.height，正好铺满键盘上方区域。
  const [vp, setVp] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const keyboardUp = window.innerHeight - vv.height > 40;
      setVp(keyboardUp ? { h: vv.height, top: vv.offsetTop } : null);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update); // offsetTop 变化（聚焦滚动）也要跟
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Esc 关闭（桌面）；注意 xterm 聚焦时 Esc 会被终端吃掉——这是预期
  // （终端里 Esc 有语义），点 ✕ 或背板关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.(".xterm")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal modal-open">
      <div
        className="modal-box flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[88vh] sm:w-[92vw] sm:max-w-6xl sm:rounded-xl"
        style={
          vp !== null
            ? {
                // 键盘在场：脱离居中布局，钉满键盘上方的可视区
                position: "fixed",
                top: vp.top,
                left: 0,
                width: "100vw",
                maxWidth: "100vw",
                height: vp.h,
                borderRadius: 0,
                // 键盘在场时 home 条在键盘后面，控制键条不再垫底部安全区
                ["--term-safe-bottom" as string]: "0px",
              } as React.CSSProperties
            : undefined
        }
      >
        <header
          className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#181825] px-3 py-2 text-[#cdd6f4]"
          style={{ paddingTop: "max(env(safe-area-inset-top), 8px)" }}
        >
          <span className="text-sm opacity-60">🖥️</span>
          <span className="truncate text-sm font-medium">
            {displayName} · 终端
          </span>
          <span className="hidden text-xs opacity-40 sm:inline">
            实时镜像 tmux 会话 · 关闭即断开（不影响运行）
          </span>
          <button
            className="btn btn-ghost btn-sm ml-auto px-2 text-[#cdd6f4]/70 hover:text-[#cdd6f4]"
            aria-label="关闭终端"
            onClick={onClose}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <TerminalView agent={agent} />
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>,
    document.body
  );
}
