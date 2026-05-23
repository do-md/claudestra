/**
 * Wedge Watcher — 卡死 agent 检测
 *
 * 定期扫所有 active agent 的 tmux pane。如果 pane 指纹（最后 40 行 hash）
 * 连续 30 分钟不变，并且 agent 不在 idle 状态（没有 `❯` 提示符），
 * 说明它很可能卡在某个状态（模态、网络、Claude 无响应等），
 * 通过 Discord 通知用户 + 给一个 "发 Esc 救回" 按钮。
 */

import { createHash } from "crypto";
import type { Client, TextChannel } from "discord.js";
import {
  tmuxCapture,
  windowTarget,
  isIdle,
  isAtShell,
} from "../lib/tmux-helper.js";
import { buildComponents } from "./components.js";
import { runManager } from "./management.js";
import { getJsonlMtime } from "./jsonl-watcher.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_INTERVAL_MS = 5 * 60_000;     // 每 5 分钟扫一次
const WEDGE_THRESHOLD_MS = 30 * 60_000;  // 30 分钟没变 + claude 在跑但非 idle → 卡死
// claude 退出停在 shell 撑过这个才报"掉线"。比 wedge 阈值短（掉线要早点知道），
// 但留 grace 滤掉正常 restart 的瞬时 shell 窗口（restart 几十秒内就拉起新 claude）。
const SHELL_EXIT_GRACE_MS = 10 * 60_000;

interface AgentState {
  fingerprint: string;
  firstSeenAt: number;   // 该指纹第一次出现的时间
  notifiedAt: number;    // 上次通知时间（避免重复打扰）
}

const agentStates = new Map<string, AgentState>(); // agentName → state

function fingerprint(pane: string): string {
  const tail = pane.split("\n").slice(-40).join("\n");
  return createHash("sha1").update(tail).digest("hex").slice(0, 16);
}

