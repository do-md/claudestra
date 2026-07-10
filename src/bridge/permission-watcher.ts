/**
 * 运行时权限弹窗监视器
 *
 * 轮询所有活跃 agent 的 tmux pane，检测 Claude Code 运行时权限请求
 * （Do you want to make this edit / proceed / ...）。
 * 检测到新弹窗 → 发 Discord 消息 + 截图 + 按钮，@ 用户响应。
 */

import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import {
  tmuxCapture,
  tmuxRaw,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
} from "../lib/tmux-helper.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";
import { DISCORD_ENABLED } from "./config.js";
import {
  pushToWeb,
  setPendingInteraction,
  type WebStreamEvent,
} from "./web-hub.js";

/**
 * 弹窗按钮 → Claude Code TUI 按键**序列**（单一事实源）。
 * Discord 按钮处理器与 Web /web/permission 端点都用它，避免两处漂移。
 * v2.0.22+: session-idle modal 不接受 digit 跳转（按 "2" 不跳 option 2，Enter 只确认
 * 高亮的 option 1 = 从摘要恢复 = compact）。改用 arrow nav：光标默认 option 1，
 * Down 一次到 2，两次到 3。perm 弹窗保留 digit（实测可用）。
 */
export const PERM_KEY_SEQ: Record<string, string[]> = {
  perm_allow: ["1", "Enter"],
  perm_allow_session: ["2", "Enter"],
  perm_deny: ["3", "Enter"],
  session_summary: ["Enter"], // option 1（高亮默认）
  session_full: ["Down", "Enter"], // ↓ 到 option 2
  session_noask: ["Down", "Down", "Enter"], // ↓↓ 到 option 3
};

export const PERM_LABELS: Record<string, string> = {
  perm_allow: "✅ 已允许",
  perm_allow_session: "✅ 已允许（本会话不再问）",
  perm_deny: "❌ 已拒绝",
  session_summary: "✨ 从摘要恢复",
  session_full: "📜 恢复完整会话",
  session_noask: "🔕 不再询问",
};

/**
 * 执行一个权限/session-idle 弹窗响应：解析 channelId→agent，确认弹窗还在，
 * 把对应按键序列发给 agent 的 tmux window。Discord 按钮与 Web 端点共用。
 * 返回 `dialogClosed:true` 表示弹窗已自动关闭（无需操作），此时不发键。
 */
export async function applyPermissionAction(
  targetChannelId: string,
  action: string
): Promise<{ ok: boolean; error?: string; agentName?: string; dialogClosed?: boolean }> {
  const keySeq = PERM_KEY_SEQ[action];
  if (!keySeq) return { ok: false, error: `未知操作 ${action}` };
  const isPermBtn = action.startsWith("perm_");
  const isIdleBtn = action.startsWith("session_");

  const listResult = await runManager("list");
  const agent = (listResult.agents || []).find(
    (a: any) => a.channelId === targetChannelId
  );
  if (!agent) return { ok: false, error: "找不到对应 agent" };

  // 发键前再确认弹窗还在，避免把 digit+Enter 当普通消息提交给 Claude
  const pane = await tmuxCapture(windowTarget(agent.name), 30);
  const hasPerm = detectRuntimePermissionPrompt(pane) !== null;
  const hasIdle = detectSessionIdlePrompt(pane) !== null;
  const dialogStillActive = (isPermBtn && hasPerm) || (isIdleBtn && hasIdle);
  if (!dialogStillActive) return { ok: false, dialogClosed: true, agentName: agent.name };

  await tmuxRaw(["send-keys", "-t", `master:${agent.name}`, ...keySeq]);
  return { ok: true, agentName: agent.name };
}

