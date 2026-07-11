"use client";

/**
 * 终端控制键条 —— 移动端主输入面（xterm.js 移动端短板的业界共识兜底：
 * 控制键 + 软键盘打字；重输入引导走 chat）。桌面端同样可用（Shift+Tab
 * 循环 Claude Code 权限模式等场景顺手）。
 *
 * 关键交互：按钮 onPointerDown preventDefault —— 不抢 xterm 隐藏 textarea
 * 的焦点，否则手机上点一下按键软键盘就收起。
 */

const KEYS: { label: string; seq: string; title?: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "⇧Tab", seq: "\x1b[Z", title: "Shift+Tab（切换权限模式）" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⏎", seq: "\r", title: "Enter" },
  { label: "^C", seq: "\x03", title: "Ctrl+C（中断）" },
  // CC TUI 在 alternate screen（无终端滚动缓冲，tmux pane 历史也为空）——
  // 看更早的转录要用 CC 原生的 Ctrl+O transcript 模式（进入后滚轮/方向键可滚）
  { label: "^O", seq: "\x0f", title: "Ctrl+O（Claude Code 转录视图，可滚动）" },
];

export function ControlBar({
  onKeys,
  onFocusTerm,
  disabled,
}: {
  onKeys: (seq: string) => void;
  onFocusTerm: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 bg-[#181825] px-2 py-1.5"
      style={{
        // --term-safe-bottom：软键盘弹起时 modal 置 0（home 条在键盘后面无需垫）
        paddingBottom:
          "max(var(--term-safe-bottom, env(safe-area-inset-bottom)), 6px)",
      }}
    >
      {/* 唤起软键盘（iOS 必须在用户手势内 focus） */}
      <button
        className="btn btn-xs shrink-0 border-white/10 bg-white/5 font-normal text-[#cdd6f4] hover:bg-white/10"
        title="唤起键盘输入"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onFocusTerm}
        disabled={disabled}
      >
        ⌨️
      </button>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-white/10" />
      {KEYS.map((k) => (
        <button
          key={k.label}
          className="btn btn-xs shrink-0 border-white/10 bg-white/5 font-mono font-normal text-[#cdd6f4] hover:bg-white/10"
          title={k.title || k.label}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onKeys(k.seq)}
          disabled={disabled}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
