/**
 * v2.9+ 会话历史解析单测：jsonl → 中性消息 / 分页 / session 清单合并 / 参数校验
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSessionHistory,
  listAgentSessions,
  listSubagentFiles,
  isValidSessionId,
  isValidSubagentId,
} from "../src/lib/session-history.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function writeJsonl(dir: string, name: string, records: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const SAMPLE = [
  { type: "mode", sessionId: SID }, // 非消息条目 → 忽略
  { type: "user", isMeta: true, timestamp: "2026-07-01T00:00:00Z", message: { content: "caveat 元信息" } },
  { type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "第一条用户消息" } },
  {
    type: "assistant",
    timestamp: "2026-07-01T00:02:00Z",
    message: {
      model: "claude-fable-5",
      content: [
        { type: "text", text: "我来处理" },
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
      ],
    },
  },
  // 纯 tool_result 载荷的 user 条目 → 过滤
  { type: "user", timestamp: "2026-07-01T00:03:00Z", message: { content: [{ type: "tool_result", content: "..." }] } },
  { type: "system", subtype: "compact_boundary", timestamp: "2026-07-01T00:04:00Z" },
  { type: "user", isCompactSummary: true, timestamp: "2026-07-01T00:04:01Z", message: { content: [{ type: "text", text: "压缩摘要全文" }] } },
  { type: "user", timestamp: "2026-07-01T00:05:00Z", message: { content: "第二条用户消息" } },
];

describe("readSessionHistory", () => {
  test("解析：过滤 meta/tool_result，保留 user/assistant/compact 边界与摘要", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, SAMPLE);
    const page = await readSessionHistory(p, { formatToolFn: (n, i) => `${n} ${i?.file_path ?? ""}`.trim() });
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
    const roles = page.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "system", "user", "user"]);
    expect(page.messages[1].tools?.[0].summary).toBe("Read /a.ts");
    expect(page.messages[1].model).toBe("claude-fable-5");
    expect(page.messages[2].text).toContain("压缩");
    expect(page.messages[3].compactSummary).toBe(true);
    expect(page.messages[4].text).toBe("第二条用户消息");
  });

  test("分页：默认取尾部，before 往前翻，hasMore 正确", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, SAMPLE);
    const last2 = await readSessionHistory(p, { limit: 2 });
    expect(last2.messages.length).toBe(2);
    expect(last2.hasMore).toBe(true);
    expect(last2.messages[1].text).toBe("第二条用户消息");
    // 用第一页开头的 seq 往前翻
    const prev = await readSessionHistory(p, { limit: 2, before: last2.messages[0].seq });
    expect(prev.messages.length).toBe(2);
    expect(prev.messages.at(-1)!.seq).toBeLessThan(last2.messages[0].seq);
    // 翻到头
    const first = await readSessionHistory(p, { limit: 100, before: prev.messages[0].seq });
    expect(first.hasMore).toBe(false);
  });
});

describe("listAgentSessions", () => {
  test("归档打底 + live 更大覆盖 + subagents 同构发现", async () => {
    const base = mkdtempSync(join(tmpdir(), "hist-list-"));
    const archiveRoot = join(base, "archive");
    const agentDir = join(archiveRoot, "agent-x");
    mkdirSync(agentDir, { recursive: true });
    writeJsonl(agentDir, `${SID}.jsonl`, SAMPLE.slice(0, 3)); // 归档较小
    const subDir = join(agentDir, SID, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeJsonl(subDir, "agent-sub1.jsonl", [SAMPLE[2]]);

    const liveDir = join(base, "live");
    mkdirSync(liveDir, { recursive: true });
    const livePath = writeJsonl(liveDir, `${SID}.jsonl`, SAMPLE); // live 更大

    const sessions = await listAgentSessions("agent-x", {
      cwd: "/whatever",
      archiveRoot,
      livePathFor: (_cwd, sid) => join(liveDir, `${sid}.jsonl`),
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].source).toBe("live");
    expect(sessions[0].path).toBe(livePath);

    // live 没有 subagents 目录 → 空；归档侧的要从归档路径读
    expect(sessions[0].subagents).toEqual([]);
    expect(listSubagentFiles(join(agentDir, `${SID}.jsonl`))).toEqual(["agent-sub1"]);
  });

  test("无 cwd（agent 已 kill）只列归档；current session 无归档也可见", async () => {
    const base = mkdtempSync(join(tmpdir(), "hist-list-"));
    const archiveRoot = join(base, "archive");
    const agentDir = join(archiveRoot, "agent-x");
    mkdirSync(agentDir, { recursive: true });
    writeJsonl(agentDir, `${SID}.jsonl`, SAMPLE.slice(0, 3));

    const archOnly = await listAgentSessions("agent-x", { archiveRoot });
    expect(archOnly.length).toBe(1);
    expect(archOnly[0].source).toBe("archive");

    // current session 只有 live 文件（还没归档过）
    const liveDir = join(base, "live");
    mkdirSync(liveDir, { recursive: true });
    const curSid = "11111111-2222-3333-4444-555555555555";
    writeJsonl(liveDir, `${curSid}.jsonl`, SAMPLE);
    const both = await listAgentSessions("agent-x", {
      cwd: "/whatever",
      currentSessionId: curSid,
      archiveRoot,
      livePathFor: (_cwd, sid) => join(liveDir, `${sid}.jsonl`),
    });
    expect(both.length).toBe(2);
    expect(both.find((s) => s.sessionId === curSid)?.source).toBe("live");
  });
});

describe("参数校验（拼路径前的白名单）", () => {
  test("sessionId：uuid 形态过，路径穿越不过", () => {
    expect(isValidSessionId(SID)).toBe(true);
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });
  test("subagent id：agent-xxx 过，其他不过", () => {
    expect(isValidSubagentId("agent-a1B_-x")).toBe(true);
    expect(isValidSubagentId("agent-../x")).toBe(false);
    expect(isValidSubagentId("nope")).toBe(false);
  });
});
