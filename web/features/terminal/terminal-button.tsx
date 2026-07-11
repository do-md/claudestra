"use client";
import { useState } from "react";
import type { AgentSession } from "../chat/type";
import { TerminalModal } from "./terminal-modal";

/** 终端：>_ 提示符图标 */
function TerminalIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

/**
 * 会话详情顶栏的「终端」入口（master 也可用——它同样有 tmux window）。
 * 仅 active 会话显示：终端镜像的是活着的 tmux window，stopped 无窗可看。
 */
export function TerminalButton({ agent }: { agent: AgentSession }) {
  const [open, setOpen] = useState(false);
  if (agent.mock || agent.status !== "active") return null;
  return (
    <>
      <button
        className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content"
        title="打开远程终端（实时镜像 + 可输入）"
        aria-label="打开远程终端"
        onClick={() => setOpen(true)}
      >
        <TerminalIcon />
      </button>
      {open && (
        <TerminalModal
          agent={agent.name}
          displayName={agent.displayName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
