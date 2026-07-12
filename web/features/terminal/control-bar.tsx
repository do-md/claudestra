"use client";

import { useRef } from "react";

/**
 * 终端控制键条 —— 移动端主输入面（xterm.js 移动端短板的业界共识兜底：
 * 控制键 + 单行输入框；桌面端直接在终端里打字）。
 *
 * 关键交互：按钮 onPointerDown preventDefault —— 不抢输入焦点（xterm 隐藏
 * textarea / 手机端下方的专用输入框），否则手机上点一下按键软键盘就收起。
 */

// 手机端精简：只留真正控制 Claude Code TUI 用得上的键。移除了 Tab / ← / →
//（CC TUI 几乎不用 Tab；横向移光标在手机上基本不编辑内联文本，软键盘够用），
// 竖向滚动历史已由「触摸滑动 → 滚轮」接管（见 terminal-view.tsx），不再靠 ↑/↓。
// ↑/↓ 保留是为 CC 菜单/选项/权限弹窗的上下选择（滑动是滚动，替代不了选择）。
const KEYS: { label: string; seq: string; title?: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "⇧Tab", seq: "\x1b[Z", title: "Shift+Tab（切换权限模式）" },
  { label: "↑", seq: "\x1b[A", title: "上选（菜单/选项）" },
  { label: "↓", seq: "\x1b[B", title: "下选（菜单/选项）" },
  { label: "⏎", seq: "\r", title: "Enter" },
  { label: "^C", seq: "\x03", title: "Ctrl+C（中断）" },
  // 看更早的转录用 CC 原生 Ctrl+O（进入后配合滑动/↑↓ 可滚完整会话记录）
  { label: "^O", seq: "\x0f", title: "Ctrl+O（Claude Code 转录视图，可滚动）" },
];

/**
 * 手机端专用文本输入框 —— 绕开 xterm 隐藏 textarea（其 IME/预测输入合成器
 * 在移动端快速打字会吞字，upstream 已知 #3396/#2403）。
 *
 * 原理：普通 <input> 用系统原生输入法，零丢字。每次值变化算增量（相对上次），
 * 用退格 \x7f + 新增字符实时转发到终端 → CC 里同步回显、slash 菜单照常。
 * - onInput：非组合态（isComposing=false）才转发；组合中（中文拼音等）等 compositionend。
 * - Enter：发 \r 并清空本行（CC 已逐字收到整行，\r 提交）。
 * - autocorrect/autocapitalize 关（终端场景多为命令/精确文本）。
 */
function MobileInput({
  onKeys,
  disabled,
  inputRef,
}: {
  onKeys: (seq: string) => void;
  disabled?: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const lastRef = useRef("");

  // 把当前值与上次值的差异转成键序列发出（退格 + 新增），支持自动更正类整词替换
  const flush = (val: string) => {
    const old = lastRef.current;
    let i = 0;
    const n = Math.min(old.length, val.length);
    while (i < n && old[i] === val[i]) i++;
    let seq = "";
    for (let k = 0; k < old.length - i; k++) seq += "\x7f"; // 删掉旧值多出的尾部
    seq += val.slice(i); // 补上新值的新增部分
    lastRef.current = val;
    if (seq) onKeys(seq);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="send"
      disabled={disabled}
      placeholder="输入文本…（Enter 发送）"
      className="input input-sm w-full min-w-0 flex-1 rounded-md border-white/10 bg-white/5 text-sm text-[#cdd6f4] placeholder:text-[#cdd6f4]/35 focus:border-white/25 focus:outline-none"
      onInput={(e) => {
        // 组合输入进行中（拼音候选等）先不转发，等 compositionend 提交
        if ((e.nativeEvent as InputEvent).isComposing) return;
        flush(e.currentTarget.value);
      }}
      onCompositionEnd={(e) => flush(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onKeys("\r");
          lastRef.current = "";
          e.currentTarget.value = "";
        } else if (e.key === "Backspace" && e.currentTarget.value === "") {
          // 输入框已空时仍允许删终端里已提交的字符
          e.preventDefault();
          onKeys("\x7f");
        }
      }}
    />
  );
}

export function ControlBar({
  onKeys,
  onFocusTerm,
  disabled,
  mobile,
}: {
  onKeys: (seq: string) => void;
  onFocusTerm: () => void;
  disabled?: boolean;
  /** 手机端：显示专用输入框（绕开 xterm 吞字的 textarea） */
  mobile?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t border-white/10 bg-[#181825] px-2 py-2"
      style={{
        // --term-safe-bottom：软键盘弹起时 modal 置 0（home 条在键盘后面无需垫）
        paddingBottom:
          "max(var(--term-safe-bottom, env(safe-area-inset-bottom)), 6px)",
      }}
    >
      {/* 手机端专用输入行（桌面端直接在终端里打字，不需要） */}
      {mobile && (
        <MobileInput onKeys={onKeys} disabled={disabled} inputRef={inputRef} />
      )}

      <div className="flex items-center gap-1.5 overflow-x-auto">
        {/* 唤起软键盘：手机端聚焦专用输入框，桌面端聚焦 xterm（iOS 必须在手势内 focus） */}
        <button
          className="btn btn-sm shrink-0 border-white/10 bg-white/5 font-normal text-[#cdd6f4] hover:bg-white/10"
          title="唤起键盘输入"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (mobile ? inputRef.current?.focus() : onFocusTerm())}
          disabled={disabled}
        >
          ⌨️
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-white/10" />
        {KEYS.map((k) => (
          <button
            key={k.label}
            className="btn btn-sm shrink-0 border-white/10 bg-white/5 font-mono font-normal text-[#cdd6f4] hover:bg-white/10"
            title={k.title || k.label}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onKeys(k.seq)}
            disabled={disabled}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
