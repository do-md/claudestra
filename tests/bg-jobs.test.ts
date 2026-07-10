/**
 * v2.9.1+ bg-jobs roster 根治单测（2026-07-10 d170ecbc 破案配方）。
 * kill 目标全部用不存在的假 pid（process.kill 抛 ESRCH 被内部 catch），不碰真进程。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { tryRosterCleanup } from "../src/lib/bg-jobs.js";

const DEAD_PID = 999_999_999; // 超出 pid 范围，必然不存在

function writeRoster(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "roster-test-"));
  const p = join(dir, "roster.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("tryRosterCleanup", () => {
  test("roster 只有目标 worker → 根治：删条目并写回", async () => {
    const p = writeRoster({
      proto: 1,
      supervisorPid: DEAD_PID,
      workers: { d170ecbc: { pid: DEAD_PID, sessionId: "d170ecbc-xxx" } },
    });
    const r = await tryRosterCleanup("d170ecbc", p);
    expect(r.done).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.workers).toEqual({});
    expect(after.supervisorPid).toBe(DEAD_PID); // 其他字段保留
  });

  test("daemon 还管着其他 worker → 不动 daemon，roster 原样", async () => {
    const roster = {
      supervisorPid: DEAD_PID,
      workers: {
        d170ecbc: { pid: DEAD_PID },
        otherjob: { pid: DEAD_PID },
      },
    };
    const p = writeRoster(roster);
    const r = await tryRosterCleanup("d170ecbc", p);
    expect(r.done).toBe(false);
    expect(r.note).toContain("其他");
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(roster);
  });

  test("roster 无该条目 / 文件缺失 → done:false 不抛", async () => {
    const p = writeRoster({ supervisorPid: DEAD_PID, workers: {} });
    expect((await tryRosterCleanup("d170ecbc", p)).done).toBe(false);
    expect((await tryRosterCleanup("d170ecbc", "/no/such/roster.json")).done).toBe(false);
  });
});
