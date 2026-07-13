/**
 * slash-registry 单测：resolveInvocation / isProjectSkillForOtherAgent / allRegistrableCommands
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  scanGlobal,
  scanProject,
  clearProject,
  allRegistrableCommands,
  resolveInvocation,
  resolveWebInvocation,
  isProjectSkillForOtherAgent,
  debugSnapshot,
} from "../src/bridge/slash-registry.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function setupFakeProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reg-test-"));
  const skillDir = join(dir, ".claude", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\nuser-invocable: true\n---\nbody`
  );
  return dir;
}

describe("slash-registry", () => {
  beforeEach(async () => {
    // 重置注册表到仅 built-in + native + 尝试扫真实系统
    await scanGlobal();
    // 清掉任何可能残留的 project skill
    const snap = debugSnapshot();
    for (const agent of Object.keys(snap.project)) clearProject(agent);
  });

  test("built-in 命令永远可用", () => {
    const r = resolveInvocation("cost", null, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ccText).toBe("/cost");
      expect(r.scope).toBe("builtin");
    }
  });

  test("未知命令返回 error", () => {
    const r = resolveInvocation("no-such-command-xyz", null, {});
    expect(r.ok).toBe(false);
  });

  test("project skill 隔离：agent A 的 skill 对 agent B 不可见", async () => {
    const dirA = setupFakeProject("alpha-skill");
    try {
      await scanProject("agent-A", dirA);

      // agent A 自己能用
      const okA = resolveInvocation("alpha-skill", "agent-A", {});
      expect(okA.ok).toBe(true);

      // agent B 全局里没这个 skill → unknown
      const bad = resolveInvocation("alpha-skill", "agent-B", {});
      expect(bad.ok).toBe(false);

      // 并且 isProjectSkillForOtherAgent 能识别是 agent-A 独有
      const owner = isProjectSkillForOtherAgent("alpha-skill", "agent-B");
      expect(owner).toBe("agent-A");
    } finally {
      clearProject("agent-A");
      rmSync(dirA, { recursive: true, force: true });
    }
  });

  test("native skill 对所有 agent 都可用", () => {
    const r = resolveInvocation("simplify", null, { args: "focus on tests" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ccText).toBe("/simplify focus on tests");
      expect(r.scope).toBe("native");
    }
  });

  test("built-in argBuilder 组装参数", () => {
    const r = resolveInvocation("effort", null, { level: "xhigh" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ccText).toBe("/effort xhigh");
  });

  test("allRegistrableCommands 去重 builtin 名", () => {
    const all = allRegistrableCommands();
    const names = all.map((x) =>
      x.kind === "builtin" ? x.cmd.name : x.skill.discordName
    );
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  test("clearProject 移除 agent 的 project skill", async () => {
    const dir = setupFakeProject("temp-skill");
    try {
      await scanProject("agent-X", dir);
      expect(resolveInvocation("temp-skill", "agent-X", {}).ok).toBe(true);

      clearProject("agent-X");
      expect(resolveInvocation("temp-skill", "agent-X", {}).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [fork] resolveWebInvocation：web 自由文本参数路径
  test("resolveWebInvocation: builtin 自由文本参数不丢失", () => {
    const r = resolveWebInvocation("compact", null, "保留最近的对话重点");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // resolveInvocation 的 argBuilder 按 Discord option 名(vals.instructions)取值,
      // web 只有裸 args —— 直通拼接是修复点(丢参 bug,2026-07-14 review)
      expect(r.ccText).toBe("/compact 保留最近的对话重点");
      expect(r.scope).toBe("builtin");
    }
  });

  test("resolveWebInvocation: builtin 无参数保持裸命令", () => {
    const r = resolveWebInvocation("cost", null, "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ccText).toBe("/cost");
  });

  test("resolveWebInvocation: project skill 带参数走 vals.args", async () => {
    const dir = setupFakeProject("web-skill");
    try {
      await scanProject("agent-W", dir);
      const r = resolveWebInvocation("web-skill", "agent-W", "some args");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.ccText).toBe("/web-skill some args");
    } finally {
      clearProject("agent-W");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveWebInvocation: 未知命令返回 error", () => {
    const r = resolveWebInvocation("no-such-cmd-web", null, "x");
    expect(r.ok).toBe(false);
  });
});
