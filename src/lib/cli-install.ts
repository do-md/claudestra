/**
 * 把 `claudestra` 命令装到 PATH + 配开机自启 LaunchAgent。
 *
 * setup.ts 在首次安装末尾跑这个；manager.ts `install-cli` 子命令现有装机也能单跑。
 *
 * 做三件事：
 *   1. 在 ~/.bun/bin/claudestra 写一个 shell wrapper，exec 仓库里的
 *      src/cli/claudestra.ts，并通过环境变量把 REPO_ROOT 和 master tmux socket 注入。
 *   2. 在 ~/Library/LaunchAgents/com.claudestra.autostart.plist 写一个 user-level
 *      LaunchAgent，开机/登录时跑 `pm2 start <repo>/ecosystem.config.cjs`。
 *      — 不用 `pm2 resurrect`+dump：ecosystem.config.cjs 在 git 里、永远是源真相，
 *        永远不用 `pm2 save`。
 *   3. 如果旁边还挂着一个老的 pm2.<user>.plist（pm2 startup 装的、跑 resurrect），
 *      `launchctl unload` 它 + 重命名 .bak，免得 boot 时两边互相打架。
 */

import { mkdir, writeFile, chmod, stat, rename } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { join, resolve } from "path";

export interface InstallCliResult {
  cliWrapper: string;
  autostartScript: string;
  plistPath: string;
  oldPm2Plist?: { path: string; backed: string };
  errors: string[];
  warnings: string[];
}

const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";

/** 查 `pm2` / `bun` 可执行路径，找不到就用常见 fallback。 */
function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : null;
}

