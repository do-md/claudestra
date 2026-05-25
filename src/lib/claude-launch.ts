/**
 * Claude Code 启动命令构造
 *
 * 统一 manager/launcher/cron 三处的 Claude Code 启动参数：
 * - MCP server 名（由 env MCP_NAME 控制，默认 claudestra）
 * - disallowedTools 黑名单（支持命名预设和自定义）
 * - dev channel 加载 + skip-permissions
 */

const MCP_NAME = process.env.MCP_NAME || "claudestra";

// ────────────────────────────────────────────────
// disallowedTools 预设
// ────────────────────────────────────────────────
//
// 预设的设计原则：
//   default   — 默认拦截真正不可逆的命令，其他放行。适合大多数场景
//   strict    — default + 禁网络 / 特权命令，适合 untrusted 任务
//   readonly  — default + 禁文件写入 + 禁包管理，适合 review/分析类任务
//   paranoid  — default + 禁 Bash / Write / Edit / WebFetch，最小权限
//
// 使用方式：
//   resolveDisallowed({ preset: "strict" })
//   resolveDisallowed({ raw: "Bash(foo:*) Bash(bar:*)" })
//   resolveDisallowed({})  // → default

const DEFAULT_DISALLOWED: readonly string[] = [
  "Bash(rm -rf:*)",
  "Bash(rm -r:*)",
  "Bash(rmdir:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(git clean -f:*)",
  "Bash(chmod 777:*)",
  "Bash(:(){ :|:&};:)", // fork bomb
] as const;

export const DISALLOWED_PRESETS: Record<string, readonly string[]> = {
  default: DEFAULT_DISALLOWED,

  strict: [
    ...DEFAULT_DISALLOWED,
    "Bash(sudo:*)",
    "Bash(su:*)",
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(ssh:*)",
    "Bash(scp:*)",
    "Bash(rsync:*)",
    "Bash(nc:*)",
    "Bash(ncat:*)",
    "Bash(dd:*)",
    "Bash(mkfs:*)",
  ],

  readonly: [
    ...DEFAULT_DISALLOWED,
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Bash(git *:*)",
    "Bash(npm *:*)",
    "Bash(yarn *:*)",
    "Bash(pnpm *:*)",
    "Bash(bun *:*)",
    "Bash(pip *:*)",
    "Bash(uv *:*)",
    "Bash(cargo *:*)",
  ],

  paranoid: [
    ...DEFAULT_DISALLOWED,
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
  ],
};

export const DEFAULT_PRESET = "default";

// ────────────────────────────────────────────────
// 权限模式（Claude Code --permission-mode）
// ────────────────────────────────────────────────
//
// Claude Code 2.1.x 的 `--permission-mode <mode>`：
//   default          — 正常逐个问权限
//   acceptEdits      — 自动接受文件编辑，其余照问
//   auto             — classifier 判定：安全操作自动批，危险操作弹权限框（→ 我们的
//                      permission-watcher 转成 Discord 批准按钮），极危险直接拒。比
//                      bypass 安全得多，是新建交互 agent 的默认。
//   bypassPermissions— 跳过所有权限检查（= 老的 --dangerously-skip-permissions）。
//   dontAsk          — 不弹框，按规则静默放行/拒绝
//   plan             — 只读 plan 模式
//
// disallowedTools 黑名单与 permission-mode 正交，两者叠加：黑名单永远是硬拦截。

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isKnownPermissionMode(m: string): boolean {
  return (PERMISSION_MODES as readonly string[]).includes(m);
}

// 启动路径未显式指定 permissionMode 时的回退。= 老行为（bypass），保证向后兼容：
// 本 feature 之前建的 agent registry 里没有 permissionMode 字段，restart 时回退到
// 这个，行为不变。新建交互 agent 由 manager.ts cmdCreate 显式传 "auto"。
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

export function listPresets(): string[] {
  return Object.keys(DISALLOWED_PRESETS);
}

export function isKnownPreset(name: string): boolean {
  return name in DISALLOWED_PRESETS;
}

/**
 * 解析 disallowedTools 来源。
 * raw 优先于 preset；都没给就用 default。
 */
