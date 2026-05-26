#!/usr/bin/env bun
/**
 * `claudestra` — one-shot launcher
 *
 * 打一句 `claudestra` 就把整个系统拉起来：
 *  1. 确认 pm2 三个 daemon (bridge / launcher / cron) 在跑；没跑就靠
 *     ecosystem.config.cjs 起；
 *  2. 检测当前是不是 iTerm；
 *     - 在 iTerm：当前窗口直接 `tmux -CC attach`，拿到 native tab 形态的 master UI；
 *     - 不在 iTerm：AppleScript 唤起 iTerm + 新建窗口 + 跑 attach。
 *
 * 安装方式：`manager.ts install-cli` 在 ~/.bun/bin/claudestra 写一个 shell 壳子，
 * 壳子 exec 这个 .ts。REPO_ROOT 自带（壳子里硬编码），所以 cli 知道去哪找
 * ecosystem.config.cjs 和 master tmux socket。
 */

import { spawnSync } from "child_process";

// 安装脚本写 wrapper 时把这俩注入到环境变量里，cli 直接读。
const REPO_ROOT = process.env.CLAUDESTRA_REPO || ".";
const TMUX_SOCK = process.env.CLAUDESTRA_SOCK || "/tmp/claude-orchestrator/master.sock";
const ECOSYSTEM = `${REPO_ROOT}/ecosystem.config.cjs`;
const NEEDED_PM2 = ["discord-bridge", "master-launcher", "cron-scheduler"] as const;
const ATTACH_CMD = `tmux -S ${TMUX_SOCK} -CC attach -t master`;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function info(s: string) { process.stdout.write(`${C.dim}▶${C.reset} ${s}\n`); }
function ok(s: string) { process.stdout.write(`${C.green}✓${C.reset} ${s}\n`); }
function fail(s: string) { process.stderr.write(`${C.red}✗${C.reset} ${s}\n`); }
function warn(s: string) { process.stdout.write(`${C.yellow}⚠${C.reset} ${s}\n`); }

function run(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

/** 检查 pm2 是否安装 + 三个 daemon 是否在线，缺谁起谁。 */
async function ensurePm2Daemons(): Promise<boolean> {
  // pm2 是否能跑
  const probe = run("pm2", ["--version"]);
  if (probe.code !== 0) {
    fail(`pm2 不可用：${probe.err.trim() || "找不到 pm2"}。请先 \`bun install -g pm2\` 或装包到 PATH。`);
    return false;
  }
  // 取当前进程列表
  const list = run("pm2", ["jlist"]);
  let onlineNames = new Set<string>();
  if (list.code === 0) {
    try {
      const procs = JSON.parse(list.out || "[]") as Array<{ name: string; pm2_env?: { status?: string } }>;
      onlineNames = new Set(
        procs.filter((p) => p.pm2_env?.status === "online").map((p) => p.name)
      );
    } catch { /* 解析失败当全空 */ }
  }
  const missing = NEEDED_PM2.filter((n) => !onlineNames.has(n));
  if (missing.length === 0) {
    ok(`pm2 三个 daemon 都在跑 (${NEEDED_PM2.join(", ")})`);
    return true;
  }
  info(`pm2 daemon 缺 ${missing.length}/${NEEDED_PM2.length} (${missing.join(", ")})，启动…`);
  const start = run("pm2", ["start", ECOSYSTEM]);
  if (start.code !== 0) {
    fail(`pm2 start 失败：${start.err.trim() || start.out.trim()}`);
    return false;
  }
  ok("pm2 daemon 起来了");
  return true;
}

/** 接 master tmux session — 当前在 iTerm 就内联跑，否则 AppleScript 开新窗口。 */
function attachMaster(): never {
  // 已在 tmux 里：tmux 拒绝嵌套 attach（会报 "sessions should be nested with care"）。
  // 干净退出 + 告诉用户接的正确姿势，别蠢蠢地去尝试 nested。
  if (process.env.TMUX) {
    info(`已在 tmux 里 (${process.env.TMUX.split(",")[0]})，跳过 attach 避免嵌套。`);
    info("要进 master TUI，请在 iTerm 外层（非 tmux）shell 里再跑 claudestra；");
    info("如果你只是想从当前 tmux 接到 master，跑：");
    console.log(`  ${C.cyan}${ATTACH_CMD}${C.reset}`);
    info("（pm2 daemon 状态已在上面打印，不用再起）");
    process.exit(0);
  }
  const inITerm = process.env.TERM_PROGRAM === "iTerm.app";
  if (inITerm) {
    info("在 iTerm 里，本窗口直接 attach…");
    // exec 替换当前进程，tmux 接管 stdio
    const r = spawnSync("/bin/sh", ["-c", ATTACH_CMD], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  info("不在 iTerm，AppleScript 唤起 iTerm 新窗口…");
  // AppleScript 字符串里把双引号转义
  const cmdForAS = ATTACH_CMD.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow to write text "${cmdForAS}"
end tell`;
  const r = run("osascript", ["-e", script]);
  if (r.code === 0) {
    ok("已在 iTerm 打开新窗口并 attach 到 master");
    process.exit(0);
  } else {
    fail(`osascript 失败：${r.err.trim() || r.out.trim()}`);
    warn(`手动跑：${C.cyan}${ATTACH_CMD}${C.reset}`);
    process.exit(1);
  }
}

(async () => {
  console.log(`${C.bold}${C.cyan}🚀 Claudestra${C.reset}${C.dim} ↗ ${REPO_ROOT}${C.reset}`);
  const pm2Ok = await ensurePm2Daemons();
  if (!pm2Ok) {
    warn("pm2 没起来，跳过 attach。看日志：pm2 logs");
    process.exit(1);
  }
  attachMaster();
})();
