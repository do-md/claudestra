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
  unwrapChannelMessage,
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

// [fork] channel 入站消息解包（web/API/Discord 用户消息在 jsonl 里是 isMeta + <channel> 包装）
describe("unwrapChannelMessage", () => {
  const wrap = (attrs: string, body: string) => `<channel ${attrs}>\n${body}\n</channel>`;

  test("API 用户消息：剥 wrapper + [🌐 …] header，提取 user 属性", () => {
    const raw = wrap(
      'source="claudestra" chat_id="api:tok_x" user="web-ui" user_id="api:tok_x" api="true"',
      "[🌐 来自 API 用户「web-ui」（外部 token 接入，非 Discord）。\n直接用 reply() 回答到本 chat_id 即可；对方看不到本频道历史。]\n\n帮我修一下渲染"
    );
    expect(unwrapChannelMessage(raw)).toEqual({ text: "帮我修一下渲染", from: "web-ui" });
  });

  test("agent↔agent：剥 [🤖 …] header（header 内含 ] 不截断正文）", () => {
    const raw = wrap(
      'source="claudestra" chat_id="local-x" user="cstra-dev"',
      "[🤖 来自 master 的 inbound 消息（非 FYI）。\n判断一下：[DIRECT] 标记的要处理。]\n\n请检查 [这个] 模块"
    );
    expect(unwrapChannelMessage(raw)).toEqual({ text: "请检查 [这个] 模块", from: "cstra-dev" });
  });

  test("无 header 的 channel 消息原样保留（以 [ 开头的真实输入不误伤）", () => {
    const raw = wrap('chat_id="discord:123" user="tao"', "[临时] 看下这个报错");
    expect(unwrapChannelMessage(raw)).toEqual({ text: "[临时] 看下这个报错", from: "tao" });
  });

  test("非 channel 包装（caveat 等真 meta）返回 null", () => {
    expect(unwrapChannelMessage("Caveat: the messages below were generated…")).toBeNull();
    expect(unwrapChannelMessage("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
  });

  test("readSessionHistory：channel 包装的 isMeta user 进历史，caveat meta 照旧过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      { type: "user", isMeta: true, timestamp: "2026-07-01T00:00:00Z", message: { content: "caveat 元信息" } },
      {
        type: "user",
        isMeta: true,
        timestamp: "2026-07-01T00:01:00Z",
        message: { content: '<channel source="claudestra" chat_id="api:tok_x" user="web-ui">\n[🌐 来自 API 用户「web-ui」（外部 token 接入，非 Discord）。\n直接 reply() 即可。]\n\n你好呀\n</channel>' },
      },
      { type: "assistant", timestamp: "2026-07-01T00:02:00Z", message: { content: [{ type: "text", text: "你好" }] } },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0].text).toBe("你好呀");
    expect(page.messages[0].from).toBe("web-ui");
  });
});

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

  test("[fork] reply() tool_use 提取成 replyText（不当工具卡），叙述与回复分开", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      { type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "问题" } },
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: {
          content: [
            { type: "text", text: "让我看看" },
            { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
            { type: "tool_use", name: "mcp__claudestra__reply", input: { chat_id: "api:x", text: "**结论**：好了" } },
          ],
        },
      },
    ]);
    const page = await readSessionHistory(p, { formatToolFn: (n) => n });
    const asst = page.messages.find((m) => m.role === "assistant")!;
    expect(asst.text).toBe("让我看看"); // 过程叙述
    expect(asst.replyText).toBe("**结论**：好了"); // reply 正文被提取（否则历史里蒸发）
    expect(asst.tools?.map((t) => t.name)).toEqual(["Read"]); // reply 不再混进工具卡
  });

  test("[fork] 纯 reply（无叙述、无其它工具）也保留：text 空 + replyText 有值", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const p = writeJsonl(dir, `${SID}.jsonl`, [
      {
        type: "assistant",
        timestamp: "2026-07-01T00:01:00Z",
        message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text: "只有回复" } }] },
      },
    ]);
    const page = await readSessionHistory(p);
    expect(page.messages.length).toBe(1);
    expect(page.messages[0].text).toBe("");
    expect(page.messages[0].replyText).toBe("只有回复");
    expect(page.messages[0].tools).toBeUndefined();
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
