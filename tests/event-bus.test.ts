/**
 * v2.6.0+ event-bus 测试：emit / subscribe / replay / 环形淘汰 / 过滤。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  emitEvent,
  subscribeEvents,
  replayEventsSince,
  subscriberCount,
  RING_LIMIT,
  __resetEventBusForTest,
  type BridgeEvent,
} from "../src/bridge/event-bus.js";

function mk(agent: string, type: BridgeEvent["type"] = "assistant_text", data: Record<string, unknown> = {}) {
  return emitEvent({ agent, chatId: `chan-${agent}`, type, data });
}

beforeEach(() => {
  __resetEventBusForTest();
});

describe("emitEvent", () => {
  test("seq 单调递增，ts 自动补齐", () => {
    const a = mk("alpha");
    const b = mk("alpha");
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toBeTruthy();
    expect(Date.parse(a.ts)).toBeGreaterThan(0);
  });

  test("字段原样保留", () => {
    const e = emitEvent({ agent: "x", chatId: "api:tok_1", type: "chat_message", data: { direction: "out", text: "hi" } });
    expect(e.agent).toBe("x");
    expect(e.chatId).toBe("api:tok_1");
    expect(e.data.direction).toBe("out");
  });
});

describe("subscribeEvents", () => {
  test("实时收到 + 取消后不再收", () => {
    const got: number[] = [];
    const unsub = subscribeEvents({}, (e) => got.push(e.seq));
    mk("a");
    mk("b");
    expect(got).toEqual([1, 2]);
    unsub();
    mk("a");
    expect(got).toEqual([1, 2]);
    expect(subscriberCount()).toBe(0);
  });

  test("agent 过滤", () => {
    const got: string[] = [];
    subscribeEvents({ agent: "alpha" }, (e) => got.push(e.agent));
    mk("alpha");
    mk("bravo");
    mk("alpha");
    expect(got).toEqual(["alpha", "alpha"]);
  });

  test("agents 白名单过滤（token scope）", () => {
    const got: string[] = [];
    subscribeEvents({ agents: ["a1", "a2"] }, (e) => got.push(e.agent));
    mk("a1");
    mk("a3");
    mk("a2");
    expect(got).toEqual(["a1", "a2"]);
  });

  test("订阅者回调抛异常不影响后续订阅者与主流程", () => {
    const got: number[] = [];
    subscribeEvents({}, () => { throw new Error("boom"); });
    subscribeEvents({}, (e) => got.push(e.seq));
    expect(() => mk("a")).not.toThrow();
    expect(got).toEqual([1]);
  });
});

describe("replayEventsSince", () => {
  test("按 seq 补发，跨 agent 合并有序", () => {
    mk("a"); // 1
    mk("b"); // 2
    mk("a"); // 3
    const replay = replayEventsSince(1);
    expect(replay.map((e) => e.seq)).toEqual([2, 3]);
  });

  test("since=0 拿全部缓冲；filter 生效", () => {
    mk("a");
    mk("b");
    expect(replayEventsSince(0).length).toBe(2);
    expect(replayEventsSince(0, { agent: "b" }).length).toBe(1);
  });

  test("环形淘汰：每 agent 只留最近 RING_LIMIT 条", () => {
    for (let i = 0; i < RING_LIMIT + 50; i++) mk("a");
    const replay = replayEventsSince(0, { agent: "a" });
    expect(replay.length).toBe(RING_LIMIT);
    // 最早的 50 条被淘汰，第一条 seq = 51
    expect(replay[0].seq).toBe(51);
    expect(replay[replay.length - 1].seq).toBe(RING_LIMIT + 50);
  });

  test("淘汰是 per-agent 的，不互相挤占", () => {
    for (let i = 0; i < RING_LIMIT + 10; i++) mk("big");
    mk("small");
    expect(replayEventsSince(0, { agent: "small" }).length).toBe(1);
    expect(replayEventsSince(0, { agent: "big" }).length).toBe(RING_LIMIT);
  });
});