export function resolveDisallowed(opts: {
  preset?: string;
  raw?: string;
}): string[] {
  if (opts.raw && opts.raw.trim()) {
    return opts.raw.trim().split(/\s+/).filter(Boolean);
  }
  const presetName = opts.preset || DEFAULT_PRESET;
  const preset = DISALLOWED_PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `未知的权限预设: "${presetName}"。可用: ${listPresets().join(", ")}`
    );
  }
  return [...preset];
}

// ────────────────────────────────────────────────
// 启动命令构造
// ────────────────────────────────────────────────

export interface LaunchOptions {
  channelId: string;
  bridgeUrl?: string;
  /** 可选 session id（--session-id <uuid>） */
  sessionId?: string;
  /** resume 模式：传入要 resume 的 session id */
  resumeId?: string;
  /** resume 时的显示名 */
  displayName?: string;
  /** 已解析好的 disallowedTools 列表。与 preset 二选一 */
  disallowedTools?: readonly string[];
  /** 权限预设名称（default / strict / readonly / paranoid / 其他） */
  disallowedPreset?: string;
  /** 原始字符串覆盖（空格分隔的 entries） */
  disallowedRaw?: string;
  /**
   * 权限模式（`--permission-mode <mode>`）。见 PERMISSION_MODES。
   * 不传 → DEFAULT_PERMISSION_MODE（bypassPermissions，保持老行为）。
   * bypassPermissions 走经过验证的 `--dangerously-skip-permissions`，其余走
   * `--permission-mode`。
   */
  permissionMode?: string;
  /**
   * Session-scoped effort level（`--effort <level>`，只影响本 Claude Code session，
   * 不写到全局 user config）。支持 low / medium / high / xhigh / max。
   * 没传就不加 flag → Claude Code 用 `~/.claude/settings.json` 的全局 effortLevel。
   */
  effort?: string;
}

/** POSIX 单引号 shell 转义 */
function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_.\/:@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 构造 Claude Code 启动命令行字符串（给 tmux send-keys 使用）。
 * 返回完整的 shell 命令，包含前导环境变量导出。
 */
export function buildClaudeCommand(opts: LaunchOptions): string {
  const bridgeUrl =
    opts.bridgeUrl || process.env.BRIDGE_URL || "ws://localhost:3847";

  const prefix =
    `DISCORD_CHANNEL_ID=${shellEscape(opts.channelId)} ` +
    `BRIDGE_URL=${shellEscape(bridgeUrl)} ` +
    `MCP_NAME=${shellEscape(MCP_NAME)}`;

  // 解析 disallowedTools
  const disallowed: string[] =
    opts.disallowedTools && opts.disallowedTools.length > 0
      ? [...opts.disallowedTools]
      : resolveDisallowed({
          preset: opts.disallowedPreset,
          raw: opts.disallowedRaw,
        });

  const mode =
    (opts.permissionMode && opts.permissionMode.trim()) || DEFAULT_PERMISSION_MODE;

  const parts: string[] = [
    "claude",
    "--dangerously-load-development-channels",
    `server:${MCP_NAME}`,
  ];

  // bypassPermissions 走经过验证的 --dangerously-skip-permissions（语义相同，且它
  // 还顺带跳过 workspace trust dialog）；其余模式走 --permission-mode <mode>。
  // 非 bypass 模式启动期若弹 trust dialog，由 manager/launcher 的启动轮询
  // (isAutoConfirmableModal 几何识别) 自动 Enter 确认。
  if (mode === "bypassPermissions") {
    parts.push("--dangerously-skip-permissions");
  } else {
    parts.push("--permission-mode", shellEscape(mode));
  }

  if (opts.resumeId) {
    parts.push("--resume", shellEscape(opts.resumeId));
    if (opts.displayName) parts.push("--name", shellEscape(opts.displayName));
  } else if (opts.sessionId) {
    parts.push("--session-id", shellEscape(opts.sessionId));
  }

  if (opts.effort && opts.effort.trim() && opts.effort !== "default") {
    parts.push("--effort", shellEscape(opts.effort.trim()));
  }

  if (disallowed.length > 0) {
    parts.push("--disallowedTools", shellEscape(disallowed.join(" ")));
  }

  return `${prefix} ${parts.join(" ")}`;
}

export { MCP_NAME, DEFAULT_DISALLOWED };
