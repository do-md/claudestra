/**
 * agent-stats readFileStats 单测 —— 重点：compact 后的上下文估算
 * （owner 2026-07-10 报告：compact 完很久不聊天，看板一直显示压缩前的大数）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileStats, POST_COMPACT_BASE_TOKENS } from "../src/lib/agent-stats.js";

let seq = 0;
function mkJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-stats-test-"));
  const path = join(dir, `session-${seq++}.jsonl`);
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return path;
}

const now = new Date().toISOString();

function assistantUsage(input: number, cacheRead: number, model = "claude-fable-5") {
  return {
    type: "assistant",
    timestamp: now,
    message: {
      model,
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 100 },
    },
  };
}

describe("readFileStats compact 感知", () => {
  test("无 compact：上下文 = 尾部第一条 usage", async () => {
    const path = mkJsonl([assistantUsage(1000, 400_000), assistantUsage(2000, 500_000)]);
    const s = await readFileStats(path);
    expect(s.contextTokens).toBe(502_000);
    expect(s.contextEstimated).toBe(false);
    expect(s.model).toBe("claude-fable-5");
  });

  test("compact 后无新对话：估算 = 底座 + 摘要/4，标记 estimated，model 仍取压缩前", async () => {
    const summary = "x".repeat(8000);
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      { type: "system", subtype: "compact_boundary", timestamp: now },
      { type: "user", isCompactSummary: true, timestamp: now, message: { role: "user", content: summary } },
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(true);
    expect(s.contextTokens).toBe(POST_COMPACT_BASE_TOKENS + 2000);
    expect(s.contextTokens).toBeLessThan(100_000); // 不再是压缩前的 50 万
    expect(s.model).toBe("claude-fable-5");
  });

  test("compact 后已有新对话：回到 usage 实测，不再估算", async () => {
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      { type: "system", subtype: "compact_boundary", timestamp: now },
      { type: "user", isCompactSummary: true, timestamp: now, message: { role: "user", content: "summary" } },
      assistantUsage(3000, 55_000),
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(false);
    expect(s.contextTokens).toBe(58_000);
  });

  test("摘要是 content block 数组也能估算", async () => {
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      {
        type: "user",
        isCompactSummary: true,
        timestamp: now,
        message: { role: "user", content: [{ type: "text", text: "y".repeat(4000) }] },
      },
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(true);
    expect(s.contextTokens).toBe(POST_COMPACT_BASE_TOKENS + 1000);
  });
});