/** 把当前 modal 渲染成 Web 交互卡事件（permission/session-idle 共用）。 */
function buildPermissionWebEvent(
  key: string,
  sessionIdleDesc: string | null,
  permissionDesc: string | null
): Extract<WebStreamEvent, { t: "permission" }> {
  if (sessionIdleDesc) {
    return {
      t: "permission",
      id: key,
      kind: "session-idle",
      title: "session 已闲置，Claude Code 询问如何继续",
      desc: sessionIdleDesc,
      actions: [
        { action: "session_summary", label: "从摘要恢复", style: "success" },
        { action: "session_full", label: "恢复完整会话", style: "primary" },
        { action: "session_noask", label: "不再询问", style: "secondary" },
      ],
    };
  }
  return {
    t: "permission",
    id: key,
    kind: "permission",
    title: "需要授权",
    desc: permissionDesc || "",
    actions: [
      { action: "perm_allow", label: "允许", style: "success" },
      { action: "perm_allow_session", label: "允许 + 本会话不再问", style: "primary" },
      { action: "perm_deny", label: "拒绝", style: "danger" },
    ],
  };
}

const POLL_INTERVAL_MS = 8_000;

// v2.0.23+: session-idle 兜底 grace。manager.ts/launcher.ts 启动路径会自动选
// 「恢复完整会话」，几秒内消掉 modal。watcher 不该抢在它前面发按钮（重启时
// 每个 agent 都会闪一下 modal → 一堆 @ 你的噪音通知，但 modal 早被自动消了）。
// 只有 modal 撑过这个 grace 还在（说明自动选真失败了）才发按钮兜底。
const SESSION_IDLE_GRACE_MS = 20_000;

// channelId → 最近一次通知的 modal key。防止同一弹窗重复推送。
const lastNotified = new Map<string, string>();
// channelId → 首次看到 session-idle modal 的时间戳（grace 计时用）
const sessionIdleFirstSeen = new Map<string, number>();
// channelId → Discord 消息 ID（用于点击按钮后编辑）
export const permissionMessages = new Map<string, string>();

/**
 * 给当前 modal 计算一个稳定 dedup key。
 *
 * **不要**用 pane 原文 hash —— session-idle modal 文案里有 "This session is
 * 21h 6m old and 913.2k tokens" 这种**带动态时间**的字段，每分钟跳一次，
 * 导致 watcher 每分钟重发一次"session 闲置"通知（v2.0.4 之前的 bug）。
 *
 * 改成基于语义：
 * - session-idle 这种单一状态语义就一个 key，时间变化不影响
 * - 运行时权限弹窗用 detectRuntimePermissionPrompt 返回的稳定描述
 *   （"Edit /tmp/foo" 之类，和具体权限请求 1:1）
 */
export function computeModalKey(
  sessionIdleDesc: string | null,
  permissionDesc: string | null
): string | null {
  if (sessionIdleDesc) return "session-idle";
  if (permissionDesc) return `permission|${permissionDesc}`;
  return null;
}

