/**
 * Web 前端接入面 —— 与 Discord 并行的「附加」输出通道（两端可同时在线）。
 *
 * 一个 channelId 可有多个 Web SSE 订阅者。会话产生用户可见输出时（jsonl-watcher 的
 * 工具摘要/助手文本 + reply 回复 + Stop 收尾），除了发 Discord（若 DISCORD_ENABLED）外，
 * 也 fan-out 到这里的订阅者。所以：
 *   - Discord 建的会话（真 channelId）→ Web 也能订阅、镜像同一 session
 *   - Web-only 会话（合成 local-<uuid> channelId）→ 照常在此推送
 *
 * 事件形状与前端 web/lib/chat/events.ts 的 WebStreamEvent 保持一致（段级流，v1）。
 */

/** 权限/AUQ 卡的选项（回传时用 action 打 tmux 键序列）。 */
export interface WebPermAction {
  action: string;
  label: string;
  style: "success" | "primary" | "danger" | "secondary";
}
/** AskUserQuestion 一个 option / question 的 Web 形状。 */
export interface WebAuqOption {
  label: string;
  description?: string;
}
export interface WebAuqQuestion {
  question: string;
  header: string;
  options: WebAuqOption[];
  multiSelect: boolean;
}

export type WebStreamEvent =
  | { t: "status"; status: "running" | "done" }
  | { t: "tool"; name: string; summary: string; state: "running" | "done" | "error" }
  | { t: "text"; text: string }
  | { t: "done" }
  | { t: "error"; error: string }
  // Phase 2 富交互：agent 需要用户抉择的「待处理卡」。回传经 bridge → tmux 按键。
  | {
      t: "permission";
      /** 稳定 dedup key（modal 语义），前端据此去重/替换 */
      id: string;
      kind: "permission" | "session-idle";
      title: string;
      desc: string;
      actions: WebPermAction[];
    }
  | { t: "permission-cleared" }
  | { t: "ask"; id: string; questions: WebAuqQuestion[] }
  | { t: "ask-cleared" };

/** 合成的本地 channelId（Web-only 无 Discord 频道时用）。 */
export function isLocalChannelId(channelId: string): boolean {
  return channelId.startsWith("local-");
}

type Sink = (event: WebStreamEvent) => void;

// key = channelId
const subscribers = new Map<string, Set<Sink>>();

// key = channelId → 当前「待处理交互卡」事件（permission 或 ask）。
// 交互卡是有状态的（弹出→用户处理→消失），而 SSE 订阅者可能在弹窗**之后**才连上
// （切会话/刷新/回前台重连）。故把当前 pending 事件存这里，新订阅者连上时 replay，
// 否则它就永远看不到那张卡。处理完（回传成功 / watcher 检测到 modal 消失）清空。
const pendingInteraction = new Map<string, WebStreamEvent>();

/** 设置/清空某 channel 的待处理交互卡（null=清空）。 */
export function setPendingInteraction(
  channelId: string,
  event: WebStreamEvent | null
): void {
  if (event) pendingInteraction.set(channelId, event);
  else pendingInteraction.delete(channelId);
}

/** 取某 channel 当前的待处理交互卡（新订阅者 replay 用）。 */
export function getPendingInteraction(channelId: string): WebStreamEvent | undefined {
  return pendingInteraction.get(channelId);
}

export function subscribeWeb(channelId: string, sink: Sink): () => void {
  let set = subscribers.get(channelId);
  if (!set) {
    set = new Set();
    subscribers.set(channelId, set);
  }
  set.add(sink);
  return () => {
    const s = subscribers.get(channelId);
    if (!s) return;
    s.delete(sink);
    if (s.size === 0) subscribers.delete(channelId);
  };
}

export function pushToWeb(channelId: string, event: WebStreamEvent): void {
  const set = subscribers.get(channelId);
  if (!set) return;
  for (const sink of set) {
    try {
      sink(event);
    } catch {
      /* 订阅者已断开，忽略 */
    }
  }
}

export function hasWebSubscribers(channelId: string): boolean {
  return (subscribers.get(channelId)?.size ?? 0) > 0;
}
