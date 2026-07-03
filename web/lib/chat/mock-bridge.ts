import type { WebStreamEvent } from "./events";

/**
 * Mock Bridge —— 进程内 pub/sub，忠实模拟真实 Bridge 的「持久 stream 订阅 + fire-and-forget inject」模型。
 *
 * 真实架构里：GET /web/stream 订阅某 agent 的输出流；POST /web/inject 把用户消息投给 agent，
 * agent 的 jsonl-watcher 输出经 Bridge 推回订阅者。inject 与 stream 是两个独立请求，靠 Bridge 内的
 * pub/sub 关联。此处用同样的 pub/sub 形状，让前端在 mock 与真实 Bridge 下代码完全一致。
 *
 * prin-0df44f：挂 globalThis 防 dev HMR 重复初始化。
 */

type Listener = (event: WebStreamEvent) => void;

class MockBridge {
  private channels = new Map<string, Set<Listener>>();

  subscribe(agent: string, listener: Listener): () => void {
    let set = this.channels.get(agent);
    if (!set) {
      set = new Set();
      this.channels.set(agent, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.channels.delete(agent);
    };
  }

  publish(agent: string, event: WebStreamEvent) {
    const set = this.channels.get(agent);
    if (!set) return;
    for (const l of set) {
      try {
        l(event);
      } catch {
        /* listener 已断开，忽略 */
      }
    }
  }

  hasSubscribers(agent: string): boolean {
    return (this.channels.get(agent)?.size ?? 0) > 0;
  }

  /**
   * 模拟 agent 收到用户消息后的一轮输出：几条工具摘要 + 助手文本段 + 收尾。
   * 用递增延时逼近真实流式节奏。真实 Bridge 接入后，这段被 /web/inject → jsonl-watcher 取代。
   */
  simulateAgentReply(agent: string, userText: string) {
    const steps: Array<{ delay: number; event: WebStreamEvent }> = [
      { delay: 200, event: { t: "status", status: "running" } },
      {
        delay: 500,
        event: { t: "tool", name: "Read", summary: "src/bridge.ts", state: "done" },
      },
      {
        delay: 500,
        event: {
          t: "tool",
          name: "Grep",
          summary: `"${userText.slice(0, 24)}" in src/`,
          state: "done",
        },
      },
      { delay: 400, event: { t: "text", text: "收到你的消息：" } },
      { delay: 300, event: { t: "text", text: `「${userText}」。\n\n` } },
      {
        delay: 400,
        event: {
          t: "text",
          text: "这是 mock Bridge 生成的模拟回复——真实 Bridge 接入后，这里会是目标 Claude Code 会话经 jsonl-watcher 推回的工具调用与助手文本流。",
        },
      },
      { delay: 200, event: { t: "done" } },
      { delay: 0, event: { t: "status", status: "done" } },
    ];

    let acc = 0;
    for (const step of steps) {
      acc += step.delay;
      setTimeout(() => this.publish(agent, step.event), acc);
    }
  }
}

const g = globalThis as unknown as { __claudestraMockBridge?: MockBridge };
if (!g.__claudestraMockBridge) {
  g.__claudestraMockBridge = new MockBridge();
}
export const mockBridge = g.__claudestraMockBridge;