async function checkAgent(
  agentName: string,
  channelId: string,
  allowedUserIds: string[],
  discord: Client
) {
  const pane = await tmuxCapture(windowTarget(agentName), 30);

  // 两种弹窗共用一个 channel 级别的 slot，同时只会有一种出现
  const sessionIdleDesc = detectSessionIdlePrompt(pane);
  const permissionDesc = sessionIdleDesc ? null : detectRuntimePermissionPrompt(pane);

  // v2.0.23+: session-idle grace —— 启动路径会自动选「完整恢复」消掉 modal。
  // modal 没撑过 grace 就不发按钮（避免重启 race 噪音）；撑过了才兜底。
  if (!sessionIdleDesc) {
    sessionIdleFirstSeen.delete(channelId);
  } else {
    const firstSeen = sessionIdleFirstSeen.get(channelId);
    if (firstSeen === undefined) {
      sessionIdleFirstSeen.set(channelId, Date.now());
      return; // 第一次看到，给自动选留时间，先不发
    }
    if (Date.now() - firstSeen < SESSION_IDLE_GRACE_MS) return; // 还在 grace 内
    // 撑过 grace 仍在 → 自动选大概率失败，往下走正常发按钮兜底
  }

  const key = computeModalKey(sessionIdleDesc, permissionDesc);
  if (!key) {
    // modal 消失：若之前通知过 → 推 Web「清卡」+ 清 pending（Discord 侧不动，
    // 原消息保留处理痕迹）。防止 Web 一直挂着一张早已失效的权限卡。
    if (lastNotified.has(channelId)) {
      pushToWeb(channelId, { t: "permission-cleared" });
      setPendingInteraction(channelId, null);
    }
    lastNotified.delete(channelId);
    return;
  }
  if (lastNotified.get(channelId) === key) return;
  lastNotified.set(channelId, key);

  // Web tee（附加输出，与 Discord 并行；web-only 也走这里）。SSE 晚连的订阅者
  // 靠 web-hub 的 pending replay 看到这张卡。
  const webEvt = buildPermissionWebEvent(key, sessionIdleDesc, permissionDesc);
  pushToWeb(channelId, webEvt);
  setPendingInteraction(channelId, webEvt);

  // 以下是 Discord 专属推送（截图 + @ + 按钮）。web-only 模式下直接返回。
  if (!DISCORD_ENABLED) return;

  const pngPath = await tmuxScreenshot(agentName);
  const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");

  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;

    let text: string;
    let components: any;
    let logLabel: string;

    if (sessionIdleDesc) {
      text = [
        `💤 **${agentName}** session 已闲置，Claude Code 询问如何继续`,
        sessionIdleDesc,
        mention,
      ].filter(Boolean).join("\n");
      components = buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `session_summary:${channelId}`, label: "从摘要恢复", emoji: "✨", style: "success" },
            { id: `session_full:${channelId}`, label: "恢复完整会话", emoji: "📜", style: "primary" },
            { id: `session_noask:${channelId}`, label: "不再询问", emoji: "🔕", style: "secondary" },
          ],
        },
      ]);
      logLabel = `session-idle desc="${sessionIdleDesc}"`;
    } else {
      text = [
        `🔔 **${agentName}** 需要授权`,
        permissionDesc,
        mention,
      ].filter(Boolean).join("\n");
      components = buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `perm_allow:${channelId}`, label: "允许", emoji: "✅", style: "success" },
            { id: `perm_allow_session:${channelId}`, label: "允许 + 本会话不再问", emoji: "✅", style: "primary" },
            { id: `perm_deny:${channelId}`, label: "拒绝", emoji: "❌", style: "danger" },
          ],
        },
      ]);
      logLabel = `permission desc="${permissionDesc}"`;
    }

    const msg = await ch.send({
      content: text,
      components,
      files: pngPath ? [{ attachment: pngPath }] : undefined,
    });
    permissionMessages.set(channelId, msg.id);
    console.log(`🔔 弹窗通知 agent=${agentName} ${logLabel}`);
  } catch (e) {
    console.error(`🔔 弹窗通知发送失败:`, e);
  }
}

export function startPermissionWatcher(
  allowedUserIds: string[],
  discord: Client
) {
  const tick = async () => {
    try {
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        // 注意：不能根据 idle 字段跳过 — 弹窗界面底部也有 ❯ 会被误判为 idle
        await checkAgent(agent.name, agent.channelId, allowedUserIds, discord).catch(() => {});
      }
    } catch { /* non-critical */ }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`🔔 权限弹窗 watcher 启动 (每 ${POLL_INTERVAL_MS / 1000}s 轮询)`);
}

export function clearPermissionMessage(channelId: string) {
  permissionMessages.delete(channelId);
  lastNotified.delete(channelId);
  sessionIdleFirstSeen.delete(channelId);
  // Web 侧同步清卡（此弹窗已处理/失效）
  pushToWeb(channelId, { t: "permission-cleared" });
  setPendingInteraction(channelId, null);
}
