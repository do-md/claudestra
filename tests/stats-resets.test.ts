/**
 * v2.9.1+ fixSessionAmPm 单测 —— Claude Code /status 面板 5h reset 的 am/pm
 * 反转纠正（2026-07-10 实测：JST 14:38 抓到 "Resets 5am"，真实是 5pm）。
 * scrapedAt 与期望值都用本地时区构造，任何时区跑测试结论一致。
 */

import { describe, test, expect } from "bun:test";
import { fixSessionAmPm } from "../src/bridge/stats-dashboard.js";

/** 今天本地 hh:mm 的时间戳 */
function at(h: number, m = 0): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

describe("fixSessionAmPm", () => {
  test("实测案例：下午 14:38 显示 5am → 纠正为 5pm", () => {
    expect(fixSessionAmPm("5am (Asia/Tokyo)", at(14, 38))).toBe("5pm (Asia/Tokyo)");
  });

  test("原值合理不动：14:38 显示 5pm（2.4h 后，≤5h）", () => {
    expect(fixSessionAmPm("5pm (Asia/Tokyo)", at(14, 38))).toBe("5pm (Asia/Tokyo)");
  });

  test("带分钟：14:00 显示 4:30am → 4:30pm", () => {
    expect(fixSessionAmPm("4:30am (Asia/Tokyo)", at(14, 0))).toBe("4:30pm (Asia/Tokyo)");
  });

  test("都不合理不瞎猜：凌晨 2:00 显示 9am（7h 后）翻转 9pm（19h 后）→ 原样", () => {
    expect(fixSessionAmPm("9am (Asia/Tokyo)", at(2, 0))).toBe("9am (Asia/Tokyo)");
  });

  test("12am/12pm 边界：23:00 显示 12pm（13h 后）→ 12am（明天 0 点，1h 后）", () => {
    expect(fixSessionAmPm("12pm (Asia/Tokyo)", at(23, 0))).toBe("12am (Asia/Tokyo)");
  });

  test("解析不了的格式（周 reset 等）原样返回", () => {
    expect(fixSessionAmPm("Jul 15 at 6am (Asia/Tokyo)", at(14, 0))).toBe("Jul 15 at 6am (Asia/Tokyo)");
    expect(fixSessionAmPm("", at(14, 0))).toBe("");
  });
});
