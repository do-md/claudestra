"use client";
import { createContext, useContext } from "react";

/**
 * 移动端「会话列表 ↔ 会话内容」导航（抄 claude-os features/chat/nav-context）。
 *
 * 实现靠 hash 历史栈 `#chat`：选会话 → pushState('#chat') 压一条真实 history 记录并横滑到内容页；
 * iOS 左缘滑动 / 系统返回键触发 popstate → 出栈回列表。**这是「左滑系统级返回」成立的前提**——
 * 单页 SPA 没有 history 栈拿不到系统返回，必须靠 pushState 造出可回退的历史项。
 * 桌面端（≥sm）双栏并存，toContent/toList 空转不压栈。
 */
export type ChatNav = {
  /** 当前是否处于「会话内容」视图（移动端）；桌面端恒双栏无意义 */
  showContent: boolean;
  /** 进入会话内容（移动端压栈 #chat 并横滑） */
  toContent: () => void;
  /** 返回会话列表（移动端优先走 history.back 触发系统返回动画） */
  toList: () => void;
};

export const ChatNavContext = createContext<ChatNav>({
  showContent: false,
  toContent: () => {},
  toList: () => {},
});

export const useChatNav = () => useContext(ChatNavContext);
