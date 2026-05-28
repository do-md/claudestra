/**
 * v2.4.0+：把 Claudestra 的 3 个 daemon 从 pm2 解耦，让 macOS launchd 直接管。
 *
 * 为啥换掉 pm2 启动链：
 *   - pm2 是 Node 写的，依赖一个能跑的 Node 实例。Node 又依赖一堆 dylib（icu4c
 *     之类）。brew 升级 icu4c / OpenSSL / libuv 都可能把 homebrew node 弄废，
 *     pm2 跟着挂；env-node 在 LaunchAgent PATH 里抓到 brew node 反而比 nvm 优先。
 *   - 用户的 node 装哪儿（nvm / fnm / asdf / volta / 系统 brew）千差万别，不能假设。
 *   - launchd 是 macOS 内置，永远在；Bun 是项目硬依赖（bridge / launcher / cron
 *     都跑在 bun 上），路径已经知道。组合起来就一条干净启动链：
 *         /Users/<user>/.bun/bin/bun  /repo/src/X.ts
 *     完全不依赖 node / pm2 / brew。
 *
 * 这个模块装/迁移以下东西（idempotent，每次 install-cli / update 都跑一次也无害）：
 *   1) `claudestra` CLI wrapper → ~/.local/bin/claudestra（XDG 标准，多数 PATH
 *      默认带它）+ ~/.bun/bin/claudestra symlink（兜底覆盖另一种常见 PATH）
 *   2) 三个 user-level LaunchAgent：
 *        com.claudestra.bridge.plist    → bun src/bridge.ts
 *        com.claudestra.launcher.plist  → bun src/launcher.ts
 *        com.claudestra.cron.plist      → bun src/cron.ts
 *      每个都 RunAtLoad=true（开机自启）+ KeepAlive=true（crash 自动重启，替代
 *      pm2 restart_delay）+ ThrottleInterval=10s（防 crash loop）。
 *   3) 迁移：把旧 com.claudestra.autostart.plist（v2.3.x，跑 pm2）+ 旧
 *      pm2.<user>.plist（pm2 startup 装的）unload 并 .bak 备份；把还在跑的 pm2
 *      daemon（discord-bridge / master-launcher / cron-scheduler）stop 掉，
 *      免得跟新 launchd 守护互相打架。
 *   4) 启动新 plist（launchctl bootout 容错 + bootstrap）。
 *
 * pm2 本身没卸：用户想 `pm2 logs` 看历史还能用。`ecosystem.config.cjs` 留着供
 * 临时手动启动 / 老熟人怀旧。但**启动链不再走 pm2**。
 */

import { mkdir, writeFile, chmod, stat, rename, unlink, symlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";

const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";

/** 3 个 daemon 的 launchd 定义。改这里 = 改启动链。 */
export const DAEMONS = [
  { label: "com.claudestra.bridge",   script: "src/bridge.ts",   stem: "bridge" },
  { label: "com.claudestra.launcher", script: "src/launcher.ts", stem: "launcher" },
  { label: "com.claudestra.cron",     script: "src/cron.ts",     stem: "cron" },
] as const;

/** 老 pm2 启动名（用于 stop 老的、避免跟新 launchd 抢） */
const LEGACY_PM2_NAMES = ["discord-bridge", "master-launcher", "cron-scheduler"];

export interface DaemonInstall {
  label: string;
  plistPath: string;
  loaded: boolean;
  warning?: string;
}

export interface InstallCliResult {
  cliWrapper: string;
  daemons: DaemonInstall[];
  /** 老 com.claudestra.autostart.plist（v2.3.x 一体式 autostart），已 unload+.bak */
  oldAutostartPlist?: { path: string; backed: string };
  /** 老 pm2.<user>.plist（pm2 startup 装的），已 unload+.bak */
  oldPm2StartupPlist?: { path: string; backed: string };
  /** 被 stop 掉的老 pm2 daemon 名字列表（防跟新 launchd 抢） */
  pm2Stopped: string[];
  /** 老 claudestra-autostart wrapper 是否被清掉了 */
  removedOldAutostartWrapper: boolean;
  /** Claude Code 的 ~/.claude/settings.json 里 typing-hook command 是否被迁移成 bun 绝对路径 */
  migratedHookCommand: boolean;
  errors: string[];
  warnings: string[];
}

function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : null;
}