/** 拼一个能跨 nvm / bun / pm2 安装位置的 LaunchAgent PATH（不依赖登录 shell 的 PATH）。 */
function buildEnvPath(): string {
  const home = homedir();
  const extra = [
    `${home}/.bun/bin`,
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  // 如果当前 PATH 里有 nvm 的 node 目录，也加上 —— pm2 走的就是它
  for (const p of (process.env.PATH || "").split(":")) {
    if (p && !extra.includes(p) && /(\.nvm|node|pm2)/.test(p)) extra.push(p);
  }
  return extra.join(":");
}

/**
 * 给 ~/.bun/bin/claudestra 写一个 wrapper 脚本。
 * 用 bun shebang 直接跑会要求用户 PATH 里有 bun；这里用 absolute bun 路径更稳。
 */
async function writeCliWrapper(repoRoot: string, bunPath: string): Promise<string> {
  const home = homedir();
  const target = `${home}/.bun/bin/claudestra`;
  await mkdir(`${home}/.bun/bin`, { recursive: true });
  const cliScript = `${repoRoot}/src/cli/claudestra.ts`;
  const content = `#!/usr/bin/env bash
# claudestra — Claudestra one-shot launcher (Claudestra-installed)
# 一打这条命令就把 pm2 daemon 拉起来并自动 attach 到 master TUI。
# REPO_ROOT 和 TMUX socket 在这里硬编码，cli 通过环境变量读。
CLAUDESTRA_REPO=${JSON.stringify(repoRoot)} \\
CLAUDESTRA_SOCK=${JSON.stringify(TMUX_SOCK)} \\
exec ${JSON.stringify(bunPath)} ${JSON.stringify(cliScript)} "$@"
`;
  await writeFile(target, content);
  await chmod(target, 0o755);
  return target;
}

/**
 * 写一个有名的 boot 脚本到 ~/.bun/bin/claudestra-autostart。
 *
 * 为啥不直接让 plist 跑 `/bin/sh -c "pm2 start ..."`：macOS 给新 LaunchAgent 弹的
 * 「App 后台活动」通知会显示 ProgramArguments[0]（"sh"），用户看不出是啥。
 * 包一层有名字的脚本，通知就显示 "claudestra-autostart"，一眼能认出是 Claudestra 的。
 */
async function writeAutostartScript(repoRoot: string, pm2Path: string): Promise<string> {
  const home = homedir();
  const target = `${home}/.bun/bin/claudestra-autostart`;
  await mkdir(`${home}/.bun/bin`, { recursive: true });
  const content = `#!/usr/bin/env bash
# claudestra-autostart — boot/login 时由 LaunchAgent 调用
# 启动 Claudestra 的三个 pm2 daemon（来自 ecosystem.config.cjs，git 里的源真相）
exec ${JSON.stringify(pm2Path)} start ${JSON.stringify(`${repoRoot}/ecosystem.config.cjs`)}
`;
  await writeFile(target, content);
  await chmod(target, 0o755);
  return target;
}

/** 写 LaunchAgent plist —— 开机自启调上面那个有名的脚本。 */
async function writeAutostartPlist(repoRoot: string, autostartScript: string): Promise<string> {
  const home = homedir();
  const dir = `${home}/Library/LaunchAgents`;
  await mkdir(dir, { recursive: true });
  const plistPath = `${dir}/com.claudestra.autostart.plist`;
  const path = buildEnvPath();
  // pm2 默认 PM2_HOME = ~/.pm2
  const pm2Home = `${home}/.pm2`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudestra.autostart</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
    <key>PM2_HOME</key>
    <string>${pm2Home}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${autostartScript}</string>
  </array>
  <key>StandardErrorPath</key>
  <string>/tmp/claudestra-autostart.err</string>
  <key>StandardOutPath</key>
  <string>/tmp/claudestra-autostart.out</string>
</dict>
</plist>
`;
  await writeFile(plistPath, content);
  return plistPath;
}

/** 如果还挂着老的 pm2.<user>.plist（pm2 startup 装的、跑 resurrect），
 *  unload + 重命名 .bak —— boot 时只走我们这个新的，免得双方互相打架。 */
async function unloadOldPm2Plist(): Promise<{ path: string; backed: string } | undefined> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  if (!existsSync(dir)) return;
  // 已知名字：pm2.<user>.plist
  const user = process.env.USER || "";
  const candidates = [`pm2.${user}.plist`, "pm2.plist"];
  for (const name of candidates) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    // unload（容错：可能已经没 load）
    spawnSync("launchctl", ["unload", path], { encoding: "utf8" });
    const backed = path + ".bak";
    try {
      await rename(path, backed);
      return { path, backed };
    } catch {
      // 不能重命名（比如权限）就算了
    }
  }
  return undefined;
}

/** 主入口：装 CLI + 装 LaunchAgent + 卸老 pm2 plist + load 新 plist。 */
export async function installClaudestraCli(repoRoot: string): Promise<InstallCliResult> {
  repoRoot = resolve(repoRoot); // 折叠 `src/..` 这种冗余
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: InstallCliResult = {
    cliWrapper: "",
    autostartScript: "",
    plistPath: "",
    errors,
    warnings,
  };

  // 找 bun + pm2
  const bunPath = which("bun") || `${homedir()}/.bun/bin/bun`;
  const pm2Path = which("pm2");
  if (!pm2Path) {
    errors.push("找不到 pm2。先 `bun install -g pm2` 或 `npm i -g pm2`。");
    return result;
  }
  // 验 bun 真在
  try { await stat(bunPath); }
  catch { errors.push(`bun 不在 ${bunPath}。检查安装。`); return result; }

  // 1. 写 CLI wrapper
  try {
    result.cliWrapper = await writeCliWrapper(repoRoot, bunPath);
  } catch (e) {
    errors.push(`写 CLI wrapper 失败: ${(e as Error).message}`);
    return result;
  }

  // 2a. 写有名字的 boot 脚本（macOS 通知里显示 "claudestra-autostart" 而不是 "sh"）
  try {
    result.autostartScript = await writeAutostartScript(repoRoot, pm2Path);
  } catch (e) {
    errors.push(`写 autostart 脚本失败: ${(e as Error).message}`);
    return result;
  }

  // 2b. 写 LaunchAgent plist，调上面那个脚本
  try {
    result.plistPath = await writeAutostartPlist(repoRoot, result.autostartScript);
  } catch (e) {
    errors.push(`写 LaunchAgent plist 失败: ${(e as Error).message}`);
    return result;
  }

  // 3. 卸老 pm2.<user>.plist（如果在）
  try {
    const old = await unloadOldPm2Plist();
    if (old) result.oldPm2Plist = old;
  } catch (e) {
    warnings.push(`卸老 pm2 plist 失败（不影响新 plist 生效）: ${(e as Error).message}`);
  }

  // 4. load 新 plist（容错：先 unload 一下避免 "already loaded"）
  spawnSync("launchctl", ["unload", result.plistPath], { encoding: "utf8" });
  const load = spawnSync("launchctl", ["load", result.plistPath], { encoding: "utf8" });
  if (load.status !== 0) {
    warnings.push(`launchctl load 警告：${(load.stderr || "").trim()}（plist 已写入，下次登录也会生效）`);
  }

  return result;
}