async function checkAgent(
  agentName: string,
  channelId: string,
  cwd: string,
  sessionId: string,
  allowedUserIds: string[],
  discord: Client
): Promise<void> {
  const target = windowTarget(agentName);
  const pane = await tmuxCapture(target, 40);
  const fp = fingerprint(pane);
  const now = Date.now();

  // idle（ready 提示符）→ 正常歇着，不是卡死。清掉状态。
  if (await isIdle(target)) {
    agentStates.delete(agentName);
    return;
  }

  // v2.0.23+: claude 已退出停在 shell —— 你的 zsh 主题 shell 提示符是 ❯，跟 claude
  // 输入框同符号，paneLooksIdle 看到 ❯ 但没 bypass banner → 误判"非 idle 卡死"，
  // 对一个根本没 claude 在跑的 window 每小时误报。这是掉线不是卡死：Esc/C-c 没用，
  // 要的是重启。下面按 atShell 分流到不同通知 + 不同阈值。
  const atShell = isAtShell(pane);

  // v2.0.23+: jsonl 活跃度逃生阀。Claude 思考 / 调工具时 session jsonl 一直在追加。
  // 只看 tmux pane 指纹会把"思考中但屏幕暂时没变"误判成卡死（owner 实测 claudestra
  // 自己思考时被误报）。jsonl 最近被写过 → agent 在干活，绝不是卡死，重置计时。
  // 只对"claude 在跑"分支生效：at-shell 是 claude 已退出、jsonl 本来就不更新，
  // 那条掉线检测单独按 atShell 走，不受这里影响。
  if (!atShell) {
    const mtime = await getJsonlMtime(cwd, sessionId);
    if (mtime !== null && now - mtime < WEDGE_THRESHOLD_MS) {
      agentStates.delete(agentName);
      return;
    }
  }

  const prev = agentStates.get(agentName);
  if (!prev || prev.fingerprint !== fp) {
    // 指纹变了 → 有进展 / 状态切换。重新开始计时。
    agentStates.set(agentName, { fingerprint: fp, firstSeenAt: now, notifiedAt: 0 });
    return;
  }

  // 指纹一直没变 → 到阈值才报。at-shell 用较短 grace，其余维持 30min。
  const staticMs = now - prev.firstSeenAt;
  const threshold = atShell ? SHELL_EXIT_GRACE_MS : WEDGE_THRESHOLD_MS;
  if (staticMs < threshold) return;
  // 已通知过且上一次通知在 1 小时内 → 不打扰
  if (prev.notifiedAt > 0 && now - prev.notifiedAt < 60 * 60_000) return;

  prev.notifiedAt = now;
  const minutes = Math.round(staticMs / 60_000);

  try {
    const ch = (await discord.channels.fetch(channelId)) as TextChannel;
    const mention = allowedUserIds.map((id) => `<@${id}>`).join(" ");

    if (atShell) {
      // 掉线：claude 退出到 shell，发"已退出 + 重启按钮"
      console.log(`🔌 agent ${agentName} 已退出到 shell（${minutes} 分钟）`);
      recordMetric("agent_exited", { channelId, agent: agentName, durationMs: staticMs });
      await ch.send({
        content: [
          `🔌 **${agentName}** 的 Claude Code 已退出（掉线）${mention ? " " + mention : ""}`,
          `已停在 shell ${minutes} 分钟，没有 Claude Code 在跑。`,
          `可能是 /exit、崩溃、或自动更新失败 —— worker agent 不会自动拉起。`,
          ``,
          `👉 点下面重启，或 /screenshot 看现在状态。`,
        ].join("\n"),
        components: buildComponents([
          {
            type: "buttons",
            buttons: [
              { id: `wedge_restart:${agentName}`, label: "重启", emoji: "🔄", style: "primary" },
            ],
          },
        ]),
      });
    } else {
      // 真卡死：claude 在跑但 pane 静止，发 Esc/C-c 救援
      console.log(`⚠️ 检测到 agent ${agentName} 可能卡死了（${minutes} 分钟无变化）`);
      recordMetric("agent_wedged", { channelId, agent: agentName, durationMs: staticMs });
      await ch.send({
        content: [
          `⚠️ **${agentName}** 好像卡住了${mention ? " " + mention : ""}`,
          `pane 已 ${minutes} 分钟没有任何变化，但 Claude Code 又不是 idle 状态。`,
          `可能是：modal 没关、网络挂了、Claude API 超时、或者跑进死循环。`,
          ``,
          `👉 用下面按钮 Esc/C-c 救回，或 /screenshot 看看现在是什么状态。`,
        ].join("\n"),
        components: buildComponents([
          {
            type: "buttons",
            buttons: [
              { id: `wedge_esc:${agentName}`, label: "发 Esc", emoji: "❌", style: "secondary" },
              { id: `interrupt:${channelId}`, label: "发 Ctrl+C", emoji: "⚡", style: "danger" },
            ],
          },
        ]),
      });
    }
  } catch (e) {
    console.error(`⚠️ wedge 通知发送失败:`, e);
  }
}

export function startWedgeWatcher(discord: Client) {
  const tick = async () => {
    try {
      const allowedUserIds = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
      const list = await runManager("list");
      const agents: any[] = list.agents || [];
      for (const agent of agents) {
        if (agent.status !== "active" || !agent.channelId) continue;
        await checkAgent(
          agent.name, agent.channelId, agent.cwd || "", agent.sessionId || "",
          allowedUserIds, discord,
        ).catch(() => {});
      }
    } catch { /* non-critical */ }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`⚠️ Wedge watcher 启动（每 ${POLL_INTERVAL_MS / 60_000}min 扫，${WEDGE_THRESHOLD_MS / 60_000}min 卡死阈值）`);
}

/** 清掉 agent 状态，agent 被 kill 时可调用 */
export function clearWedgeState(agentName: string) {
  agentStates.delete(agentName);
}