function getUid(): string {
  const r = spawnSync("/usr/bin/id", ["-u"], { encoding: "utf8" });
  return (r.stdout || "").trim() || "501";
}

/**
 * LaunchAgent 进程的 PATH。daemon 自己用绝对路径，PATH 主要供它 shell 出去时用
 * （launcher 调 tmux、cron 偶尔 spawn 别的命令）。简洁就行 —— 不再为 nvm / pm2
 * 各种位置打补丁。
 */
function buildEnvPath(): string {
  const home = homedir();
  return [
    `${home}/.bun/bin`,
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

/**
 * 把 `claudestra` 命令装到 ~/.local/bin（XDG 主路径）+ symlink 到 ~/.bun/bin。
 * 两个目录覆盖绝大多数用户 PATH 配置，确保打 `claudestra` 至少有一个能找到。
 */
async function writeCliWrapper(repoRoot: string, bunPath: string): Promise<string> {
  const home = homedir();
  const primary = `${home}/.local/bin/claudestra`;
  const fallback = `${home}/.bun/bin/claudestra`;
  await mkdir(`${home}/.local/bin`, { recursive: true });
  await mkdir(`${home}/.bun/bin`, { recursive: true });
  const cliScript = `${repoRoot}/src/cli/claudestra.ts`;
  const content = `#!/usr/bin/env bash
# claudestra — Claudestra one-shot launcher (Claudestra-installed, v2.4.0+)
# 一打这条命令就把 launchd 三个 daemon 拉起来（没跑的就 bootstrap）+ tmux attach 到 master TUI。
CLAUDESTRA_REPO=${JSON.stringify(repoRoot)} \\
CLAUDESTRA_SOCK=${JSON.stringify(TMUX_SOCK)} \\
exec ${JSON.stringify(bunPath)} ${JSON.stringify(cliScript)} "$@"
`;
  // 老版本可能在 primary 写过 symlink（甚至 ~/.local/bin <-> ~/.bun/bin 循环），
  // writeFile 会 ELOOP；先 unlink 容错再写真实文件。
  await unlink(primary).catch(() => {});
  await writeFile(primary, content);
  await chmod(primary, 0o755);
  // ~/.bun/bin/claudestra symlink → primary（两个 PATH 选项都覆盖）
  try {
    await unlink(fallback).catch(() => {});
    await symlink(primary, fallback);
  } catch { /* 非关键 */ }
  return primary;
}

function buildDaemonPlist(
  repoRoot: string,
  bunPath: string,
  daemon: typeof DAEMONS[number],
): string {
  const home = homedir();
  const envPath = buildEnvPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemon.label}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${repoRoot}/${daemon.script}</string>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/claudestra-${daemon.stem}.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claudestra-${daemon.stem}.err</string>
</dict>
</plist>
`;
}

async function writeDaemonPlists(
  repoRoot: string,
  bunPath: string,
): Promise<{ label: string; plistPath: string }[]> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  await mkdir(dir, { recursive: true });
  const out: { label: string; plistPath: string }[] = [];
  for (const d of DAEMONS) {
    const plistPath = `${dir}/${d.label}.plist`;
    await writeFile(plistPath, buildDaemonPlist(repoRoot, bunPath, d));
    out.push({ label: d.label, plistPath });
  }
  return out;
}

/** bootout（容错）+ bootstrap。bootstrap 失败返回错误信息。 */
function reloadDaemon(plistPath: string, uid: string): { ok: boolean; err: string } {
  spawnSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { encoding: "utf8" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || "").trim() };
}

/**
 * v2.3.x 装的 com.claudestra.autostart.plist + 老的 pm2.<user>.plist 都 unload
 * + 重命名 .bak。免得 boot 时跟新的三个 plist 一起跑、抢着启动 pm2。
 */
async function migrateOldPlists(): Promise<{
  oldAutostartPlist?: { path: string; backed: string };
  oldPm2StartupPlist?: { path: string; backed: string };
}> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  if (!existsSync(dir)) return {};
  const out: any = {};
  // v2.3.x 一体式 autostart
  const autostart = `${dir}/com.claudestra.autostart.plist`;
  if (existsSync(autostart)) {
    spawnSync("launchctl", ["unload", autostart], { encoding: "utf8" });
    const backed = autostart + ".bak";
    try { await rename(autostart, backed); out.oldAutostartPlist = { path: autostart, backed }; }
    catch { /* 不能 rename 就算了 */ }
  }
  // 更老的 pm2 startup 装的
  const user = process.env.USER || "";
  for (const name of [`pm2.${user}.plist`, "pm2.plist"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      spawnSync("launchctl", ["unload", p], { encoding: "utf8" });
      const backed = p + ".bak";
      try { await rename(p, backed); out.oldPm2StartupPlist = { path: p, backed }; break; }
      catch { /* */ }
    }
  }
  return out;
}

/**
 * 老 pm2 daemon（discord-bridge / master-launcher / cron-scheduler）如果在跑，
 * stop 掉 —— 新 launchd 守护会立刻拉同样的 daemon 起来，pm2 不放手就会有两份。
 * pm2 不在 PATH 就直接跳过，没事。
 */
async function stopLegacyPm2Daemons(): Promise<string[]> {
  const pm2Path = which("pm2");
  if (!pm2Path) return [];
  const stopped: string[] = [];
  // 先看哪些真在跑（避免对没起的 daemon 调 delete 报错刷屏）
  const list = spawnSync(pm2Path, ["jlist"], { encoding: "utf8" });
  if (list.status !== 0) return [];
  let online: string[] = [];
  try {
    const procs = JSON.parse(list.stdout || "[]") as Array<{ name: string; pm2_env?: { status?: string } }>;
    online = procs
      .filter((p) => LEGACY_PM2_NAMES.includes(p.name) && p.pm2_env?.status === "online")
      .map((p) => p.name);
  } catch { /* parse fail */ }
  for (const name of online) {
    const r = spawnSync(pm2Path, ["delete", name], { encoding: "utf8" });
    if (r.status === 0) stopped.push(name);
  }
  if (stopped.length > 0) {
    // 更新 pm2 dump 文件，万一用户还在用 pm2 resurrect 也不会重新拉起这仨
    spawnSync(pm2Path, ["save"], { encoding: "utf8" });
  }
  return stopped;
}

/**
 * Claude Code 的 typing-hook 在 ~/.claude/settings.json 里 v2.3.x 之前是
 *     command: "bun /path/to/src/hooks/typing-hook.ts"
 * 用相对命令 `bun`。v2.4.0 切到 launchd 后，worker 进程的 PATH 链不再继承用户终端
 * PATH（launchd plist envPath 是给 daemon 用的，worker 是 master tmux pane 派生的，
 * shell 启动可能没 ~/.bun/bin），Claude Code 用 `/bin/sh -c "bun ..."` 跑 hook 就
 * "/bin/sh: bun: command not found"。
 *
 * 修法：每次 install-cli 都把 settings.json 里所有指向 typing-hook.ts 的 command
 * 替换为 bun **绝对路径**，幂等（已经是绝对路径就 no-op）。
 */
async function migrateHookCommand(bunPath: string): Promise<boolean> {
  const settingsPath = `${homedir()}/.claude/settings.json`;
  if (!existsSync(settingsPath)) return false;
  let raw: string;
  try { raw = await readFile(settingsPath, "utf-8"); } catch { return false; }
  let settings: any;
  try { settings = JSON.parse(raw); } catch { return false; }
  if (!settings.hooks || typeof settings.hooks !== "object") return false;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        // 匹配 "bun /path/.../typing-hook.ts" — 把开头的 "bun " 换成绝对路径
        const m = h.command.match(/^bun\s+(.+typing-hook\.ts)\s*$/);
        if (m) {
          h.command = `${bunPath} ${m[1]}`;
          changed = true;
        }
      }
    }
  }

  if (!changed) return false;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

/** v2.3.x 写过的 ~/.bun/bin/claudestra-autostart 现在没用了，清掉。 */
async function removeOldAutostartWrapper(): Promise<boolean> {
  const target = `${homedir()}/.bun/bin/claudestra-autostart`;
  if (!existsSync(target)) return false;
  try { await unlink(target); return true; } catch { return false; }
}

/**
 * 主入口：装 CLI + 写 3 个 daemon plist + 迁移老配置 + 启动新 plist。
 *
 * 顺序很重要：
 *   1) 写 CLI wrapper（独立于 daemon，先把它落地）
 *   2) 写 3 个新 plist（落地不 load）
 *   3) unload + .bak 老的 autostart plist（不让它再跟新的争）
 *   4) stop 老 pm2 daemon（不让 pm2 进程跟新 launchd 进程同时跑同一个 daemon）
 *   5) 清老 claudestra-autostart 包装脚本
 *   6) bootstrap 3 个新 plist（launchd 接管）
 *
 * Idempotent —— 跑多次只是重写同一份文件 + 重新 load，无害。每次 update 走一次。
 */
export async function installClaudestraCli(repoRoot: string): Promise<InstallCliResult> {
  repoRoot = resolve(repoRoot);
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: InstallCliResult = {
    cliWrapper: "",
    daemons: [],
    pm2Stopped: [],
    removedOldAutostartWrapper: false,
    migratedHookCommand: false,
    errors,
    warnings,
  };

  // 找 bun（绝对路径，写进所有 plist + CLI wrapper）
  const bunPath = which("bun") || `${homedir()}/.bun/bin/bun`;
  try { await stat(bunPath); }
  catch { errors.push(`bun 不在 ${bunPath}（先 curl -fsSL https://bun.sh/install | bash）`); return result; }

  // 1) CLI wrapper
  try { result.cliWrapper = await writeCliWrapper(repoRoot, bunPath); }
  catch (e) { errors.push(`CLI wrapper: ${(e as Error).message}`); return result; }

  // 2) 写 3 个 plist
  let plists: { label: string; plistPath: string }[];
  try { plists = await writeDaemonPlists(repoRoot, bunPath); }
  catch (e) { errors.push(`写 daemon plist: ${(e as Error).message}`); return result; }

  // 3) 迁移老 plist
  try {
    const m = await migrateOldPlists();
    if (m.oldAutostartPlist) result.oldAutostartPlist = m.oldAutostartPlist;
    if (m.oldPm2StartupPlist) result.oldPm2StartupPlist = m.oldPm2StartupPlist;
  } catch (e) { warnings.push(`迁移老 plist: ${(e as Error).message}`); }

  // 4) stop 老 pm2 daemon
  try { result.pm2Stopped = await stopLegacyPm2Daemons(); }
  catch (e) { warnings.push(`stop 老 pm2 daemon: ${(e as Error).message}`); }

  // 5) 清老 autostart wrapper
  result.removedOldAutostartWrapper = await removeOldAutostartWrapper();

  // 5b) 迁移 ~/.claude/settings.json hook command → bun 绝对路径（v2.4.0 后必须，
  //     不然 worker 跑 hook 时 /bin/sh PATH 没 ~/.bun/bin，bun 找不到）
  try { result.migratedHookCommand = await migrateHookCommand(bunPath); }
  catch (e) { warnings.push(`迁移 hook command: ${(e as Error).message}`); }

  // 6) bootstrap 3 个新 plist
  const uid = getUid();
  for (const p of plists) {
    const r = reloadDaemon(p.plistPath, uid);
    const item: DaemonInstall = { label: p.label, plistPath: p.plistPath, loaded: r.ok };
    if (!r.ok) {
      item.warning = r.err || "launchctl bootstrap failed";
      warnings.push(`${p.label}: ${item.warning}`);
    }
    result.daemons.push(item);
  }

  return result;
}
