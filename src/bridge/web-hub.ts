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

export type WebStreamEvent =
  | { t: "status"; status: "running" | "done" }
  | { t: "tool"; name: string; summary: string; state: "running" | "done" | "error" }
  | { t: "text"; text: string }
  | { t: "done" }
  | { t: "error"; error: string };

/** 合成的本地 channelId（Web-only 无 Discord 频道时用）。 */
export function isLocalChannelId(channelId: string): boolean {
  return channelId.startsWith("local-");
}

type Sink = (event: WebStreamEvent) => void;

// key = channelId
const subscribers = new Map<string, Set<Sink>>();

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
