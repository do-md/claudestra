/**
 * v2.8+ 会话归档单测：快照复制 / 只在更大时覆盖 / subagents 同行 / 源缺失容错
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { archiveSession } from "../src/lib/session-archive.js";

const SID = "11111111-2222-3333-4444-555555555555";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "archive-test-"));
  const srcDir = join(base, "projects-slug");
  mkdirSync(srcDir, { recursive: true });
  const srcPath = join(srcDir, `${SID}.jsonl`);
  writeFileSync(srcPath, '{"type":"assistant"}\n{"type":"user"}\n');
  return { base, srcPath, archiveRoot: join(base, "archive") };
}

describe("archiveSession", () => {
  test("首次归档：复制主 jsonl 到 archive/<agent>/", async () => {
    const { srcPath, archiveRoot } = setup();
    const r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.ok).toBe(true);
    expect(r.archived.length).toBe(1);
    const dest = join(archiveRoot, "agent-x", `${SID}.jsonl`);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain('"assistant"');
  });

  test("重复归档：源更大才覆盖，缩水不回写", async () => {
    const { srcPath, archiveRoot } = setup();
    await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    // 源变小（不该覆盖）
    writeFileSync(srcPath, "{}\n");
    let r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(0);
    const dest = join(archiveRoot, "agent-x", `${SID}.jsonl`);
    expect(readFileSync(dest, "utf8")).toContain('"assistant"');
    // 源变大（应覆盖）
    writeFileSync(srcPath, '{"type":"assistant"}\n{"type":"user"}\n{"type":"assistant","more":1}\n');
    r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(1);
    expect(readFileSync(dest, "utf8")).toContain('"more"');
  });

  test("subagents 目录一并归档", async () => {
    const { srcPath, archiveRoot } = setup();
    const subDir = join(srcPath.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-abc.jsonl"), '{"type":"assistant"}\n');
    const r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(2);
    expect(existsSync(join(archiveRoot, "agent-x", SID, "subagents", "agent-abc.jsonl"))).toBe(true);
  });

  test("源不存在：ok:false 不抛错", async () => {
    const { archiveRoot } = setup();
    const r = await archiveSession("agent-x", undefined, "99999999-9999-9999-9999-999999999999", {
      srcPath: "/no/such/file.jsonl",
      archiveRoot,
    });
    expect(r.ok).toBe(false);
  });
});
