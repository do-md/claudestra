"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";

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
 * 移动端终端页（hash 伪路由 #terminal，owner 2026-07-11：不再给模态框打补丁）。
 *
 * - 结构上消灭「键盘弹起露出背面/背面可滚」：本层是 fixed inset-0 的不透明
 *   全屏页，chat 完全被盖住；iOS 键盘挤压/平移布局视口时露出的也是本层自己
 *   的深色底。
 * - 左滑退出：入口处 pushState("#terminal")，iOS 左缘滑 = history.back →
 *   popstate 关页（与 #chat 会话页同一套导航，prin-0372d5）。
 * - 软键盘：visualViewport 缩小时内容层钉在 (top=vv.offsetTop, h=vv.height)，
 *   控制键条始终贴键盘上沿；键盘在场时底部安全区垫归零。
 * - createPortal 到 body：按钮在 transform 横滑容器内（规则 5.5）。
 */
export function TerminalPage({
  agent,
  displayName,
  onClose,
}: {
  agent: string;
  displayName: string;
  onClose: () => void;
}) {
  const [vp, setVp] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // iOS 露出 focused input 时有两条路：平移 visualViewport（offsetTop>0）
      // 或直接滚 document（scrollY>0，fixed 层跟着被顶出屏）。document 滚动
      // 强制归零（页面本无可滚内容），vv 平移用 offsetTop 钉层补偿。
      if ((window.scrollY || 0) > 0) window.scrollTo(0, 0);
      const keyboardUp = window.innerHeight - vv.height > 40 || vv.offsetTop > 1;
      setVp(keyboardUp ? { h: vv.height, top: vv.offsetTop } : null);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-[#1e1e2e]">
      <div
        className="absolute inset-x-0 flex flex-col"
        style={
          vp !== null
            ? ({
                top: vp.top,
                height: vp.h,
                // home 条在键盘后面，控制键条不再垫底部安全区
                ["--term-safe-bottom" as string]: "0px",
              } as React.CSSProperties)
            : { top: 0, height: "100%" }
        }
      >
        <header
          className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-[#181825] px-1.5 py-2 text-[#cdd6f4]"
          style={{ paddingTop: "max(env(safe-area-inset-top), 8px)" }}
        >
          <button
            className="btn btn-ghost btn-sm px-2 text-[#cdd6f4]/80"
            aria-label="返回会话"
            onClick={onClose}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="truncate text-sm font-medium">
            {displayName} · 终端
          </span>
        </header>
        <TerminalView agent={agent} mobile />
      </div>
    </div>,
    document.body
  );
}
