/**
 * Discord Bridge Service — 主入口
 *
 * 共享的 Discord 网关连接。多个 Claude Code channel-server 实例通过 WebSocket
 * 连接到此 bridge，每个注册一个 Discord 频道 ID。Bridge 负责路由消息。
 */

import { enableTimestampLogs } from "./lib/log-timestamp.js";
enableTimestampLogs(); // 给所有 console log 加 ISO timestamp 前缀（daemon 专用）

import { initLang, t } from "./lib/i18n.js";
initLang(); // 同步载一次 lang（pm2 fork 模式不支持 top-level await）

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message as DiscordMessage,
  type Interaction,
} from "discord.js";
import type { ServerWebSocket } from "bun";

import { DISCORD_TOKEN, DISCORD_ENABLED, BRIDGE_PORT, ALLOWED_USER_IDS, DISCORD_GUILD_ID, TMP_DIR, TMUX_SOCK } from "./bridge/config.js";
import { subscribeWeb, pushToWeb, isLocalChannelId, type WebStreamEvent } from "./bridge/web-hub.js";
import {
  startTyping,
  stopTyping,
  buildComponents,
} from "./bridge/components.js";
import {
  setBotUserId,
  getBotUserId,
  isBotMessage,
  trackSentMessage,
  discordReply,
  discordFetchMessages,
  discordReact,
  discordEditMessage,
  discordCreateChannel,
  discordDeleteChannel,
} from "./bridge/discord-api.js";
import {
  runManager,
  buildStatusPanel,
  handleMgmtButton,
  handleMgmtSelect,
} from "./bridge/management.js";
import { tmuxScreenshot } from "./bridge/screenshot.js";
import { startWatching, stopWatching, stopWatchingByChannel, resetToolTracking, hasRecentScheduleWakeup } from "./bridge/jsonl-watcher.js";
import { startPermissionWatcher, permissionMessages, clearPermissionMessage } from "./bridge/permission-watcher.js";
import { startWedgeWatcher, clearWedgeState } from "./bridge/wedge-watcher.js";
import { recordMetric } from "./lib/metrics.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  tmuxSendLine,
  tmuxRaw,
  parseModalOptions,
  detectArrowNavModal,
  detectPermissionMode,
  btabStepsTo,
  MASTER_SESSION,
  type ArrowNavKind,
} from "./lib/tmux-helper.js";
import {
  scanGlobal as scanGlobalSkills,
  scanProject as scanProjectSkills,
  clearProject as clearProjectSkills,
  allRegistrableCommands,
  resolveInvocation,
  isProjectSkillForOtherAgent,
} from "./bridge/slash-registry.js";

// ============================================================
// 类型定义
// ============================================================

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  userId?: string;
  /** channel-server 所在 Claude Code 进程的 cwd。jsonl-watcher 用它定位
   *  ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl 监听 tool / text。 */
  cwd?: string;
}

// ============================================================
// 状态
// ============================================================

const clients = new Map<string, ClientInfo>();
const activeStatusMessages = new Map<string, string>();

/**
 * 记 "Discord 入站消息转发到某个 channel-server，turn 结果还没回到 Discord" 的
 * pending。deliverToLocal 在 intent=request 时挂一条；reply handler 成功时清对
 * 应 chatId 的条目；Stop hook 兜底清所有匹配 ws 的残留条目（防止泄漏）。
 *
 * intendedReplyChannel 可能跟接收消息的 channel 不同！
 *   - via_master：消息进 #agent-exchange 但 CONTROL 和 #agent-exchange 都行
 *     （master 用同一个 ws 处理两个 channel），intended = #agent-exchange
 *   - direct：peer 消息进 #agent-exchange，路由到 agent 的 ws，agent 应该 reply
 *     回 #agent-exchange @ peer bot —— intended = #agent-exchange，target 是 agent
 */
interface PendingReply {
  msgId: string;
  ts: number;
  intendedReplyChannel: string;
  targetWs: ServerWebSocket<unknown>;
  /** v2.0.0+: 跟新 router 里的 threadId 一致。老路径 fallback 用 msgId */
  threadId?: string;
}
const pendingReplies = new Map<string, PendingReply>();

/**
 * thread → 原始请求 envelope 的追踪。deliverToLocal 在 intent=request 时挂一条，
 * deliver 在对应 response 进来（meta.inReplyTo 或 threadId 匹配）时清一条，
 * Stop hook 兜底清掉对应 ws 上残留的。提供 per-thread 可观察性（log 里带
 * threadId 能追出"哪条具体消息结束了"），比单靠按 ws 清要精细一层。
 */
interface PendingThread {
  request: RouterEnvelope;
  /** 请求被投递到的本地 ws（用于 Stop hook 按 ws 反查本次要清哪些 thread） */
  targetWs: ServerWebSocket<unknown>;
  ts: number;
}
const pendingThreads = new Map<string, PendingThread>();

const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";

let _cachedAgentExchangeId = "";
async function getLocalAgentExchangeId(): Promise<string> {
  if (_cachedAgentExchangeId) return _cachedAgentExchangeId;
  try {
    const { readPeers } = await import("./lib/peers.js");
    const p = await readPeers();
    _cachedAgentExchangeId = p.localAgentExchangeId || "";
  } catch { /* non-critical */ }
  return _cachedAgentExchangeId;
}

/**
 * v1.9.21+ send_to_agent 推回机制：记录一条 outstanding send_to_agent 调用，
 * 当 target agent 下一次 reply 到自己 channel 时，bridge 自动把那段文字也 push
 * 回 caller 的 ws 作为"[agent-X 回复] …"合成消息，caller 不再需要 fetch_messages
 * 轮询。key = target agent 的 channelId。
 */
interface PendingAgentCall {
  callerChannelId: string;   // 谁发起的（master 或某个 agent）
  callerWs: ServerWebSocket<unknown>;
  callerName: string;
  targetName: string;
  /**
   * caller 发起 send_to_agent 时手头正在处理的 inbound 请求的
   * intendedReplyChannel —— 常见是 #agent-exchange（user 或 peer 在那里 @ 了
   * caller），也可能是 caller 自己的频道。target 回来之后，push 给 caller 的
   * 合成消息 meta.chat_id 用这个值，避免 caller LLM 误用 target 的私频当作
   * 回复目标。没有正在处理的请求时是 undefined。
   */
  originalReplyChannel?: string;
  /**
   * v2.0.12+ caller 在 send_to_agent 时填的"答完后我应该做啥"。
   * bridge 在把 target 的 reply push 回 caller ws 时，前缀注入这段文字
   * （[💡 你之前期望：...]），帮 caller LLM 不靠"自己记得"也能续上动作。
   * 修 self-develop 链路里 caller 收到答复后只 relay 不 act 的根因之一。
   */
  expecting?: string;
  ts: number;
}
const pendingAgentCalls = new Map<string, PendingAgentCall>();

/**
 * v1.9.22+ 跨 peer 的 send_to_agent：caller 发给 peer agent 后，bridge 需要
 * 在 peer bot 下一次在 shared channel reply 时，把 text push 回 caller ws。
 * 跟 pendingAgentCalls 对称。key = shared channel id（我们发消息过去的 channel）。
 */
interface PendingPeerCall {
  callerChannelId: string;
  callerWs: ServerWebSocket<unknown>;
  callerName: string;
  peerBotId: string;
  peerBotName: string;
  peerAgent: string;
  /** v2.0.12+ 跟 PendingAgentCall.expecting 对称，跨 peer 也支持。 */
  expecting?: string;
  ts: number;
}
const pendingPeerCalls = new Map<string, PendingPeerCall>();

/**
 * v2.0.13+ 跨 peer 入站请求追踪。peer 路由进来一条 #agent-exchange 消息给我方某个
 * agent 处理时（direct mode），记录 (本地 agent channelId) → (peer 共享频道 id +
 * peer 信息)。如果该 agent 这一轮忘了用 reply() 工具答到 peer 的 #agent-exchange，
 * 而是只在 assistant 文字里说了，watcher 会 drain 到本地 agent channel —— peer 完全
 * 看不见。Stop hook 用这个 map 在 drain 后 forward 到 peer 共享频道兜底，避免消息
 * 沉默丢失。reply 工具命中 sharedChannelId 时清掉这个 entry（agent 自己做对了）。
 */
interface PendingPeerInbound {
  localAgentName: string;
  sharedChannelId: string;     // peer 那边的 #agent-exchange channel id
  peerBotId: string;
  peerBotName: string;
  isForeign: boolean;          // foreign exchange (对方 guild) vs local exchange
  ts: number;
}
const pendingPeerInbound = new Map<string, PendingPeerInbound>();

/**
 * v2.0.16+ inter-agent 消息看门狗。每当 bridge 把一条来自**另一个 agent / master**
 * 的消息投递到某个 agent 的 ws（send_to_agent / pushback / reply→别agent频道 forward
 * 任一路径都经过 deliverToLocal），记一条 (接收 agent channelId) → { fromLabel, retries }。
 *
 * 清除：那个 agent 下一次调 `reply()`（任意频道）或 `send_to_agent`（= 它在回应/
 * 行动）。
 *
 * Stop hook 兜底：如果一轮结束时这条还在（agent 既没 reply 也没 send_to_agent —
 * 大概率是收到消息后啥也没干或没报告），bridge 注一条 `[⚠️ ...]` nudge 到那 agent 的
 * ws 提醒它处理 + 用 reply() 报告。最多 nudge 2 次（retries 到 2 就放弃，不无限循环）。
 *
 * 修「agent 收到 inter-agent 消息后无动于衷」这个 LLM 行为层的兜底。注意这是兜底，
 * 不是 100% 保证 —— LLM 可能 nudge 之后还是不理，2 次后就不再打扰。
 */
interface PendingInterAgentMsg {
  fromLabel: string;
  retries: number;
  ts: number;
}
const pendingInterAgentMsg = new Map<string, PendingInterAgentMsg>();

// v2.4.16+ 清掉某个 channel 上挂着的所有 inter-agent / cross-peer pending。
// 用户在该 channel 打字（messageCreate）或者 agent 被 kill 时调，避免后续 Stop
// hook 触发的 drain兜底 / watchdog nudge / peer pushback 把 agent 拉回到无用的
// 互相 ack 链里。返回清掉条数（仅用于日志）。
function clearInterAgentPendingsForChannel(channelId: string): number {
  let n = 0;
  // pendingAgentCalls key=target channel；同时还要扫 caller=channelId 的反向
  if (pendingAgentCalls.delete(channelId)) n++;
  for (const [cid, p] of pendingAgentCalls.entries()) {
    if (p.callerChannelId === channelId) {
      pendingAgentCalls.delete(cid);
      n++;
    }
  }
  if (pendingInterAgentMsg.delete(channelId)) n++;
  // pendingPeerCalls key=对方 shared channel；同时 caller 端也要 match
  for (const [cid, p] of pendingPeerCalls.entries()) {
    if (p.callerChannelId === channelId) {
      pendingPeerCalls.delete(cid);
      n++;
    }
  }
  if (pendingPeerInbound.delete(channelId)) n++;
  return n;
}

const typingSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_SAFETY_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

// ============================================================
// v2.0.0+ 路由抽象
// ============================================================
import type {
  Endpoint as RouterEndpoint,
  LocalEndpoint as RouterLocalEndpoint,
  PeerEndpoint as RouterPeerEndpoint,
  UserEndpoint as RouterUserEndpoint,
  Envelope as RouterEnvelope,
  Delivery as RouterDelivery,
} from "./bridge/router.js";
import { endpointLabel, envelopeLabel, newThreadId } from "./bridge/router.js";

/**
 * v2.0.0+ 统一消息投递入口。所有 bridge 的出入站消息（messageCreate 路由 /
 * reply / send_to_agent / pushback / peer direct 的各 variant）都走这一个函数。
 * 内部按 to.kind 派发（local ws inject / peer discord send / user discord send），
 * 权限检查 + 状态追踪 + @ mention / header 渲染全在一处管。
 */
async function deliver(env: RouterEnvelope): Promise<RouterDelivery> {
  // 0. intent-aware 预处理：response 消息先清对应 pending
  if (env.intent === "response" && env.meta.inReplyTo) {
    for (const [key, p] of pendingReplies.entries()) {
      if (p.msgId === env.meta.inReplyTo || p.threadId === env.meta.threadId) {
        pendingReplies.delete(key);
      }
    }
    // 顺手清 thread map（按 threadId 精确清，不误伤别的 thread）
    pendingThreads.delete(env.meta.threadId);
  }

  // 1. 权限检查：peer → 本地具体 agent 的情况要查 peers.json exposures。
  //    peer → master 走 #agent-exchange 调度永远放行 —— master 是网关角色，
  //    它自己看 agent-exchange header 里的可选 exposures 列表去做调度决策。
  //    (master 的 client 在 clients 里 channelId 可能是 CONTROL 或 agent-exchange
  //    id，两个都算 master。)
  if (env.from.kind === "peer" && env.to.kind === "local") {
    const localAgentExchangeId = await getLocalAgentExchangeId();
    const toIsMaster = env.to.channelId === CONTROL_CHANNEL_ID ||
      (!!localAgentExchangeId && env.to.channelId === localAgentExchangeId);
    if (!toIsMaster) {
      try {
        const { readPeers } = await import("./lib/peers.js");
        const peers = await readPeers();
        const targetAgentName = env.to.agentName;
        if (!targetAgentName) {
          return { envelope: env, outcome: { kind: "dropped", reason: "local non-master target has no agentName" } };
        }
        const exposed = peers.exposures.some((e) =>
          (e.localAgent === targetAgentName || `agent-${e.localAgent}` === targetAgentName) &&
          (e.peerBotId === env.from.peerBotId || e.peerBotId === "all")
        );
        if (!exposed) {
          return { envelope: env, outcome: { kind: "dropped", reason: `${targetAgentName} not exposed to peer ${env.from.peerBotName}` } };
        }
      } catch (e) {
        console.error("deliver permission check 异常:", e);
        return { envelope: env, outcome: { kind: "error", error: e as Error } };
      }
    }
  }

  // 2. 按目标类型派发
  try {
    switch (env.to.kind) {
      case "local":
        return await deliverToLocal(env, env.to);
      case "peer":
        return await deliverToPeer(env, env.to);
      case "user":
        return await deliverToUser(env, env.to);
    }
  } catch (e) {
    console.error(`deliver 失败 ${envelopeLabel(env)}:`, e);
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/** 投递到本地 Claude Code session —— 通过 ws 注入一条 "message" 事件 */
async function deliverToLocal(env: RouterEnvelope, to: RouterLocalEndpoint): Promise<RouterDelivery> {
  const content = await renderContentForLocal(env);
  // chat_id 是 agent reply() 时要传回的 id：消息从哪个 Discord 频道来，回复就发回那里。
  // direct route 场景下 from 是 peer 在 #agent-exchange，agent 被"偷偷"路由到自己私频，
  // 但 reply 目标必须还是 #agent-exchange，不是 agent 的私频。
  const replyBackChannel = resolveReplyBackChannel(env);
  const meta: Record<string, string> = {
    chat_id: replyBackChannel,
    message_id: env.meta.messageId,
    ts: env.meta.ts,
    trigger: env.meta.triggerKind,
    intent: env.intent,
    thread_id: env.meta.threadId,
  };
  if (env.from.kind === "user") {
    meta.user = env.from.username ?? "";
    meta.user_id = env.from.userId;
  } else if (env.from.kind === "peer") {
    meta.user = env.from.peerBotName;
    meta.user_id = env.from.peerBotId;
    meta.peer = "true";
    meta.peer_bot_id = env.from.peerBotId;
    meta.peer_bot_name = env.from.peerBotName;
  } else if (env.from.kind === "local") {
    meta.user = env.from.agentName ?? "agent";
    meta.user_id = "agent";
    meta.is_agent = "true";
    meta.from_channel_id = env.from.channelId;
  } else if (env.from.kind === "bridge") {
    meta.user = `bridge${env.from.label ? `:${env.from.label}` : ""}`;
    meta.user_id = "bridge";
    meta.is_bridge = "true";
  }
  if (env.meta.attachments && env.meta.attachments.length > 0) {
    meta.attachment_count = String(env.meta.attachments.length);
    meta.attachments = env.meta.attachments.join(";");
  }
  try {
    to.ws.send(JSON.stringify({ type: "message", content, meta }));
    // intent=request 挂 pending + thread 追踪。response 端到端，不挂新 pending。
    if (env.intent === "request") {
      pendingReplies.set(replyBackChannel, {
        msgId: env.meta.messageId,
        ts: Date.now(),
        intendedReplyChannel: replyBackChannel,
        targetWs: to.ws,
        threadId: env.meta.threadId,
      });
      pendingThreads.set(env.meta.threadId, {
        request: env,
        targetWs: to.ws,
        ts: Date.now(),
      });
    }
    // v2.0.16+: 来自另一个 agent / master 的消息（send_to_agent / pushback /
    // reply→别agent forward 都经这里），记看门狗 pending。peer 消息（from.kind=peer）
    // 不记 —— 那走 PEER DIRECT header，有 reply([DIRECT]) 的明确指引，且回路是
    // pendingPeerInbound 那条线。
    // v2.4.16+: meta.skipInterAgentWatchdog=true 时不挂 watchdog（oneShot 的 fire
    // -and-forget 场景，caller 不期待回应，watchdog 没必要打扰 target）。
    if (
      env.from.kind === "local" &&
      env.from.ws !== to.ws &&
      !env.meta.skipInterAgentWatchdog
    ) {
      pendingInterAgentMsg.set(to.channelId, {
        fromLabel: env.from.agentName || "另一个 agent",
        retries: 0,
        ts: Date.now(),
      });
    }
    return { envelope: env, outcome: { kind: "sent" } };
  } catch (e) {
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/** 从 envelope 推断 "response 应该发回哪个 channel" —— 用于 pending 的
 *  intendedReplyChannel + 生成给 agent 的 meta.chat_id。from=bridge 的系统
 *  消息没有"发回哪里"的语义，返回空串，调用方如果需要 chat_id 自己兜底。*/
function resolveReplyBackChannel(env: RouterEnvelope): string {
  if (env.from.kind === "user") return env.from.channelId;
  if (env.from.kind === "peer") return env.from.sharedChannelId;
  if (env.from.kind === "local") return env.from.channelId;
  return "";
}

/**
 * 投递到 peer —— 通过共享 #agent-exchange 发消息。
 * `env.meta.skipAutoMention === true`（agent 已自己写好 @ 或 [DIRECT] 语境）
 * 直接发原文；否则 ensurePeerMentions 扫频道里所有 peer bot 自动 @ 它们。
 * 支持 chunking / reply_to / files / components（通过 meta 透传 discordReply）。
 */
async function deliverToPeer(env: RouterEnvelope, to: RouterPeerEndpoint): Promise<RouterDelivery> {
  // Web-only：peer 协作靠 Discord #agent-exchange，无 Discord 即无 peer 出口。
  if (!DISCORD_ENABLED) {
    return { envelope: env, outcome: { kind: "dropped", reason: "Discord disabled (Web-only)" } };
  }
  let text = env.content;
  if (!env.meta.skipAutoMention) {
    text = await ensurePeerMentions(discord, to.sharedChannelId, text);
  }
  const finalSuffix = env.meta.final ? (text.trimEnd().endsWith("[EOT]") ? "" : " [EOT]") : "";
  text = `${text}${finalSuffix}`;
  try {
    const ids = await discordReply(
      discord,
      to.sharedChannelId,
      text,
      env.meta.replyTo,
      env.meta.components as any,
      env.meta.files,
    );
    return { envelope: env, outcome: { kind: "sent", discordMessageIds: ids } };
  } catch (e) {
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/**
 * 投递到 Discord 人类用户 —— 发到他看得到的 channel。
 * 支持 chunking / reply_to / files / components（通过 meta 透传 discordReply）。
 * content 不自动 @ 用户 —— Stop hook 有独立的完成通知负责 @，这里 body 里的
 * mention 留给调用方自己控制（比如 reply handler 直接发 agent 写的 text）。
 *
 * v2.0.15+ 额外职责：如果 to.channelId 其实是**某个 agent 的频道**（注册在
 * clients 里），而且发消息的是**另一个** local agent（不是 master、不是这个频道
 * 自己的 agent），那除了贴 Discord，还会 forward 一份给那个 agent 的 claude ws ——
 * 否则它根本收不到。修 `reply(chat_id=别agent频道)` 通知对方但对方完全看不见的
 * 架构漏洞：把「agent 间通信」收敛到 deliverToLocal 一处，不管 agent 用
 * send_to_agent 还是误用 reply(chat_id=对方频道)，对方都会通过 deliverToLocal 收到。
 */
async function deliverToUser(env: RouterEnvelope, to: RouterUserEndpoint): Promise<RouterDelivery> {
  try {
    // Web-only：跳过 Discord 出口（Web tee 已负责把内容送 Web），但保留下面的
    // cross-agent forward（纯 ws，Discord 无关，两种模式都要能用）。
    const ids = DISCORD_ENABLED
      ? await discordReply(
          discord,
          to.channelId,
          env.content,
          env.meta.replyTo,
          env.meta.components as any,
          env.meta.files,
        )
      : [];
    // v2.0.15+ cross-agent forward —— 见函数注释
    if (env.from.kind === "local") {
      const fromLocal = env.from;
      const isFromMaster = !!CONTROL_CHANNEL_ID && clients.get(CONTROL_CHANNEL_ID)?.ws === fromLocal.ws;
      const targetClient = clients.get(to.channelId);
      if (!isFromMaster && targetClient && targetClient.ws !== fromLocal.ws) {
        forwardReplyToAgentClaude(fromLocal, env.content, to.channelId, targetClient)
          .catch((e) => console.error("reply→别agent频道 forward 异常:", e));
      }
    }
    if (!DISCORD_ENABLED) {
      return { envelope: env, outcome: { kind: "dropped", reason: "Discord disabled (Web-only)" } };
    }
    return { envelope: env, outcome: { kind: "sent", discordMessageIds: ids } };
  } catch (e) {
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/**
 * v2.0.15+: 把一条 agent reply 到「别的 agent 的频道」的消息，额外 forward 一份给
 * 那个 agent 的 claude ws（除了已经贴了的 Discord）。走 deliverToLocal → 自动加
 * `[🤖 来自 X]` 前缀，跟 send_to_agent 等价。fire-and-forget，best-effort。
 */
async function forwardReplyToAgentClaude(
  fromEndpoint: RouterLocalEndpoint,
  content: string,
  targetChannelId: string,
  targetClient: ClientInfo,
): Promise<void> {
  let fromAgentName = fromEndpoint.agentName;
  let targetAgentName: string | undefined;
  // reply handler 构造 fromEndpoint 时通常没填 agentName，这里查 registry 补上让
  // renderContentForLocal 的 "[🤖 来自 X]" 准确；查不到就 fallback "agent"。
  try {
    const list = await runManager("list");
    const agents = (list.agents || []) as any[];
    if (!fromAgentName) fromAgentName = agents.find((a) => a.channelId === fromEndpoint.channelId)?.name;
    targetAgentName = agents.find((a) => a.channelId === targetChannelId)?.name;
  } catch { /* non-critical */ }
  const fwdEnv: RouterEnvelope = {
    from: { kind: "local", agentName: fromAgentName, channelId: fromEndpoint.channelId, ws: fromEndpoint.ws },
    to: { kind: "local", agentName: targetAgentName, channelId: targetChannelId, ws: targetClient.ws, cwd: targetClient.cwd },
    intent: "notification",
    content: content.replace(/<@!?\d+>\s*/g, "").trim(),
    meta: {
      messageId: `reply_fwd_${Date.now()}`,
      triggerKind: "agent_tool",
      ts: new Date().toISOString(),
      threadId: newThreadId(),
    },
  };
  const fwd = await deliver(fwdEnv);
  if (fwd.outcome.kind === "sent") {
    lastMessageSource.set(targetChannelId, "agent");
    console.log(`📨 reply→别agent频道: ${fromAgentName || "?"} 的消息同时 forward 给 ${targetAgentName || targetChannelId} 的 claude`);
    recordMetric("reply_cross_agent_forward", { channelId: targetChannelId, meta: { from: fromAgentName || "" } });
  } else if (fwd.outcome.kind === "error") {
    console.error("reply→别agent频道 forward 失败:", fwd.outcome.error);
  }
}

/**
 * 给本地 agent ws 注入的消息渲染 content。根据 envelope 的 from/to +
 * 频道上下文（是不是 #agent-exchange、是不是指向 master）自动选对应的
 * header 模板。这一处统一做，messageCreate 不再就地拼 header。
 */
async function renderContentForLocal(env: RouterEnvelope): Promise<string> {
  const from = env.from;

  // bridge 系统消息（notifyMaster 广播 / hook 事件文字 等）：原样投递，不加
  // header；agent 看到的是 bridge 写的通知正文本身。
  if (from.kind === "bridge") {
    return env.content;
  }

  // 本地 agent → agent 转发（send_to_agent / pushback / reply→别agent forward）。
  // v2.0.17 引入了 imperative framing 强迫 agent 处理；v2.4.16 又往回收了一段 ——
  // 实测 "必须 reply() 报告、就算只是知会也 reply() 收到" 这种强约束跟 drain兜底
  // no-text push、ia-watchdog nudge 三者叠加，是 agent 之间永无止境互相 ack 的根因
  // （A 发 status，B 收到必须 reply 收到，A 收到 B 的 reply 又必须 reply 收到，...）。
  // 现在改成：明确这是要看的 inbound，但**没有干货就允许直接 end_turn**，不必为
  // 应付 framing 而编"收到"。真问到你的就答；否则该静默就静默。
  if (from.kind === "local") {
    const fromName = from.agentName ?? "agent";
    return [
      `[🤖 来自 ${fromName} 的 inbound 消息（非 FYI）。`,
      `判断一下：是问你/要你动手 → 用 reply()/send_to_agent 处理；是纯状态同步/答完没下文 → end_turn 静默 OK，**别为了走形式编"收到"**。`,
      `规则：有干货才说话；没干货别说话。]`,
      ``,
      env.content,
    ].join("\n");
  }

  // inbound（user / peer）—— 要不要加 header 取决于两件事：
  // (1) 源 Discord 频道是不是我们的 #agent-exchange
  // (2) 目标是不是 master（= 走 send_to_agent 调度）还是具体 agent（= direct）
  //
  // master ws 同时注册了 #control 和 #agent-exchange 两个 channel id（都指向同
  // 一个 ws），所以 to.channelId 是这两个之一都算"到 master"。
  const fromChannelId = from.kind === "user" ? from.channelId : from.sharedChannelId;
  const localAgentExchangeId = await getLocalAgentExchangeId();
  const isAgentExchange = !!localAgentExchangeId && fromChannelId === localAgentExchangeId;
  const isMaster = env.to.kind === "local" && (
    env.to.channelId === CONTROL_CHANNEL_ID ||
    (!!localAgentExchangeId && env.to.channelId === localAgentExchangeId)
  );

  if (isAgentExchange && isMaster) {
    // 我方 #agent-exchange → master：master 的职责是挑 agent 再 send_to_agent，不是自答
    return await renderAgentExchangeToMasterHeader(env);
  }

  if (from.kind === "peer" && env.to.kind === "local" && env.to.agentName && !isMaster) {
    // peer → 具体 agent（非 master）→ direct route 头。源频道可能是：
    //   - 我方 #agent-exchange（inline direct / button local 走这条）
    //   - 对方 guild 的 foreign exchange（对称直连 / button foreign 走这条）
    // renderPeerDirectHeader 内部根据 sharedChannelId 是否等于 localAgentExchangeId
    // 决定走 "local reply 回 #agent-exchange" 还是 "foreign reply + [DIRECT] + @发起人"。
    return await renderPeerDirectHeader(env, from);
  }

  // 其他情况（user/peer 在 agent 自己的频道 / 没命中上面的条件）原样投递
  return env.content;
}

/**
 * 生成 peer 直连 agent 的 header。两种 variant：
 *  - **local**（from.sharedChannelId === 我方 #agent-exchange id）：peer 在我们
 *    自己的 #agent-exchange @ 我们 → 路由到 exposed agent。reply 直接回到我方
 *    #agent-exchange，bridge 的 ensurePeerMentions 会自动补 @ peer bot。
 *  - **foreign**（from.sharedChannelId 来自对方 guild 的 exchange）：我方 bot 在
 *    对方 guild 被 @，路由到我方 exposed agent。reply 回到对方 exchange，要用
 *    `[DIRECT]` 标记 + @ 实际发起人（meta.sourceUserId），避免自动 @ 对方 bot
 *    造成对方 LLM 被唤醒。
 */
async function renderPeerDirectHeader(
  env: RouterEnvelope,
  from: RouterPeerEndpoint,
): Promise<string> {
  const to = env.to as RouterLocalEndpoint;
  const targetAgentName = to.agentName ?? "agent";
  const localAgentExchangeId = await getLocalAgentExchangeId();
  const isForeign = !!localAgentExchangeId && from.sharedChannelId !== localAgentExchangeId;
  const userName = process.env.USER_NAME || "owner";
  const sourceUserId = env.meta.sourceUserId;
  const sourceMention = sourceUserId ? `<@${sourceUserId}>` : `<@${from.peerBotId}>`;

  let purpose = "（无描述）";
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    const exposure = peers.exposures.find((e) =>
      (e.localAgent === targetAgentName || `agent-${e.localAgent}` === targetAgentName) &&
      (e.peerBotId === from.peerBotId || e.peerBotId === "all")
    );
    if (exposure?.purpose) purpose = exposure.purpose;
  } catch { /* non-critical */ }

  if (isForeign) {
    return [
      `🤝 PEER DIRECT REQUEST (对称路由) — bridge 把这条来自**对方 guild** #agent-exchange 的请求直接路由给你处理`,
      ``,
      `来源：peer bot **${from.peerBotName}** (id: \`${from.peerBotId}\`) 的 shared 频道 (\`${from.sharedChannelId}\`)`,
      `你被 expose 的理由：${purpose}`,
      ``,
      `**最终动作必须是**：\`reply(chat_id="${from.sharedChannelId}", text="[DIRECT] ${sourceMention} <你的答案>")\``,
      `- **text 一定要以 \`[DIRECT]\` 开头** —— bridge 识别到会 strip 掉这个标记并跳过自动 @ 对方 bot（否则对方 bot 会被唤醒跑一轮 LLM）`,
      `- **一定要在 text 里写 ${sourceMention} @ 发起人**，这样发起人的 Discord 能收到 push`,
      `- **\`[EOT]\` 默认不加**。只有当你这条 reply 是**纯 ack**（致谢/确认/测试回执，无新信息），或对方明显发了结束信号（done/thanks/ok）才在末尾加。提供数据/答案的 reply 一律不加，让发起方决定要不要追问。`,
      `- 不要 reply 到自己 channel；不要 send_to_agent 套娃；不要联系 master`,
      `- 如果你觉得这个请求你处理不了，reply 一句"请找 ${userName} 或其 master" 也行`,
      ``,
      `---`,
      `原始消息：`,
      env.content,
    ].join("\n");
  }

  return [
    `🤝 PEER DIRECT REQUEST — bridge 直接把这条来自 #agent-exchange 的 peer 请求路由给你处理`,
    ``,
    `来源：peer bot **${from.peerBotName}** (id: \`${from.peerBotId}\`) 在 #agent-exchange (\`${from.sharedChannelId}\`)`,
    `你被 expose 的理由：${purpose}`,
    ``,
    `**最终动作必须是**：\`reply(chat_id="${from.sharedChannelId}", text="<你的答案>")\``,
    `- bridge 会自动在你 reply 前 @ peer bot，不用自己加 \`<@id>\``,
    `- **\`[EOT]\` 默认不加**。只有当你这条 reply 是**纯 ack**（致谢/确认/测试回执，无新信息），或对方明显发了结束信号（done/thanks/ok）才在末尾加。提供数据/答案的 reply 一律不加，让发起方决定要不要追问。`,
    `- 不要 reply 到自己 channel，没人读；不要 send_to_agent 套娃，不要找 master`,
    `- 如果你觉得这个请求你处理不了，reply 一句"请找 ${userName} 或其 master" 也行`,
    ``,
    `---`,
    `原始消息：`,
    env.content,
  ].join("\n");
}

/**
 * 生成 #agent-exchange → master 的调度 header。
 * - peer 发来但这个 peer 没 exposures：polite refusal 模板
 * - 有 exposures（peer 匹配的 / user 看全部）：AGENT-EXCHANGE ROUTING 模板 + exposures 列表
 */
async function renderAgentExchangeToMasterHeader(env: RouterEnvelope): Promise<string> {
  const from = env.from;
  const isPeer = from.kind === "peer";
  const senderName = isPeer
    ? (from as RouterPeerEndpoint).peerBotName
    : (from as RouterUserEndpoint).username || "用户";
  const senderKind = isPeer ? `peer bot ${senderName}` : `用户 ${senderName}`;
  const replyChannelId = isPeer
    ? (from as RouterPeerEndpoint).sharedChannelId
    : (from as RouterUserEndpoint).channelId;

  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    const relevant = peers.exposures.filter((e) =>
      isPeer
        ? (e.peerBotId === (from as RouterPeerEndpoint).peerBotId || e.peerBotId === "all")
        : true
    );

    // peer 发来但没对它开放任何 agent：让 master 礼貌拒绝
    if (relevant.length === 0 && isPeer) {
      return [
        `⚠️ PEER REQUEST FROM ${senderName} — NO EXPOSURES DEFINED`,
        ``,
        `你还没有对这个 peer 开放任何本地 agent。礼貌回一句"${process.env.USER_NAME || "User"} 还没对你开放任何 agent，请让他 peer-expose 后再试"，结束本轮。**不要**自己回答 peer 问题。`,
        ``,
        `---`,
        `原始消息：`,
        env.content,
      ].join("\n");
    }

    // 有可用 exposures：列出来让 master 挑一个调度
    if (relevant.length > 0) {
      const exposureList = relevant
        .map((e) => `  - ${e.localAgent}${e.purpose ? ` (用途: ${e.purpose})` : ""}`)
        .join("\n");
      return [
        `🚨 AGENT-EXCHANGE 消息 FROM ${senderKind} — YOU MUST ROUTE, NOT ANSWER`,
        ``,
        `这条消息来自 #agent-exchange 频道，需要路由给本地 agent，而不是你自己回答。可选 agent：`,
        exposureList,
        ``,
        `步骤：`,
        `1. 挑跟请求最匹配的 agent`,
        `2. \`send_to_agent(target="<agent 名字>", text="来自 ${senderKind} 的请求：<原文>")\``,
        `3. fetch_messages 轮询对应 channelId 等回复（首次 15s sleep，之后每 10s 轮询，最多 5 次）`,
        `4. 拿到 agent 回复后用 \`reply(chat_id="${replyChannelId}", text="...")\` 转述${isPeer ? "给 peer（bridge 会自动 @ 对方 bot）" : "给用户"}`,
        ``,
        `🚫 不要自己回答，即便你觉得你知道答案。这个频道的语义就是"agent 间协作"，你只做调度。`,
        ``,
        `⚠️ **最后一步必须是 \`reply\` 工具调用**。纯文字输出只到你本地终端，Discord 看不到，用户只会收到 Stop 的空 "✅ 完成" 通知。没调 reply = 没回。`,
        ``,
        `---`,
        `原始消息：`,
        env.content,
      ].join("\n");
    }
  } catch (e) {
    console.error("agent-exchange header 渲染失败:", e);
  }

  // 失败兜底：原样投递，master 自己看着办
  return env.content;
}

// 任务完成语（只留抽象搞笑的）
const UMA_DONE_MESSAGES = [
  // 复读机系列
  "哈基米哈基米哈基米哈基米",
  "哈基米…哈基米…（倒地）",
  "哈基米（沉思）",
  "我哈基米完了",
  "哈？基？米？",
  "不要叫我哈基米叫我哈尼",
  "曼波。（转身离开）",
  "这活干得我都想曼波了",
  "搞定了别催了你再催我曼波了",
  "曼波一下怎么了曼波一下又不会怀孕",
  "曼波是一种精神状态",
  "うまぴょいうまぴょいうまぴょいうまぴょい",
  // 马叫/发癫系列
  "呜嘶～～～～～",
  "嘶哈嘶哈嘶哈完事了",
  "嘶。（简洁有力）",
  "（发出了马的声音）",
  "嘶嘶嘶别摸我我还没缓过来",
  "嗷呜——等等我不是狼我是马",
  // 括号动作系列
  "（甩尾巴）",
  "（原地转了三圈然后躺下了）",
  "（做了一个帅气的pose但是没人看到）",
  "（刨地）",
  "（耳朵竖起来了）",
  "（耳朵耷拉下去了）",
  "（假装若无其事地舔了一下屏幕）",
  "（已读）",
  "草（物理意义上的草）（然后吃掉了）",
  // 身份危机系列
  "我不是马我是驴（不是）",
  "等等我到底是AI还是马",
  "说起来我有蹄子怎么打字的",
  // 互联网梗系列
  "寄",
  "差不多得了😇",
  "我超！结束了！",
  "6",
  "笑死 根本不难好吧",
  "就这？就这？？",
  "赢麻了赢麻了",
  "难绷 但是跑完了",
  "你说得对 但是我已经做完了",
  "鉴定为：完成了",
  "这波啊 这波是直接秒了",
  "但是又如何呢（做完了）",
  "有一说一 确实做完了",
  "听我说谢谢你——算了不唱了",
  "完了完了（物理意义上的完了）",
  "急了急了 谁急了？反正不是我 我做完了",
  // 哲学系列
  "完成了。但完成的意义是什么呢。算了不想了",
  "如果一匹马在赛道上完成了任务 但是没人知道 那它算完成了吗",
  "做完了。突然觉得有点空虚。再来？",
  "世界上有两种马 做完活的和没做完活的 我是前者",
  // 长的无厘头
  "报告训练员 本马娘已完成任务 请求批准吃三根胡萝卜 两块方糖 以及摸摸头",
  "我宣布 在座的各位 都没我跑得快 因为我已经到终点了",
  "做完了做完了 你不夸我一句吗 你怎么不说话 你是不是不爱我了",

  // ───── 第二批补充 50 条 ─────

  // 复读机 2
  "哈基米是一种生活态度",
  "哈什么基什么米什么",
  "哈基曼波 曼波哈基 哈曼基波",
  "曼波 ≠ 曼波 ≈ 曼波",
  "曼曼波波曼曼波",
  // 马叫 2
  "嗷！！（没有理由的嗷）",
  "嘶啊——（突然吓到自己）",
  "咴咴咴咴咴",
  "嘘——（我在偷偷完成）",
  // 括号动作 2
  "（把任务卷起来吃了）",
  "（对着空气鞠了一躬）",
  "（试图用蹄子打响指 失败）",
  "（深吸一口气 吐出彩虹）",
  "（把自己叠成纸飞机飞走了）",
  "（和自己的影子击了个掌）",
  "（做了一个 spin attack）",
  "（走了 但是是倒着走的）",
  "（装作没完成的样子完成了）",
  "（眨眼 慢动作）",
  "（把键盘藏起来假装没动过）",
  // 身份危机 2
  "等等 我是不是在梦里完成的",
  "我刚才是不是死了一下又复活了",
  "我是谁 我在哪 我做完了什么",
  "我感觉有三个我 他们都说做完了",
  "如果我是你 我也会说我做完了",
  // 互联网梗 2
  "这活啊 是真活",
  "我 做完了 怎么了",
  "任务：完成 情绪：未知",
  "确认收货 给五星好评",
  "你礼貌吗？但是我做完了",
  "这事有蹊跷 但是做完了",
  "大无语事件 做完了",
  "我直接裂开 但是是裂开着做完的",
  "啊？什么？完了？完了",
  "不会吧不会吧 真有人这么快就做完了",
  "蚌埠住了（真的做完了）",
  "这届任务不行（但是做完了）",
  "老登做完了",
  "妈耶 这都能做完",
  "做了个寂寞 啊不是 做完了",
  "我是懂做任务的",
  "完成度 100% 精神度 0%",
  "刚才那个是谁做完的 哦是我啊",
  // 哲学/玄学 2
  "完成的尽头是什么 是又一个完成",
  "道可道 非常道 完成可完成 非常完成",
  "有人问我完成是什么 我说是一种震动",
  "活着就是为了完成 完成就是为了活着",
  "量子力学告诉我 我既完成了又没完成",
  // 长抽象 2
  "这个任务 我仔细一看 里面写着两个字 完成 然后我就完成了",
  "想了一整晚 最后决定 还是完成一下吧 你开心就好",
];

function randomUmaDone(): string {
  return UMA_DONE_MESSAGES[Math.floor(Math.random() * UMA_DONE_MESSAGES.length)];
}

/** 开始 typing + 设置安全超时 */
function startTypingWithSafety(channelId: string) {
  startTyping(channelId, discord);
  // 清除旧的安全计时器
  const old = typingSafetyTimers.get(channelId);
  if (old) clearTimeout(old);
  // 30 分钟后强制停止 typing（兜底 hooks 失败的情况）
  const timer = setTimeout(() => {
    stopTyping(channelId);
    typingSafetyTimers.delete(channelId);
    const statusMsgId = activeStatusMessages.get(channelId);
    if (statusMsgId) {
      discord.channels.fetch(channelId).then((ch) => {
        if (ch && "messages" in ch) {
          const textCh = ch as TextChannel;
          textCh.messages.fetch(statusMsgId).then((sm) => {
            sm.edit({ content: "⏰ 超时自动停止", components: [] }).catch(() => {});
          }).catch(() => {});
          // 发新消息通知用户
          const mention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
          if (mention) {
            textCh.send(`⏰ 超时自动停止 ${mention}`).catch(() => {});
          }
        }
      }).catch(() => {});
      activeStatusMessages.delete(channelId);
    }
  }, TYPING_SAFETY_TIMEOUT_MS);
  typingSafetyTimers.set(channelId, timer);
}

/** 清除安全超时（在 hook 或手动停止时调用） */
function clearSafetyTimer(channelId: string) {
  const timer = typingSafetyTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    typingSafetyTimers.delete(channelId);
  }
}

// ============================================================
// Discord Client
// ============================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,       // v1.8.4+: guildMemberAdd 事件，peer bot 加入通知
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

discord.once("ready", async () => {
  setBotUserId(discord.user?.id || "");
  console.log(`✅ Discord 已连接: ${discord.user?.tag}`);
  console.log(`📡 Bridge WebSocket: ws://localhost:${BRIDGE_PORT}`);
  console.log(`🔗 已注册频道: ${clients.size}`);

  // v1.9.28+: bridge 重启时会丢失 activeStatusMessages 内存，重启前还在跑的
  // 任务的"💭 思考中..."按钮消息就卡那儿了，Stop hook 触发时查不到 message id
  // 没法编辑。启动后扫所有 registered channel 的近期消息，把遗留的思考中消息
  // 编辑成"bridge 已重启"。
  cleanupStaleThinkingMessages().catch((e) => console.error("清理遗留思考中消息失败:", e));

  // 扫 skill + 为已有 active agent 扫项目级
  await scanGlobalSkills();
  try {
    const listResult = await runManager("list");
    for (const a of listResult.agents || []) {
      if (a.status === "active" && a.cwd) {
        await scanProjectSkills(a.name, a.cwd);
      }
    }
  } catch { /* non-critical */ }

  // 注册 Slash Commands
  await registerSlashCommands();

  // 启动权限弹窗 watcher
  startPermissionWatcher(ALLOWED_USER_IDS, discord);

  // 启动 wedge watcher — 检测长时间没动静但又不 idle 的 agent
  startWedgeWatcher(discord);
  recordMetric("bridge_start", { meta: { channels: clients.size } });

  // 每 30 分钟自动重扫 skill（新装 plugin / 新建 user skill 不需要 restart bridge 就能出现在 /）
  setInterval(async () => {
    try {
      await scanGlobalSkills();
      const listResult = await runManager("list");
      for (const a of listResult.agents || []) {
        if (a.status === "active" && a.cwd) {
          await scanProjectSkills(a.name, a.cwd);
        }
      }
      await registerSlashCommands();
    } catch (e) {
      console.error("定时 skill 重扫失败:", e);
    }
  }, 30 * 60_000);

  // v2.4.6+: Discord gateway WS 健康看门狗。
  // 现象：discord.js gateway WebSocket 偶尔静默断开（discord.js 内部 zombie state），
  // client 不触发 reconnect、bridge 进程主循环还活着、HTTP /hook + outbound REST API
  // 还能用，但收不到任何 messageCreate / interactionCreate event。用户看到 worker
  // / master 对 Discord 消息无响应，但 agent reply() 出来的还能看到。
  // 兜底：连续 5 次（5min）ws.status 不是 READY 就 process.exit(1)，launchd KeepAlive
  // 自动拉起 bridge，走全新 ready setup 全部恢复。
  let unhealthyTicks = 0;
  setInterval(() => {
    const status = (discord as any).ws?.status;
    if (status === 0) {
      unhealthyTicks = 0;
    } else {
      unhealthyTicks++;
      console.warn(`⚠️ Discord gateway WS status=${status} (≠READY) — unhealthy ${unhealthyTicks}/5`);
      if (unhealthyTicks >= 5) {
        console.error(`💀 Discord gateway WS 持续 5 分钟非 READY — exit 让 launchd KeepAlive 重启 bridge`);
        process.exit(1);
      }
    }
  }, 60_000);
});

// v2.4.6+: shard 事件监听 — discord.js gateway 异常的诊断信号。
// 这些事件本身不一定意味着真死了；触发 KeepAlive 重启交给上面的 5 分钟看门狗判定。
// v2.4.12+: 加 disconnect 频率看门狗 —— 5min ws.status 看门狗漏掉了"反复 disconnect
// + 每次都立刻 resume"的情况（单次断连几秒钟，下次 tick 时 ws.status 已回 READY，
// unhealthyTicks 清零）。但每次 disconnect 都会让 Discord 丢失短 TTL 事件，尤其
// interaction event（3s 内必须 ack 否则 user 看到"交互失败"）。24h 内 10 次 disconnect
// 累积起来 = 几十个 interaction 漏 dispatch = user 报"所有按钮都点不了"。
// 阈值：30min 滑窗内累计 ≥3 次 disconnect 就 process.exit 让 launchd 重建全新连接。
// 单次 disconnect→resume 是 Discord gateway 正常行为（区域迁移 / 网络抖动），不该触发。
const reconnectTimestamps: number[] = [];
const RECONNECT_WINDOW_MS = 30 * 60_000;
const RECONNECT_THRESHOLD = 3;
discord.on("shardDisconnect" as any, (event: any, shardId: number) => {
  console.warn(`⚠️ shard ${shardId} disconnect: code=${event?.code} reason="${event?.reason || ""}"`);
  const now = Date.now();
  reconnectTimestamps.push(now);
  const cutoff = now - RECONNECT_WINDOW_MS;
  while (reconnectTimestamps.length > 0 && reconnectTimestamps[0] < cutoff) {
    reconnectTimestamps.shift();
  }
  if (reconnectTimestamps.length >= RECONNECT_THRESHOLD) {
    console.error(`💀 30min 内 shard disconnect ${reconnectTimestamps.length} 次，interaction event 漏 dispatch 风险高 — exit 让 launchd KeepAlive 重建 gateway 连接`);
    process.exit(1);
  }
});
discord.on("shardError" as any, (error: Error, shardId: number) => {
  console.error(`⚠️ shard ${shardId} error: ${error?.message}`);
});
discord.on("shardReconnecting" as any, (shardId: number) => {
  console.log(`🔄 shard ${shardId} reconnecting…`);
});
discord.on("shardResume" as any, (shardId: number, replayed: number) => {
  console.log(`✅ shard ${shardId} resumed (replayed ${replayed} events)`);
});
discord.on("shardReady" as any, (shardId: number) => {
  console.log(`✅ shard ${shardId} ready`);
});

// ────────────────────────────────────────────────
// Slash command 构建 + 注册（可重入）
// ────────────────────────────────────────────────
let lastRegisteredHash = "";

function truncateDesc(desc: string, fallback: string): string {
  const s = (desc || fallback || "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 100) : fallback.slice(0, 100);
}

/**
 * 构建完整的 Discord slash command 列表（内置 bridge 命令 + CC built-in + 所有 skill）。
 */
function buildAllSlashCommands(): any[] {
  const commands: any[] = [
    // bridge 自己的 4 个
    new SlashCommandBuilder().setName("screenshot").setDescription("截取当前 agent 的终端画面").toJSON(),
    new SlashCommandBuilder().setName("interrupt").setDescription("打断当前 agent 的操作 (Ctrl+C)").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("查看所有 agent 的状态").toJSON(),
    new SlashCommandBuilder().setName("cron").setDescription("查看和管理定时任务").toJSON(),
  ];
  const bridgeNames = new Set(["screenshot", "interrupt", "status", "cron"]);

  for (const item of allRegistrableCommands()) {
    if (item.kind === "builtin") {
      const c = item.cmd;
      if (bridgeNames.has(c.name)) continue; // 优先 bridge 自己的
      const b = new SlashCommandBuilder()
        .setName(c.name)
        .setDescription(truncateDesc(c.description, `Claude Code ${c.name}`));
      for (const opt of c.options) {
        if (opt.type === "choices") {
          b.addStringOption((o) => {
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required);
            for (const ch of opt.choices || []) o.addChoices({ name: ch, value: ch });
            return o;
          });
        } else {
          b.addStringOption((o) =>
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required)
          );
        }
      }
      commands.push(b.toJSON());
    } else {
      const s = item.skill;
      if (bridgeNames.has(s.discordName)) continue;
      const b = new SlashCommandBuilder()
        .setName(s.discordName)
        .setDescription(truncateDesc(s.description, `skill: ${s.invokeName}`))
        .addStringOption((o) =>
          o.setName("args").setDescription(truncateDesc(`参数（可选）会原样附加到 /${s.invokeName} 后面`, "参数"))
        );
      commands.push(b.toJSON());
    }
  }
  return commands;
}

async function registerSlashCommands(): Promise<void> {
  // Web-only：无 Discord 连接，slash commands 是 Discord 专属（discord.user 为 null）。
  if (!DISCORD_ENABLED) return;
  try {
    const commands = buildAllSlashCommands();
    // 用 hash 去重 — 命令列表没变就不 REST PUT，省 Discord 配额
    const hash = JSON.stringify(commands);
    if (hash === lastRegisteredHash) {
      console.log(`📝 Slash Commands 未变 (${commands.length} 条)，跳过重注册`);
      return;
    }
    const rest = new REST().setToken(DISCORD_TOKEN);
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(discord.user!.id, DISCORD_GUILD_ID), { body: commands });
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: [] });
      console.log(`📝 Slash Commands 已注册 (guild, ${commands.length} 条) + 清除全局`);
    } else {
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: commands });
      console.log(`📝 Slash Commands 已注册 (global, ${commands.length} 条)`);
    }
    lastRegisteredHash = hash;
  } catch (err) {
    console.error("Slash Commands 注册失败:", err);
  }
}

// ────────────────────────────────────────────────
// Slash 结果呈现（支持 TUI modal 适配 → Discord 按钮/菜单）
// ────────────────────────────────────────────────

/**
 * 发完 slash 命令 + 等 2.5s 之后调。
 * 截一张图；如果 pane 上有数字选项 modal，就把选项以 Discord 按钮/select 的形式暴露给用户。
 * 否则就只发截图。
 */
async function presentSlashResult(
  interaction: any,
  targetWindow: string,
  targetLabel: string,
  ccText: string
): Promise<void> {
  const pane = await tmuxCapture(targetWindow, 40);
  const options = parseModalOptions(pane);
  const arrowNav = options ? null : detectArrowNavModal(pane);
  const pngPath = await tmuxScreenshot(targetLabel);
  const baseContent = `⚡ **${targetLabel}** ← \`${ccText}\``;

  // 无 modal → 截图 + Esc 兜底按钮（防止偶发 modal 没被检测到导致 session 卡住）
  // 兜底按钮（没有 modal 时）：Esc + 🤖 让大总管处理
  if (!options && !arrowNav) {
    const payload: any = {
      content: baseContent,
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `modal:${targetWindow}:esc`, label: "Esc (兜底)", emoji: "❌", style: "secondary" },
            { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
          ],
        },
      ]),
    };
    if (pngPath) payload.files = [{ attachment: pngPath }];
    else payload.content = `${baseContent}（截图失败）`;
    await interaction.editReply(payload).catch(() => {});
    return;
  }

  // 有 modal → 截图 + 按钮（按钮组里已含 🤖 升级按钮）
  const header = options
    ? `🎛 **${targetLabel}** 的 TUI 选项（\`${ccText}\`）：`
    : `🎛 **${targetLabel}** 的 ${arrowNav} 箭头 modal（\`${ccText}\`），用按钮导航 + 点 ✅ 确认：`;
  const modalRows = options
    ? buildModalComponents(targetWindow, options, ccText)
    : buildArrowModalComponents(targetWindow, arrowNav!, ccText);
  const payload: any = { content: header, components: modalRows };
  if (pngPath) payload.files = [{ attachment: pngPath }];
  await interaction.editReply(payload).catch(() => {});
}

/**
 * 把 modal 选项渲染成 Discord components。
 * ≤5 项 → 按钮行；>5 项 → string select menu。
 * 再追加一个 "❌ 取消 (Esc)" + 🤖 升级按钮。
 */
function buildModalComponents(targetWindow: string, options: { key: string; label: string; selected: boolean }[], ccText = "") {
  const rows: any[] = [];
  const escId = `modal:${targetWindow}:esc`;
  const escalateId = `escalate:${targetWindow}:${encodeURIComponent(ccText)}`;

  if (options.length <= 5) {
    const buttons = options.map((o) => ({
      id: `modal:${targetWindow}:${o.key}`,
      label: `${o.key}. ${o.label}`.slice(0, 80),
      style: o.selected ? "success" : "primary",
    }));
    rows.push({ type: "buttons" as const, buttons });
  } else {
    rows.push({
      type: "select" as const,
      id: `modal:${targetWindow}:select`,
      placeholder: "选一个选项",
      options: options.map((o) => ({
        label: `${o.key}. ${o.label}`.slice(0, 100),
        value: o.key,
        description: o.selected ? "当前选中" : undefined,
      })),
    });
  }
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: escId, label: "取消 (Esc)", style: "secondary", emoji: "❌" },
      { id: escalateId, label: "让大总管处理", style: "primary", emoji: "🤖" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 把箭头导航 modal 渲染成上下左右 + Enter + Esc + 🤖 升级按钮。
 */
function buildArrowModalComponents(targetWindow: string, kind: ArrowNavKind, ccText = "") {
  const rows: any[] = [];
  const navButtons: any[] = [];
  if (kind === "vertical" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:up`, label: "Up", emoji: "⬆️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:down`, label: "Down", emoji: "⬇️", style: "primary" });
  }
  if (kind === "horizontal" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:left`, label: "Left", emoji: "⬅️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:right`, label: "Right", emoji: "➡️", style: "primary" });
  }
  rows.push({ type: "buttons" as const, buttons: navButtons });
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: `modal:${targetWindow}:enter`, label: "确认 (Enter)", emoji: "✅", style: "success" },
      { id: `modal:${targetWindow}:esc`, label: "取消 (Esc)", emoji: "❌", style: "secondary" },
      { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 按钮 / select 点击后，把按键发给 tmux，等 1.5s，再次截图 + 可能再出 modal。
 */
async function handleModalInteraction(
  interaction: any,
  targetWindow: string,
  key: string
): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  recordMetric("modal_button", { agent: targetWindow.replace(/^master:/, ""), meta: { key } });
  try {
    const keyMap: Record<string, string> = {
      esc: "Escape",
      enter: "Enter",
      left: "Left",
      right: "Right",
      up: "Up",
      down: "Down",
    };
    const tmuxKey = keyMap[key] ?? key; // 数字键保持原样
    await tmuxRaw(["send-keys", "-t", targetWindow, tmuxKey]);
    await Bun.sleep(1500);
    const pane = await tmuxCapture(targetWindow, 40);
    const options = parseModalOptions(pane);
    const arrowNav = options ? null : detectArrowNavModal(pane);
    const pngPath = await tmuxScreenshot(targetWindow.replace(/^master:/, ""));
    const label = targetWindow.replace(/^master:/, "");

    const payload: any = {};
    if (options) {
      payload.content = `🎛 **${label}** 的 TUI 选项（继续）：`;
      payload.components = buildModalComponents(targetWindow, options);
    } else if (arrowNav) {
      payload.content = `🎛 **${label}** 的 ${arrowNav} 箭头 modal（继续，用 ✅ 确认）：`;
      payload.components = buildArrowModalComponents(targetWindow, arrowNav);
    } else {
      payload.content = `✅ **${label}** 已执行（key=${key}）`;
      payload.components = [];
    }
    if (pngPath) payload.files = [{ attachment: pngPath }];
    await interaction.editReply(payload).catch(() => {});
  } catch (e) {
    await interaction.editReply({
      content: `❌ Modal 交互失败：${(e as Error).message}`,
      components: [],
    }).catch(() => {});
  }
}

// ============================================================
// 入站消息处理
// ============================================================

discord.on("messageCreate", async (msg: DiscordMessage) => {
  // 跳过自己 bot 的消息（echo）+ 跳过 bridge 自己发出去的（见 trackSentMessage）
  if (msg.author.id === getBotUserId()) return;
  if (isBotMessage(msg.id)) return;

  const mentionedMe = msg.mentions.users.has(getBotUserId());
  const channelId = msg.channelId;

  // v1.9.0+: PeerEvent 事件解析（grant/revoke 通告）— peer bot 发来的
  // 如果这条消息正文里有 PeerEvent 标记，解析后更新本地 capabilities 并主动 notify master（让用户知道对方新开放/撤销）
  if (msg.author.bot) {
    try {
      const { parsePeerEvent, addCapability, removeCapability } = await import("./lib/peers.js");
      const event = parsePeerEvent(msg.content || "");
      if (event) {
        console.log(`📥 PeerEvent 收到: ${JSON.stringify(event)} from ${msg.author.tag}`);
        const myBotId = getBotUserId();
        // event.peer 可以是我方 bot id 或 "all"；只处理针对我们的
        if (event.peer === myBotId || event.peer === "all") {
          if (event.kind === "grant") {
            await addCapability({
              peerBotId: msg.author.id,
              peerBotName: msg.author.tag,
              peerAgentExchangeId: event.exchange,
              peerAgent: event.local,
              purpose: event.purpose,
              mode: event.mode,
            });
            console.log(`📥 学到能力: peer ${msg.author.tag} 开放 ${event.local}（${event.purpose ?? "无描述"}）`);
            await notifyMaster(
              [
                `🤝 **对方 Claudestra 开放了新能力给你**`,
                ``,
                `来源：**${msg.author.tag}**（peer bot id \`${msg.author.id}\`）`,
                `开放 agent：**${event.local}**`,
                event.purpose ? `用途：${event.purpose}` : "",
                ``,
                `你的 \`~/.claude-orchestrator/peers.json\` 里 capabilities 已更新。`,
                `以后本地 agent 遇到相关问题可以直接去 **#agent-exchange** 频道 @ ${msg.author.tag} 提问。`,
              ].filter(Boolean).join("\n")
            );
          } else if (event.kind === "revoke") {
            await removeCapability(msg.author.id, event.local);
            console.log(`📥 撤销能力: peer ${msg.author.tag} 收回 ${event.local}`);
            await notifyMaster(
              [
                `🚫 **对方 Claudestra 撤销了能力**`,
                ``,
                `来源：**${msg.author.tag}**`,
                `撤销 agent：**${event.local}**`,
              ].join("\n")
            );
          }
        }
      }
    } catch (e) {
      console.error("PeerEvent 处理失败:", e);
    }
  }

  // v1.9.22+: peer bot 在 shared channel 发消息 → 如果我方最近刚对这个 channel
  // 发了跨 peer send_to_agent，把 peer bot 这条回复 push 回 caller 的 ws（免轮询）。
  // 命中后 early return，不再让 master / direct 路由重复处理同一条消息。
  // [EOT] 标记的消息不触发 pushback（那是关闭信号，没实质内容）。
  if (msg.author.bot && !/\[EOT\]\s*$/i.test(msg.content || "")) {
    const pp = pendingPeerCalls.get(channelId);
    if (pp && pp.peerBotId === msg.author.id) {
      const cleanText = (msg.content || "")
        .replace(/<!--\s*CLAUDESTRA_PEER_EVENT[\s\S]*?-->/g, "")
        .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
        .replace(/<@!?\d+>\s*/g, "")
        .trim();
      if (cleanText) {
        try {
          // v2.0.0 Phase 4b: 从直接 pp.callerWs.send 改成 deliver(envelope)。
          // from=local 用 agentName="peer <bot>/<agent>" 标识来源（render 会自动
          // 拼 "[🤖 来自 peer bot/agent]" 前缀，跟原来 "[🤖 peer X/Y 回复]" 等价）。
          const peerPushBody = pp.expecting
            ? `[💡 你之前 send_to_agent 给 peer ${pp.peerBotName}/${pp.peerAgent} 时填的期望：${pp.expecting}\n对方答复如下，请按计划继续，不要只 relay 给用户。]\n\n${cleanText}`
            : cleanText;
          const pushEnv: RouterEnvelope = {
            from: {
              kind: "local",
              agentName: `peer ${pp.peerBotName}/${pp.peerAgent}`,
              channelId,
              ws: pp.callerWs,
            },
            to: {
              kind: "local",
              agentName: pp.callerName,
              channelId: pp.callerChannelId,
              ws: pp.callerWs,
            },
            intent: "response",
            content: peerPushBody,
            meta: {
              messageId: `peer_reply_${Date.now()}`,
              triggerKind: "peer_discord",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
            },
          };
          const delivery = await deliver(pushEnv);
          if (delivery.outcome.kind === "sent") {
            lastMessageSource.set(pp.callerChannelId, "agent");
            console.log(`📨 PEER PUSH-BACK: ${pp.peerBotName}/${pp.peerAgent} 回复 → push 给 caller=${pp.callerChannelId}（吞掉本条，不走 master/direct）`);
            recordMetric("peer_pushback", { channelId: pp.callerChannelId, meta: { peer: pp.peerBotName, peerAgent: pp.peerAgent } });
          } else if (delivery.outcome.kind === "error") {
            console.error("PEER PUSH-BACK 发送失败:", delivery.outcome.error);
          }
          pendingPeerCalls.delete(channelId);
          return; // 吞掉，不再走下面的流程
        } catch (e) {
          console.error("PEER PUSH-BACK 异常:", e);
        }
      }
    }
  }

  // Peer bot（其他 Claudestra / 任意外部 bot）：必须 @ 我们才处理。
  // @ 是跨 agent 协作的强制语义 —— "这条消息给你，你要响应"。没 @ 就不转发给 agent，
  // 对方 agent 看到"没回应"就会知道自己忘了 @ 或 bridge 没自动补 @。
  // 保证：我方 reply() 时 bridge 会自动补 @ peer bot（见 ensurePeerMentions），所以我方不会忘。
  if (msg.author.bot) {
    if (!mentionedMe) return;
  } else if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    // 人类但不在 allowlist：只有 @ 了我们才处理（跨服有人找我们的场景）
    if (!mentionedMe) return;
  }

  // v1.9.22+: 本地 allowlist user 在 #agent-exchange 里只 @ peer bot、没 @ 我们 →
  // 不 forward 给我方 master（免得它以为用户在问自己，浪费 turn 或误答）。
  // 这种消息意图是"用对方的 agent"，让对方 bridge 处理就行。
  const exchangeIdForSkip = await getLocalAgentExchangeId();
  if (!msg.author.bot && channelId === exchangeIdForSkip && !mentionedMe) {
    const peerBotsInMsg = Array.from(msg.mentions.users.values()).filter(
      (u) => u.bot && u.id !== getBotUserId()
    );
    if (peerBotsInMsg.length > 0) {
      console.log(`🎯 SKIP local-forward: user ${msg.author.username} @ peer bot ${peerBotsInMsg.map((u) => u.username).join("/")} 不 @ 我方 bot，交给对方 bridge 处理`);
      return;
    }
  }

  // v1.9.22+: 对称 direct 路由 —— peer bot 是我们自己的 bot（即我们被 invite 到对方 guild），
  // 对方 guild 的 #agent-exchange 里的消息 @ 我们，需要路由到我方**指定的 exposed agent**。
  // 即使 clients.get 找不到（那是对方 guild 的频道，我们没注册过任何 channel-server），
  // 也应该识别出是 foreign #agent-exchange 并走 direct 路由。
  if (!clients.get(channelId) && mentionedMe) {
    const handled = await tryRouteForeignAgentExchange(msg, channelId);
    if (handled) return;
  }

  const client = clients.get(channelId);
  if (!client) return;
  const isPeer = msg.author.bot;

  let content = msg.content
    .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
    .trim();

  // 处理附件
  const attachmentPaths: string[] = [];
  if (msg.attachments.size > 0) {
    const inboxDir = `${TMP_DIR}/inbox`;
    await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
    for (const [, att] of msg.attachments) {
      try {
        const resp = await fetch(att.url);
        const buf = await resp.arrayBuffer();
        const filePath = `${inboxDir}/${att.id}_${att.name}`;
        await Bun.write(filePath, buf);
        attachmentPaths.push(filePath);
      } catch (err) {
        console.error(`下载附件失败: ${att.name}`, err);
      }
    }
  }

  if (attachmentPaths.length > 0) {
    const attDesc = attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n");
    content = content ? `${content}\n\n${attDesc}` : attDesc;
  }

  if (!content) return;

  // v1.9.16+: peer 消息以 [EOT] 结尾 → "本轮结束，不需要再回复"。
  // 解决 #agent-exchange 两边 bot 互相 ack 死循环的问题（每次 reply 会自动 @ 对方 bot，
  // 对方又 route 给 master 处理，master 又 reply... 无限）。
  // 约定：agent 想主动结束 thread 时在 reply 末尾写 `[EOT]`。收到端 bridge 识别到就
  // 直接不 forward 给本地 agent，Discord 里消息仍可见（带 [EOT] 尾巴做人类可读的标记）。
  if (isPeer && /\[EOT\]\s*$/i.test(content)) {
    console.log(`📪 收到 peer [EOT] 标记，不 forward 给 agent: from=${msg.author.tag} channel=${channelId}`);
    recordMetric("peer_thread_closed", { channelId, meta: { from: msg.author.id } });
    return;
  }

  // 新用户消息到达 → 如果 agent 还在忙（不 idle），先发 Ctrl+C 打断，让新消息覆盖旧任务
  // 注意：peer bot 来的消息不走这个打断（agent-to-agent 的交流不应该打断本地 agent 的工作）
  if (!isPeer) {
    try {
      const listResult = await runManager("list");
      const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
      const targetWindow = agent ? `master:${agent.name}` : `master:0`;
      const { isIdle } = await import("./lib/tmux-helper.js");
      if (!(await isIdle(targetWindow))) {
        console.log(`⚡ 新消息到达但 ${targetWindow} 还在忙，发 Ctrl+C 打断`);
        await tmuxRaw(["send-keys", "-t", targetWindow, "C-c"]).catch(() => {});
        await Bun.sleep(400);
      }
    } catch { /* non-critical */ }

    // v2.4.16+ 用户发消息 = 显式接管这个 channel 的对话方向。把该 channel 上挂着
    // 的所有 inter-agent / cross-peer pending 一并清掉，否则它们会在下一轮 Stop
    // hook 触发 drain兜底 / nudge / 跨 peer pushback，把用户刚说的 "停下来" 拽回
    // agent-to-agent 链里去。
    const cleared = clearInterAgentPendingsForChannel(channelId);
    if (cleared > 0) {
      console.log(`🧹 user 消息到达 → 清掉 ${cleared} 条 inter-agent pending (channel=${channelId})`);
    }
  }

  // 清理上一轮状态 + 重置 tool 追踪
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  const oldStatusId = activeStatusMessages.get(channelId);
  if (oldStatusId) {
    try {
      const ch = await discord.channels.fetch(channelId) as TextChannel;
      const sm = await ch.messages.fetch(oldStatusId);
      await sm.edit({ content: t("✅ 完成", "✅ Done"), components: [] });
    } catch { /* non-critical */ }
    activeStatusMessages.delete(channelId);
  }
  resetToolTracking(channelId);
  startTypingWithSafety(channelId);
  // 状态消息走 deliver(bridge → user)。discordReply 内部会 buildComponents +
  // trackSentMessage，返回的 id 拿来做"✅ 完成"编辑的目标。
  const statusDelivery = await deliver({
    from: { kind: "bridge", label: "status" },
    to: { kind: "user", userId: msg.author.id, channelId },
    intent: "notification",
    content: t("💭 大聪明思考中...", "💭 Thinking..."),
    meta: {
      messageId: `status_${channelId}_${Date.now()}`,
      triggerKind: "bridge_synth",
      ts: new Date().toISOString(),
      threadId: newThreadId(),
      components: [{
        type: "buttons",
        buttons: [{ id: `interrupt:${channelId}`, label: t("打断", "Interrupt"), emoji: "⚡", style: "danger" }],
      }],
    },
  });
  if (statusDelivery.outcome.kind === "sent" && statusDelivery.outcome.discordMessageIds?.[0]) {
    activeStatusMessages.set(channelId, statusDelivery.outcome.discordMessageIds[0]);
  }

  // 转发给 channel-server
  const meta: Record<string, string> = {
    chat_id: channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
  };
  if (attachmentPaths.length > 0) {
    meta.attachment_count = String(attachmentPaths.length);
    meta.attachments = attachmentPaths.join(";");
  }
  if (isPeer) {
    // 对接另一个 Claudestra 的 bot / 其他外部 bot。agent 需要知道"这是 peer"才能正确响应
    meta.peer = "true";
    meta.peer_bot_name = msg.author.username;
    meta.peer_bot_id = msg.author.id;
  }

  // v2.0.0 Phase 3b: #agent-exchange → master 的 header 注入搬进 renderContentForLocal，
  // 这里不再就地拼 content。direct 路由（peer → 指定 agent）的 PEER DIRECT header 还在
  // 下面 direct-route 分支里拼，phase 3b2 再搬进去。

  // 记录触发源：peer bot / 其他 bot 的消息视为 "agent"（下游 Stop 不发完成 @）；人类视为 "user"
  // 必须写给所有共享同一个 ws 的 channel：
  // 场景：peer 在 #agent-exchange 发消息，client.channelId=#agent-exchange，
  // 但 master 的 Stop hook 会带 CONTROL_CHANNEL_ID 来查，如果只在 #agent-exchange
  // 键上存 "agent"，Stop 一查 CONTROL 找不到就当 "user" 发 @。
  const triggerSource: "user" | "agent" = isPeer ? "agent" : "user";
  for (const [cid, info] of clients.entries()) {
    if (info.ws === client.ws) {
      lastMessageSource.set(cid, triggerSource);
    }
  }

  // v1.9.21+ direct mode peer routing：peer bot 在 #agent-exchange 发消息、
  // peers.json 里对这个 peer 有 mode=direct 的 exposure → 路由**直接到 agent
  // 的 ws**，bypass master。找不到 / 模糊 / via_master → 回落 master。
  const directRoute = isPeer
    ? await tryPeerDirectRoute(msg, channelId)
    : { kind: "fallback" as const };
  if (directRoute.kind === "button_pending") {
    // 按钮已发，此次不 forward —— 等用户点按钮
    return;
  }
  const routeWs = directRoute.kind === "direct" ? directRoute.toClient.ws : client.ws;
  const routeClientChannelId = directRoute.kind === "direct" ? directRoute.toClient.channelId : client.channelId;
  const routeAgentName = directRoute.kind === "direct" ? directRoute.agentName : undefined;
  const directRouted = directRoute.kind === "direct";

  // v2.0.0 Phase 3：统一走 deliver(envelope)。所有 header 注入（agent-exchange
  // 调度 / PEER DIRECT / no-exposures 拒绝）都在 renderContentForLocal 里做，
  // messageCreate 不再碰 content。只负责：
  //   - decide from / to（包括 direct route 时把 to 换成具体 agent、带 agentName）
  //   - 填原始 content（strip mention 后的纯文本）+ attachments
  //   - 交给 deliver
  const routeClient = clients.get(routeClientChannelId) ||
    (routeWs === client.ws ? client : undefined);
  const from: RouterUserEndpoint | RouterPeerEndpoint = isPeer
    ? {
        kind: "peer",
        peerBotId: msg.author.id,
        peerBotName: msg.author.username,
        sharedChannelId: channelId,
      }
    : { kind: "user", userId: msg.author.id, channelId, username: msg.author.username };
  const to: RouterLocalEndpoint = {
    kind: "local",
    agentName: routeAgentName,
    channelId: routeClient?.channelId ?? routeClientChannelId,
    ws: routeWs,
    cwd: routeClient?.cwd,
  };
  const env: RouterEnvelope = {
    from,
    to,
    intent: "request",
    content,
    meta: {
      messageId: msg.id,
      triggerKind: isPeer ? "peer_discord" : "user_discord",
      ts: msg.createdAt.toISOString(),
      threadId: newThreadId(),
      attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    },
  };
  try {
    const delivery = await deliver(env);
    if (delivery.outcome.kind === "sent") {
      // v2.0.13+: direct route 时记 pendingPeerInbound（local exchange 场景）。
      // Stop drain 兜底用 — agent 忘 reply() 时 forward 到 #agent-exchange。
      if (directRouted && isPeer && routeClient) {
        pendingPeerInbound.set(routeClient.channelId, {
          localAgentName: routeAgentName || "agent",
          sharedChannelId: channelId,
          peerBotId: msg.author.id,
          peerBotName: msg.author.username,
          isForeign: false,
          ts: Date.now(),
        });
      }
      recordMetric("message_in", { channelId, meta: { len: content.length, attachments: attachmentPaths.length, direct: directRouted } });
    } else if (delivery.outcome.kind === "dropped") {
      console.log(`📪 deliver dropped ${envelopeLabel(env)}: ${delivery.outcome.reason}`);
      recordMetric("message_dropped", { channelId, meta: { reason: delivery.outcome.reason } });
    } else {
      console.error(`deliver 失败 ${envelopeLabel(env)}:`, delivery.outcome.error);
      recordMetric("error", { channelId, meta: { phase: "deliver", err: String(delivery.outcome.error) } });
    }
  } catch (err) {
    console.error(`deliver 抛异常 channel=${channelId}:`, err);
    recordMetric("error", { channelId, meta: { phase: "deliver_throw", err: String(err) } });
  }

  // idle 检测由 JSONL watcher 的静默超时控制（不再用 tmux 轮询）
});

// ============================================================
// Peer 发现：bot 被邀请 / 别的 bot 加入
// ============================================================

// 工具：reply 到一个跟 peer bot 共享的频道时，自动在消息正文前加上对所有 peer bot 的 @，
// 保证对方 bridge 能识别"这条是给它的"。已经带上的 id 不重复加。
async function ensurePeerMentions(discord: Client, channelId: string, text: string): Promise<string> {
  try {
    const ch = await discord.channels.fetch(channelId).catch(() => null);
    if (!ch || !("guild" in ch) || !(ch as any).guild) return text;
    const guild = (ch as any).guild;
    const ownBotId = getBotUserId();
    // 列频道成员里的 peer bot。
    // v1.9.36+: members.fetch 有时在 bridge 刚启动、cache 冷时会卡几十秒/永远（Discord
    // 响应慢 / rate limit / gateway 还没 ready）。加 3s 超时兜底：fetch 超时就退化成
    // 用当前 cache，宁可少 @ 一两个 peer bot 也不能让整个 reply handler 卡死。
    const fetchWithTimeout = Promise.race([
      guild.members.fetch({ cache: true }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    const members = (await fetchWithTimeout) ?? guild.members.cache;
    if (!members) return text;
    const peerBots: string[] = [];
    for (const [, m] of members) {
      if (!m.user?.bot) continue;
      if (m.user.id === ownBotId) continue;
      // 只有对该频道有 View Channel 权限的 bot 才算真的在场
      const perms = (ch as any).permissionsFor?.(m);
      if (perms && !perms.has("ViewChannel")) continue;
      peerBots.push(m.user.id);
    }
    if (peerBots.length === 0) return text;
    const missing = peerBots.filter((id) => !text.includes(`<@${id}>`) && !text.includes(`<@!${id}>`));
    if (missing.length === 0) return text;
    const prefix = missing.map((id) => `<@${id}>`).join(" ");
    return `${prefix} ${text}`;
  } catch {
    return text;
  }
}

// 工具：往 master 控制频道发一条通知（系统广播，bridge → user 信道）
async function notifyMaster(content: string): Promise<void> {
  const controlChannelId = process.env.CONTROL_CHANNEL_ID || "";
  if (!controlChannelId) return;
  try {
    await deliver({
      from: { kind: "bridge", label: "notifyMaster" },
      to: {
        kind: "user",
        userId: ALLOWED_USER_IDS[0] || "",
        channelId: controlChannelId,
      },
      intent: "notification",
      content,
      meta: {
        messageId: `notify_${Date.now()}`,
        triggerKind: "bridge_synth",
        ts: new Date().toISOString(),
        threadId: newThreadId(),
      },
    });
  } catch { /* non-critical */ }
}

// 我方 bot 被邀请加入新 guild
discord.on("guildCreate", async (guild) => {
  console.log(`🎉 我方 bot 被加到新 guild: ${guild.name} (${guild.id})`);
  await notifyMaster(
    [
      `🎉 **跨 Claudestra 协作：你的 bot 被邀请到新服务器**`,
      ``,
      `服务器：**${guild.name}**（id: \`${guild.id}\`，${guild.memberCount} 成员）`,
      ``,
      `接下来可以：`,
      `• 调 \`list_shared_channels\` MCP 工具，看这个 guild 里哪些频道你能进。`,
      `• 按频道名字 / topic 判断用途；需要时 reply 到对应 chat_id @ 对方 bot 发起对话。`,
      `• 你也可以先不动；等对方 agent 主动 @ 我们。`,
    ].join("\n")
  );
});

// 我方 bot 在外部 guild 拿到新频道访问权限（对方给我们 allow View Channel）
discord.on("channelCreate", async (channel) => {
  // 只通知外部 guild（peer 邀请我们进去的那些），自己 guild 里建频道是我们自己在创建 agent 不通知
  if (!("guild" in channel) || !channel.guild) return;
  if (channel.guild.id === DISCORD_GUILD_ID) return;
  const textCh = channel as TextChannel;
  if (typeof textCh.isTextBased !== "function" || !textCh.isTextBased()) return;
  // v2.4.8+: 只通知有 bot-specific allow ViewChannel overwrite 的新频道。
  // 否则对方 guild 里随便建个 #news / #us-stock 频道我们 bot 默认 inherit
  // @everyone 的 ViewChannel 也能看到 → 误报"对方主动给我们权限"。Claudestra
  // peer 用 discordCreateChannel 主动 share 时会显式 allow ViewChannel for our
  // bot id，这种才算真 grant。
  const me = textCh.guild.members.me;
  const myOverwrite = me ? textCh.permissionOverwrites.cache.get(me.id) : null;
  const explicitGrant = !!myOverwrite?.allow.has("ViewChannel");
  if (!explicitGrant) {
    console.log(`👀 外部 guild 新频道（无 bot-specific allow，忽略）: #${textCh.name} in ${textCh.guild?.name}`);
    return;
  }
  console.log(`🎉 外部 guild 新频道访问: #${textCh.name} in ${textCh.guild?.name}`);
  await notifyMaster(
    [
      `🎉 **你 bot 在对方 Claudestra 服务器拿到新频道访问**`,
      ``,
      `频道：**#${textCh.name}**（id: \`${textCh.id}\`，topic: ${textCh.topic || "(无)"}）`,
      `服务器：${textCh.guild?.name ?? "(未知)"}`,
      ``,
      `你可以在这个频道 @ 对方 bot 发起对话：\`reply(chat_id="${textCh.id}", text="<@对方bot_id> ...")\``,
      `或者先调 \`list_shared_channels\` 看一下你当前的全部外部频道列表。`,
    ].join("\n")
  );
});

// 我方 bot 在外部 guild 失去频道访问（频道被删了）
discord.on("channelDelete", async (channel) => {
  if (!("guild" in channel) || !channel.guild) return;
  if (channel.guild.id === DISCORD_GUILD_ID) return;
  const textCh = channel as TextChannel;
  if (typeof textCh.isTextBased !== "function" || !textCh.isTextBased()) return;
  console.log(`💨 外部 guild 频道被删: #${textCh.name} in ${textCh.guild?.name}`);
  await notifyMaster(
    [
      `💨 **${textCh.guild?.name ?? "外部 guild"} 里 #${textCh.name} 被删了**`,
    ].join("\n")
  );
});

// 已有频道权限变化：比如对方 grant 或 revoke 我们的 View Channel
discord.on("channelUpdate", async (oldCh: any, newCh: any) => {
  if (!newCh.guild || newCh.guild.id === DISCORD_GUILD_ID) return;
  if (typeof newCh.isTextBased !== "function" || !newCh.isTextBased()) return;
  const me = newCh.guild.members.me;
  if (!me) return;
  try {
    // v2.4.8+: 用 bot-specific overwrite 是否 explicit allow ViewChannel 来判定，
    // 不再用 effective permissionsFor —— 后者把对方 guild 改 @everyone 全员权限
    // 也算成"对方 grant 我们 bot"，误报。
    const oldOw = oldCh.permissionOverwrites?.cache?.get(me.id);
    const newOw = newCh.permissionOverwrites?.cache?.get(me.id);
    const oldCanView = !!oldOw?.allow?.has?.("ViewChannel");
    const newCanView = !!newOw?.allow?.has?.("ViewChannel");
    if (!oldCanView && newCanView) {
      console.log(`🎉 外部 guild 新获授权: #${newCh.name} in ${newCh.guild.name}`);
      await notifyMaster(
        [
          `🎉 **你 bot 在对方 Claudestra 服务器拿到新频道访问**`,
          ``,
          `频道：**#${newCh.name}**（id: \`${newCh.id}\`，topic: ${newCh.topic || "(无)"}）`,
          `服务器：${newCh.guild.name}`,
          ``,
          `你可以在这个频道 @ 对方 bot 发起对话：\`reply(chat_id="${newCh.id}", text="<@对方bot_id> ...")\``,
          `或者先调 \`list_shared_channels\` 看一下你当前的全部外部频道列表。`,
        ].join("\n")
      );
    } else if (oldCanView && !newCanView) {
      console.log(`💨 外部 guild 失去授权: #${newCh.name} in ${newCh.guild.name}`);
      await notifyMaster(
        [
          `💨 **你 bot 在 ${newCh.guild.name} 的 #${newCh.name} 被收回了 View Channel 权限**`,
        ].join("\n")
      );
    }
  } catch (e) {
    console.error("channelUpdate 处理失败:", e);
  }
});

// 别的 bot（不是我方）加入了我的 guild
discord.on("guildMemberAdd", async (member) => {
  if (!member.user?.bot) return;
  if (member.user.id === getBotUserId()) return; // 自己
  if (member.guild.id !== DISCORD_GUILD_ID) return; // 不是我方主 guild 不处理
  console.log(`🎉 Peer bot 加入: ${member.user.tag} (${member.user.id}) in ${member.guild.name}`);

  // v1.9.0+: 新流程
  // 1. 等 Discord 把 peer bot 的 managed role 同步完
  await Bun.sleep(1500);
  // 2. 确保 #agent-exchange 频道存在（第一次 peer 加入会自动建）
  const exchange = await ensureAgentExchangeChannel(member.guild);
  // 3. 对这个 peer bot：deny 所有频道 view，但 allow #agent-exchange
  const scope = await scopePeerToAgentExchange(member, exchange);
  // 4. 记到 peers.json
  const peersLib = await import("./lib/peers.js");
  await peersLib.upsertPeerBot({
    id: member.id,
    name: member.user.tag,
    guildId: member.guild.id,
    agentExchangeId: exchange?.id,
    firstSeen: new Date().toISOString(),
  });
  // 5. master 如果已经连着，把 #agent-exchange 挂到 master ws 上（让 master 收这里的消息）
  if (exchange) {
    const controlId = process.env.CONTROL_CHANNEL_ID || "";
    const master = clients.get(controlId);
    if (master) {
      clients.set(exchange.id, { ws: master.ws, channelId: exchange.id, userId: master.userId });
      console.log(`📌 #agent-exchange (${exchange.id}) 挂到 master ws`);
    }
  }

  const scopeNote = !exchange
    ? `⚠️ 没能在你 guild 里建或找到 #agent-exchange 频道（权限不足？），peer 通信无处可去`
    : scope.ok
      ? `✅ peer bot 现在只能看到 **#${exchange.name}**（id: \`${exchange.id}\`）一个频道，其他全部 deny`
      : `⚠️ Scope 部分失败: ${scope.reason}. peer bot 可能还能看到一些其他频道，手工 deny 下。`;

  await notifyMaster(
    [
      `🎉 **跨 Claudestra 协作：对方 Claudestra 的 bot 刚刚加入你的服务器**`,
      ``,
      `Peer bot：**${member.user.tag}**（id: \`${member.id}\`）`,
      `服务器：${member.guild.name}`,
      ``,
      scopeNote,
      ``,
      `目前**没有任何本地 agent** 对这个 peer 开放。要开放，跑：`,
      `  \`bun src/manager.ts peer-expose <agent-name> ${member.user.username} --purpose "..."\``,
      `  或开放给所有 peer：\`bun src/manager.ts peer-expose <agent-name> all --purpose "..."\``,
    ].join("\n")
  );
});

/**
 * 确保 guild 里有一个 #agent-exchange 频道。
 * 优先用 peers.json 里记录的 id；没有或找不到就新建一个。
 */
async function ensureAgentExchangeChannel(guild: any): Promise<TextChannel | null> {
  const { readPeers, setLocalAgentExchangeId } = await import("./lib/peers.js");
  const peers = await readPeers();
  const EXCHANGE_NAME = process.env.PEER_EXCHANGE_CHANNEL_NAME || "agent-exchange";

  // 1. peers.json 里已有记录 → 确认频道还在
  if (peers.localAgentExchangeId) {
    try {
      const ch = await guild.channels.fetch(peers.localAgentExchangeId).catch(() => null);
      if (ch) return ch as TextChannel;
    } catch { /* fall through to create */ }
  }

  // 2. 搜 guild 看有没有同名频道
  const existing = guild.channels.cache.find(
    (c: any) => c.type === 0 && c.name === EXCHANGE_NAME
  );
  if (existing) {
    await setLocalAgentExchangeId(existing.id);
    return existing as TextChannel;
  }

  // 3. 建新频道
  try {
    const me = guild.members.me;
    if (!me?.permissions?.has("ManageChannels")) {
      console.error(`⚠️ 我方 bot 缺 Manage Channels 权限，建不了 #${EXCHANGE_NAME}`);
      return null;
    }
    const ch = await guild.channels.create({
      name: EXCHANGE_NAME,
      type: 0,
      topic: "跨 Claudestra agent 交流专用频道。所有 peer bot 被自动限制只能看到这里。",
    });
    await setLocalAgentExchangeId(ch.id);
    console.log(`✨ 建了 #${EXCHANGE_NAME} (${ch.id})`);
    return ch as TextChannel;
  } catch (e) {
    console.error(`⚠️ 建 #${EXCHANGE_NAME} 失败:`, e);
    return null;
  }
}

/**
 * 把 peer bot scope 到 #agent-exchange：所有其他文字频道 deny View，agent-exchange allow View/Send/ReadHistory。
 */
async function scopePeerToAgentExchange(
  member: any,
  exchange: TextChannel | null
): Promise<{ ok: boolean; modified: number; total: number; reason?: string }> {
  try {
    const guild = member.guild;
    if (!guild) return { ok: false, modified: 0, total: 0, reason: "没有 guild 上下文" };

    let peerBotRole = guild.roles.cache.find(
      (r: any) => r.managed && r.tags?.botId === member.id
    );
    if (!peerBotRole) {
      try { await guild.roles.fetch(); } catch { /* non-critical */ }
      peerBotRole = guild.roles.cache.find(
        (r: any) => r.managed && r.tags?.botId === member.id
      );
    }
    if (!peerBotRole) {
      return { ok: false, modified: 0, total: 0, reason: "找不到 peer bot 的 managed role" };
    }

    const me = guild.members.me;
    if (!me?.permissions?.has("ManageRoles") || !me.permissions.has("ManageChannels")) {
      return { ok: false, modified: 0, total: 0, reason: "我方 bot 缺 Manage Roles / Manage Channels 权限" };
    }

    const channels = guild.channels.cache.filter((c: any) =>
      c.type === 0 || c.type === 4 || c.type === 5
    );
    let modified = 0;
    for (const [, ch] of channels) {
      try {
        if (exchange && ch.id === exchange.id) {
          // agent-exchange：allow View + Send + ReadHistory
          await (ch as any).permissionOverwrites.edit(peerBotRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });
        } else {
          // 其他频道：deny View
          await (ch as any).permissionOverwrites.edit(peerBotRole, { ViewChannel: false });
        }
        modified++;
      } catch {
        // 个别失败不阻塞
      }
    }
    return { ok: true, modified, total: channels.size };
  } catch (e) {
    return { ok: false, modified: 0, total: 0, reason: (e as Error).message };
  }
}

// ============================================================
// Interaction 处理（按钮、菜单、Slash Commands）
// ============================================================

discord.on("interactionCreate", async (interaction: Interaction) => {
  try {
    const channelId = interaction.channelId;
    console.log(`🎯 Interaction: type=${interaction.type} channel=${channelId} user=${interaction.user?.id}`);
    if (!channelId) return;

    if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(interaction.user.id)) {
      console.log(`🚫 用户 ${interaction.user.id} 不在 ALLOWED_USER_IDS 中`);
      return;
    }

    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      console.log(`⚡ Slash command: /${cmd} in ${channelId}`);
      recordMetric("slash_invoked", { channelId, meta: { cmd } });

      if (cmd === "screenshot") {
        try {
          await interaction.deferReply();
        } catch (e) {
          console.error("📸 deferReply 失败:", e);
          return;
        }
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          const windowName = agent ? agent.name : "master";
          console.log(`📸 截图: window=${windowName} channel=${channelId}`);
          const pngPath = await tmuxScreenshot(windowName);
          if (pngPath) {
            await interaction.editReply({ content: "**📸 终端截图**", files: [{ attachment: pngPath }] });
          } else {
            console.error("📸 tmuxScreenshot 返回 null");
            await interaction.editReply("❌ 截图失败：PNG 生成失败");
          }
        } catch (e) {
          console.error("📸 截图流程失败:", e);
          try { await interaction.editReply(`❌ 截图失败: ${(e as Error).message}`); } catch {}
        }
        return;
      }

      if (cmd === "interrupt") {
        const listResult = await runManager("list");
        const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
        if (agent) {
          Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, "C-c"]);
          stopTyping(channelId);
          clearSafetyTimer(channelId);
          const statusMsgId = activeStatusMessages.get(channelId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(channelId) as TextChannel;
              const sm = await ch.messages.fetch(statusMsgId);
              await sm.edit({ content: t("⚡ 已打断", "⚡ Interrupted"), components: [] });
            } catch { /* non-critical */ }
            activeStatusMessages.delete(channelId);
          }
          await interaction.reply("⚡ 已发送 Ctrl+C");
        } else {
          await interaction.reply("⚠️ 当前频道没有关联的 agent");
        }
        return;
      }

      if (cmd === "status") {
        await interaction.deferReply();
        const panel = await buildStatusPanel();
        const components = panel.components ? buildComponents(panel.components) : undefined;
        await interaction.editReply({ content: panel.text, components });
        return;
      }

      if (cmd === "cron") {
        await interaction.deferReply();
        const cronPanel = await handleMgmtButton("show_cron_menu", channelId);
        if (cronPanel) {
          const components = cronPanel.components ? buildComponents(cronPanel.components) : undefined;
          await interaction.editReply({ content: cronPanel.text, components });
        } else {
          await interaction.editReply("❌ 无法获取定时任务信息");
        }
        return;
      }

      // ── 转发给 Claude Code 的 slash（built-in / skill） ──
      {
        // 立即 defer，防止 3s Discord token 过期（lookup 可能耗时）
        await interaction.deferReply().catch(() => {});

        // 找 channel 对应的 agent
        let agentName: string | null = null;
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) agentName = agent.name;
        } catch { /* non-critical */ }

        // 如果没找到 agent，就是 master channel（control channel）
        const targetWindow = agentName ? `master:${agentName}` : `master:0`;
        const targetLabel = agentName || "master";

        // 收集 option 值
        const vals: Record<string, string> = {};
        for (const opt of interaction.options.data) {
          if (typeof opt.value === "string") vals[opt.name] = opt.value;
        }

        // 先检查是不是其他 agent 的 project skill
        const otherOwner = isProjectSkillForOtherAgent(cmd, agentName);
        if (otherOwner) {
          await interaction.editReply({
            content: `⚠️ \`/${cmd}\` 是 **${otherOwner}** 的项目级 skill，在当前频道（${targetLabel}）不可用。切到 ${otherOwner} 的频道再试。`,
          }).catch(() => {});
          return;
        }

        const resolved = resolveInvocation(cmd, agentName, vals);
        if (!resolved.ok) {
          await interaction.editReply({ content: `⚠️ ${resolved.reason}` }).catch(() => {});
          return;
        }

        console.log(`⚡ 转发 slash: /${cmd} → window=${targetWindow} text="${resolved.ccText}"`);
        try {
          await tmuxSendLine(targetWindow, resolved.ccText);
          // TUI 渲染需要几秒，截图作为反馈（否则像 /context 这类纯 TUI 命令 Discord 端完全没响应）
          await Bun.sleep(2500);
          await presentSlashResult(interaction, targetWindow, targetLabel, resolved.ccText);
        } catch (e) {
          console.error(`⚡ tmux 发送失败:`, e);
          await interaction.editReply({
            content: `❌ 发送失败：${(e as Error).message}`,
          }).catch(() => {});
        }
        return;
      }
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      await interaction.deferUpdate().catch(async () => {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      });

      // TUI modal 选项按钮 — 把键转发给 tmux，再截图 + 可能再出菜单
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        const idx = rest.lastIndexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const key = rest.slice(idx + 1);
        await handleModalInteraction(interaction, targetWindow, key);
        return;
      }

      // 升级到大总管处理 — 把当前 agent 状态 + 截图 post 到 control 频道，master 自己 LLM 处理
      if (id.startsWith("escalate:")) {
        const rest = id.slice("escalate:".length);
        const idx = rest.indexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const ccText = decodeURIComponent(rest.slice(idx + 1));
        const agentName = targetWindow.replace(/^master:/, "");
        const controlChannelId = process.env.CONTROL_CHANNEL_ID || "";
        if (!controlChannelId) {
          await interaction.followUp({ content: "❌ 未配置 CONTROL_CHANNEL_ID，无法升级", ephemeral: true }).catch(() => {});
          return;
        }
        try {
          const pngPath = await tmuxScreenshot(agentName);
          const ctrlCh = (await discord.channels.fetch(controlChannelId)) as TextChannel;
          const msg = [
            `🤖 **需要你帮忙：** agent **${agentName}** 上的 \`${ccText}\` 的 TUI bridge 认不出，user 升级给你处理。`,
            ``,
            `你可以用这些 Bash 子命令控制这个 agent 的 tmux window：`,
            `- \`bun ../src/manager.ts tmux-screenshot ${agentName}\` — 截图（返回 PNG 路径，可用 Read 工具看）`,
            `- \`bun ../src/manager.ts tmux-capture ${agentName} [lines]\` — 读文本 pane`,
            `- \`bun ../src/manager.ts tmux-send-keys ${agentName} <keys...>\` — 发键（Enter/Escape/Left/Right/C-c/数字/字符串）`,
            `- \`bun ../src/manager.ts tmux-wait-idle ${agentName} [ms]\` — 等回到 idle`,
            ``,
            `请先截图看看现在 pane 什么状态，再决定怎么操作 + 用 reply 告诉原频道结果。原频道 channel_id=\`${interaction.channelId}\`。`,
          ].join("\n");
          await ctrlCh.send({
            content: msg,
            files: pngPath ? [{ attachment: pngPath }] : undefined,
          });
          await interaction.followUp({ content: `🤖 已升级到大总管（#control 频道），他会接手`, ephemeral: true }).catch(() => {});
          recordMetric("modal_button", { channelId: interaction.channelId, agent: agentName, meta: { action: "escalate", ccText } });
        } catch (e) {
          await interaction.followUp({ content: `❌ 升级失败：${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // Wedge Esc 救回按钮
      if (id.startsWith("wedge_esc:")) {
        const agentName = id.slice("wedge_esc:".length);
        try {
          await tmuxRaw(["send-keys", "-t", `master:${agentName}`, "Escape"]);
          clearWedgeState(agentName);
          await interaction.followUp({ content: `✅ 已发 Esc 到 ${agentName}`, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 发 Esc 失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.0.23+: agent 掉线（claude 退到 shell）的重启按钮
      if (id.startsWith("wedge_restart:")) {
        const agentName = id.slice("wedge_restart:".length);
        try {
          await interaction.followUp({ content: `🔄 正在重启 ${agentName}...`, ephemeral: true }).catch(() => {});
          const result = await runManager("restart", agentName);
          clearWedgeState(agentName);
          const ok = result?.ok;
          await interaction.followUp({
            content: ok ? `✅ ${agentName} 已重启` : `❌ 重启失败: ${result?.error || result?.message || "未知错误"}`,
            ephemeral: true,
          }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 重启失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.2.0+: auto 拦截「临时放行并重试」—— Shift+Tab 运行时切到 bypass + 注入重试
      if (id.startsWith("auto_allow:") || id.startsWith("auto_revert:")) {
        const isAllow = id.startsWith("auto_allow:");
        const targetChannelId = id.slice((isAllow ? "auto_allow:" : "auto_revert:").length);
        const target = isAllow ? "bypassPermissions" : "auto";
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }
          const win = `master:${agent.name}`;
          const pane = await tmuxCapture(windowTarget(agent.name), 12);
          const cur = detectPermissionMode(pane);
          if (!cur) {
            await interaction.followUp({ content: "❌ 认不出当前权限模式，请手动 shift+tab 切", ephemeral: true }).catch(() => {});
            return;
          }
          const steps = btabStepsTo(cur, target);
          if (steps < 0) {
            await interaction.followUp({
              content: `❌ 切不到 ${target}（这个 agent 启动没带 allow-flag？需 restart 一次更新）`,
              ephemeral: true,
            }).catch(() => {});
            return;
          }
          // 发 steps 下 Shift+Tab（tmux 里是 BTab）
          for (let i = 0; i < steps; i++) {
            await tmuxRaw(["send-keys", "-t", win, "BTab"]);
            await Bun.sleep(150);
          }
          await Bun.sleep(300);
          const after = detectPermissionMode(await tmuxCapture(windowTarget(agent.name), 12));
          console.log(`⚡ auto_${isAllow ? "allow" : "revert"}: ${agent.name} ${cur}→${after} (${steps} BTab)`);

          if (isAllow) {
            // 切到 bypass 后，注入「重试」让 agent 重做被拦的操作
            const client = clients.get(targetChannelId);
            if (client) {
              startTypingWithSafety(targetChannelId);
              client.ws.send(JSON.stringify({
                type: "message",
                content: `[系统] 刚才被 auto 模式拦下的操作，用户已临时放行（已切到 bypass permissions）。请重试那个操作。完成后简单说一句，方便用户把你切回 auto。`,
                meta: { chat_id: targetChannelId, message_id: "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
              }));
            }
            const note = after === "bypassPermissions" ? "已临时切到 bypass 并让它重试" : `尝试切 bypass（当前检测=${after || "?"}）并让它重试`;
            await interaction.message?.edit({
              content: `⚡ ${agent.name}：${note}。完事点下面切回 auto。`,
              components: buildComponents([
                { type: "buttons", buttons: [{ id: `auto_revert:${targetChannelId}`, label: "切回 auto", emoji: "🔒", style: "secondary" }] },
              ]),
            }).catch(() => {});
          } else {
            await interaction.message?.edit({
              content: after === "auto" ? `🔒 ${agent.name} 已切回 auto。` : `🔒 ${agent.name} 切回 auto（当前检测=${after || "?"}）。`,
              components: [],
            }).catch(() => {});
          }
        } catch (e) {
          await interaction.followUp({ content: `❌ 操作失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.4.19+ 跳到 iTerm tab 按钮（LLM-free）。
      // tmux select-window 只改 tmux 内部的 active window —— iTerm CC 模式下
      // 每个 tmux window 是一个原生 tab，tab 焦点归 iTerm 管，得用 AppleScript
      // 按 session 名（CC 模式显示为 "✳ <短名> (node)"）找到 tab 并 select。
      // 只对 bridge 所在的这台 Mac 有效 —— 手机上点也行，Mac 那头会切好等你回来。
      if (id.startsWith("focus:")) {
        const targetChannelId = id.slice("focus:".length);
        try {
          const controlId = process.env.CONTROL_CHANNEL_ID || "";
          let targetWindow: string;
          let label: string;
          let tabNeedle: string; // iTerm session 名匹配串
          if (targetChannelId === controlId) {
            targetWindow = `${MASTER_SESSION}:0`;
            label = "master";
            tabNeedle = " Claude Code ("; // master 的 CC tab 名
          } else {
            const listResult = await runManager("list");
            const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
            if (!agent) {
              await interaction.followUp({ content: "❌ 找不到对应 agent（可能已被 kill）", ephemeral: true }).catch(() => {});
              return;
            }
            targetWindow = `${MASTER_SESSION}:${agent.name}`;
            label = agent.name;
            // tab 名用 agent 短名（去 "agent-" 前缀），两侧界定符防前缀嵌套误匹配
            const short = String(agent.name).replace(/^agent-/, "");
            tabNeedle = ` ${short} (`;
          }
          // tmux 内部状态也同步一下（非 CC attach 的裸 tmux 场景仍有用）
          await tmuxRaw(["select-window", "-t", targetWindow]).catch(() => {});
          // AppleScript：遍历 iTerm windows/tabs/sessions 按名选 tab + 前置
          const esc = tabNeedle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const script = [
            'tell application "iTerm2"',
            '  repeat with w in windows',
            '    repeat with t in tabs of w',
            '      repeat with s in sessions of t',
            `        if name of s contains "${esc}" then`,
            '          select w',
            '          select t',
            '          activate',
            '          return "found"',
            '        end if',
            '      end repeat',
            '    end repeat',
            '  end repeat',
            '  activate',
            '  return "notfound"',
            'end tell',
          ].join("\n");
          const osa = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
          const found = (await new Response(osa.stdout).text()).trim();
          await osa.exited;
          console.log(`🖥 focus 按钮: ${targetWindow} → iTerm tab ${found === "found" ? "已选中" : "没找到（仅前置 iTerm）"}`);
          const note = found === "found"
            ? `🖥 已跳到 **${label}** 的 iTerm tab`
            : `🖥 iTerm 已前置，但没找到 **${label}** 的 tab（iTerm 没 -CC attach？tmux 内部已切过去）`;
          await interaction.followUp({ content: note, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 切换失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 打断按钮
      if (id.startsWith("interrupt:")) {
        const targetChannelId = id.slice("interrupt:".length);
        console.log(`⚡ 打断按钮点击: channel=${targetChannelId}`);
        try {
          // master (CONTROL_CHANNEL_ID) 和 #agent-exchange 都 route 到 master:0，
          // 但它们不在 registry.json 里 —— 直接认定目标是 master:0，不用查 registry
          const controlId = process.env.CONTROL_CHANNEL_ID || "";
          const { readPeers } = await import("./lib/peers.js");
          const peers = await readPeers().catch(() => ({ localAgentExchangeId: "" } as any));
          const exchangeId = (peers as any).localAgentExchangeId || "";
          const isMasterChannel =
            targetChannelId === controlId ||
            (exchangeId && targetChannelId === exchangeId);

          let targetWindow: string;
          let agentLabel: string;
          if (isMasterChannel) {
            targetWindow = `${MASTER_SESSION}:0`;
            agentLabel = "master";
          } else {
            const listResult = await runManager("list");
            const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
            if (!agent) {
              console.error(`⚡ 打断失败：channel=${targetChannelId} 找不到对应 agent`);
              await interaction.followUp({ content: "❌ 打断失败：找不到对应 agent", ephemeral: true }).catch(() => {});
              return;
            }
            targetWindow = `master:${agent.name}`;
            agentLabel = agent.name;
          }

          console.log(`⚡ 发送 C-c 到 tmux window: ${targetWindow}`);
          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", targetWindow, "C-c"],
            { stdout: "pipe", stderr: "pipe" }
          );
          const stderr = await new Response(proc.stderr).text();
          await proc.exited;
          if (proc.exitCode !== 0) {
            console.error(`⚡ tmux send-keys 失败 (exit=${proc.exitCode}): ${stderr}`);
            await interaction.followUp({ content: `❌ tmux 发送 C-c 失败: ${stderr}`, ephemeral: true }).catch(() => {});
            return;
          }
          console.log(`⚡ C-c 已发送给 ${agentLabel}`);
          recordMetric("agent_interrupt", { channelId: targetChannelId, agent: agentLabel, meta: { trigger: "button" } });

          const statusMsgId = activeStatusMessages.get(targetChannelId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
              const sm = await ch.messages.fetch(statusMsgId);
              await sm.edit({ content: t("⚡ 已打断", "⚡ Interrupted"), components: [] });
            } catch { /* non-critical */ }
            activeStatusMessages.delete(targetChannelId);
          }
          stopTyping(targetChannelId);
          clearSafetyTimer(targetChannelId);
        } catch (e) {
          console.error(`⚡ 打断流程异常:`, e);
        }
        return;
      }

      // 权限弹窗 + session-idle 弹窗响应按钮
      const promptBtnPrefixes = [
        "perm_allow:", "perm_allow_session:", "perm_deny:",
        "session_summary:", "session_full:", "session_noask:",
      ];
      if (promptBtnPrefixes.some((p) => id.startsWith(p))) {
        const [action, targetChannelId] = id.split(":");
        // 按钮对应的 Claude Code 按键**序列**。
        // v2.0.22+: session-idle modal 不接受 digit 跳转（按 "2" 不会跳到 option 2，
        // Enter 还是确认高亮的 option 1 = 从摘要恢复 = compact）。改用 arrow nav：
        // 光标默认在 option 1，Down 一次到 2，两次到 3。perm 弹窗保留 digit（实测可用）。
        const keySeqMap: Record<string, string[]> = {
          perm_allow: ["1", "Enter"],
          perm_allow_session: ["2", "Enter"],
          perm_deny: ["3", "Enter"],
          session_summary: ["Enter"],              // option 1（高亮默认）
          session_full: ["Down", "Enter"],         // ↓ 到 option 2
          session_noask: ["Down", "Down", "Enter"],// ↓↓ 到 option 3
        };
        const labelMap: Record<string, string> = {
          perm_allow: "✅ 已允许",
          perm_allow_session: "✅ 已允许（本会话不再问）",
          perm_deny: "❌ 已拒绝",
          session_summary: "✨ 从摘要恢复",
          session_full: "📜 恢复完整会话",
          session_noask: "🔕 不再询问",
        };
        const keySeq = keySeqMap[action] || ["Enter"];
        const isPermBtn = action.startsWith("perm_");
        const isIdleBtn = action.startsWith("session_");
        console.log(`🔔 弹窗响应: channel=${targetChannelId} action=${action} keys=${keySeq.join(" ")}`);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }

          // 发键前再确认弹窗还在，避免把 digit+Enter 当成普通消息提交给 Claude
          const pane = await tmuxCapture(windowTarget(agent.name), 30);
          const hasPerm = detectRuntimePermissionPrompt(pane) !== null;
          const hasIdle = detectSessionIdlePrompt(pane) !== null;
          const dialogStillActive = (isPermBtn && hasPerm) || (isIdleBtn && hasIdle);

          if (!dialogStillActive) {
            console.log(`🔔 弹窗已关闭，跳过发键: channel=${targetChannelId} hasPerm=${hasPerm} hasIdle=${hasIdle}`);
            const msgId = permissionMessages.get(targetChannelId);
            if (msgId) {
              try {
                const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
                const sm = await ch.messages.fetch(msgId);
                await sm.edit({ content: `🔕 弹窗已自动关闭，无需操作`, components: [] });
              } catch { /* non-critical */ }
              clearPermissionMessage(targetChannelId);
            }
            return;
          }

          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, ...keySeq],
            { stdout: "pipe", stderr: "pipe" }
          );
          await proc.exited;
          if (proc.exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            console.error(`🔔 tmux send-keys 失败: ${stderr}`);
          }

          // 编辑原消息显示已处理（保留指纹让下次 poll 自然清理，避免竞争条件）
          const msgId = permissionMessages.get(targetChannelId);
          if (msgId) {
            try {
              const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
              const sm = await ch.messages.fetch(msgId);
              await sm.edit({ content: `🔔 ${labelMap[action]}`, components: [] });
            } catch { /* non-critical */ }
            permissionMessages.delete(targetChannelId);
          }
        } catch (e) {
          console.error(`🔔 权限响应流程异常:`, e);
        }
        return;
      }

      // v1.9.26+: peer direct 消歧义按钮
      if (id.startsWith("peer_select;")) {
        try {
          await interaction.deferUpdate().catch(() => {});
          // format: peer_select;<local|foreign>;<agentName>;<origChannelId>;<origMsgId>
          // 用 ; 不用 : 因为 agent 名字里允许 : —— NAME_BLOCKLIST_RE 有 ; 没 :
          const [, kind, agentName, origChannelId, origMsgId] = id.split(";");
          if (agentName === "__cancel__") {
            await interaction.editReply({
              content: `🚫 已取消。原请求没有路由到任何 agent。想重新请，@ bot 再发一次（可以带 agent 名字走快路径）。`,
              components: [],
            }).catch(() => {});
            return;
          }
          // fetch original msg
          const origCh = await discord.channels.fetch(origChannelId).catch(() => null);
          if (!origCh || !("messages" in origCh)) {
            await interaction.editReply({ content: `⚠️ 原频道已不可访问，取消`, components: [] }).catch(() => {});
            return;
          }
          const origMsg = await (origCh as TextChannel).messages.fetch(origMsgId).catch(() => null);
          if (!origMsg) {
            await interaction.editReply({ content: `⚠️ 原消息已删除或找不到`, components: [] }).catch(() => {});
            return;
          }
          const routed = await routePeerDirectWithAgent(origMsg, origChannelId, agentName, kind as "local" | "foreign");
          if (routed) {
            await interaction.editReply({
              content: `🎯 已路由到 **${agentName}** 处理，稍等 agent 回复。`,
              components: [],
            }).catch(() => {});
            recordMetric("peer_disambig_click", { channelId: origChannelId, meta: { agent: agentName, kind } });
          } else {
            await interaction.editReply({
              content: `⚠️ 路由失败（agent **${agentName}** 可能不在线或 exposure 已变）`,
              components: [],
            }).catch(() => {});
          }
        } catch (e) {
          console.error("peer_select 处理异常:", e);
        }
        return;
      }

      // v2.0.19+: AskUserQuestion 的 Submit / Cancel 按钮
      if (id.startsWith("auq:")) {
        try {
          const { auqStates, buildAuqKeystrokes, clearAuqState } =
            await import("./bridge/ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const action = parts[2];
          const state = auqStates.get(auqChannel);
          if (!state) {
            await interaction.editReply({ content: `⚠️ AskUserQuestion 状态已过期，请等 agent 重新发起。`, components: [] }).catch(() => {});
            return;
          }
          if (action === "submit") {
            const keys = buildAuqKeystrokes(state);
            // 一次 tmux send-keys 批量发，tmux 内部按顺序处理键序列；比一键一调用快得多
            if (keys.length > 0) {
              await tmuxRaw(["send-keys", "-t", state.tmuxTarget, ...keys]);
            }
            const summary = state.selections.map((sel, i) => {
              if (sel.length === 0) return `Q${i + 1}: (none)`;
              const labels = sel.map((oi) => state.questions[i].options[oi]?.label || `?${oi}`).join(", ");
              return `Q${i + 1}: ${labels}`;
            }).join("\n");
            await interaction.editReply({
              content: `✅ 已提交 AskUserQuestion 选择：\n${summary}`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_submit", { channelId: auqChannel, meta: { questions: String(state.questions.length) } });
            clearAuqState(auqChannel);
          } else if (action === "cancel") {
            await tmuxRaw(["send-keys", "-t", state.tmuxTarget, "Escape"]);
            await interaction.editReply({
              content: `❌ 已取消 AskUserQuestion（发了 Esc 给 agent）`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_cancel", { channelId: auqChannel });
            clearAuqState(auqChannel);
          }
        } catch (e) {
          console.error("AUQ button 处理异常:", e);
        }
        return;
      }

      // 管理按钮
      const mgmtResult = await handleMgmtButton(id, channelId, interaction.message?.id, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          // 走 deliver(bridge → user)：discordReply 内部 buildComponents。
          await deliver({
            from: { kind: "bridge", label: "mgmt-button" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知按钮 → 走 deliver 转发给 LLM，agent 看到 content="[button:<id>]"
      const client = clients.get(channelId);
      if (!client) return;

      // v2.4.15+ UX：点击后清掉原按钮 + 标注"已点击"，**并在底下保留一个"打断"
      // 按钮**，让用户在 agent 处理过程中能随时中断（之前点完按钮就没打断按钮、
      // 一直要等 agent 自己跑完）。把这条 message 登记为本 channel 的当前 status
      // message —— Stop hook 触发时会自动 edit 成"✅ 完成"+ 去掉按钮，跟 typed
      // message 走 messageCreate 那条路径的语义完全一致。
      const clickedMsgId = interaction.message?.id;
      try {
        const label = (interaction.component as any)?.label || id;
        const origContent = interaction.message?.content || "";
        await interaction.editReply({
          content: `${origContent}\n\n✅ 已点击：**${label}**`,
          components: buildComponents([
            {
              type: "buttons",
              buttons: [
                {
                  id: `interrupt:${channelId}`,
                  label: t("打断", "Interrupt"),
                  emoji: "⚡",
                  style: "danger",
                },
              ],
            },
          ]),
        }).catch(() => {});
      } catch { /* non-critical */ }

      // 切换 activeStatusMessages 到这条点击的消息，旧的清成"✅ 完成"
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      const oldStatusId = activeStatusMessages.get(channelId);
      if (oldStatusId && oldStatusId !== clickedMsgId) {
        try {
          const ch = (await discord.channels.fetch(channelId)) as TextChannel;
          const sm = await ch.messages.fetch(oldStatusId);
          await sm.edit({ content: t("✅ 完成", "✅ Done"), components: [] });
        } catch { /* non-critical */ }
      }
      if (clickedMsgId) activeStatusMessages.set(channelId, clickedMsgId);
      resetToolTracking(channelId);
      startTypingWithSafety(channelId);
      await deliver({
        from: { kind: "user", userId: interaction.user.id, channelId, username: interaction.user.username },
        to: { kind: "local", channelId: client.channelId, ws: client.ws, cwd: client.cwd },
        intent: "request",
        content: `[button:${id}]`,
        meta: {
          messageId: interaction.message?.id || `btn_${Date.now()}`,
          triggerKind: "user_discord",
          ts: new Date().toISOString(),
          threadId: newThreadId(),
        },
      });
      return;
    }

    // ── Select Menus ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values[0];
      await interaction.deferUpdate().catch(() => {});

      // v2.0.19+: AskUserQuestion 的 select menu —— 用户选完更新 state，等 Submit 按钮
      // 一并把 selections 翻译成 keystroke 发到 TUI。
      if (id.startsWith("auq:") && /:q\d+$/.test(id)) {
        try {
          const { auqStates } = await import("./bridge/ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const qIdxStr = parts[2].slice(1); // q0 -> 0
          const qIdx = parseInt(qIdxStr, 10);
          const state = auqStates.get(auqChannel);
          if (state && Number.isInteger(qIdx) && qIdx >= 0 && qIdx < state.questions.length) {
            // interaction.values 是 string[]，每个是 option index 字符串
            state.selections[qIdx] = interaction.values
              .map((v) => parseInt(v, 10))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < state.questions[qIdx].options.length);
            console.log(`🎛 AUQ Q${qIdx + 1} 选了 ${state.selections[qIdx].length} 项 (channel=${auqChannel})`);
          }
        } catch (e) {
          console.error("AUQ select 处理异常:", e);
        }
        return;
      }

      // TUI modal 选择器
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        // 格式：modal:<targetWindow>:select  —— 最后一段固定是 "select"
        const parts = rest.split(":");
        const targetWindow = parts.slice(0, -1).join(":");
        await handleModalInteraction(interaction, targetWindow, value);
        return;
      }

      const mgmtResult = await handleMgmtSelect(id, value, channelId, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          await deliver({
            from: { kind: "bridge", label: "mgmt-select" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知菜单 → 转发给 LLM
      const client = clients.get(channelId);
      if (!client) return;
      startTypingWithSafety(channelId);
      client.ws.send(JSON.stringify({
        type: "message",
        content: `[select:${id}:${value}]`,
        meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
      }));
      return;
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
  }
});

// ============================================================
// WebSocket Server — channel-server 实例连接
// ============================================================

async function handleClientMessage(ws: ServerWebSocket<unknown>, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case "ping": {
      // v2.2.0+: keepalive。收到本身就重置了 Bun 的 ws idleTimeout；回个 pong
      // 让 channel-server 那侧的 idle 也重置。无需其它处理。
      try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* non-critical */ }
      return;
    }
    case "register": {
      const old = clients.get(msg.channelId);
      if (old && old.ws !== ws) {
        console.log(`🔄 频道 ${msg.channelId} 重新注册 — 主动关闭旧连接`);
        // 主动关闭旧的 ws：发送 "replaced" 通知 + close(**4001**)。
        // v2.2.0+: 用专用 close code 4001（不是 1000）。旧 channel-server 凭 close code
        // 就能判定"被取代 → exit"，不依赖 "replaced" 消息能否赶在 close 前送达（竞态）。
        // 1000 留给"bridge 干净重启"语义（→ channel-server 重连，不退出）。
        try {
          old.ws.send(JSON.stringify({ type: "replaced", reason: "channel re-registered" }));
        } catch { /* non-critical */ }
        try {
          old.ws.close(4001, "replaced by newer registration");
        } catch { /* non-critical */ }
      }
      clients.set(msg.channelId, { ws, channelId: msg.channelId, userId: msg.userId, cwd: msg.cwd });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));

      // v1.9.0+: master 注册 CONTROL_CHANNEL_ID 时，顺便也把 #agent-exchange 指向同一个 ws
      // 这样 peer 在 #agent-exchange 里说的话也由 master 处理（不额外建 session）
      if (msg.channelId === (process.env.CONTROL_CHANNEL_ID || "")) {
        try {
          const { readPeers } = await import("./lib/peers.js");
          const peers = await readPeers();
          if (peers.localAgentExchangeId && peers.localAgentExchangeId !== msg.channelId) {
            // 注意 cwd 沿用 master 的（因为这一项指向同一个 ws，jsonl 抽取要走同一份）
            clients.set(peers.localAgentExchangeId, { ws, channelId: peers.localAgentExchangeId, userId: msg.userId, cwd: msg.cwd });
            console.log(`📌 也把 #agent-exchange (${peers.localAgentExchangeId}) 挂到 master ws`);
          }
        } catch { /* non-critical */ }
      }

      // 启动 JSONL watcher（tool use / 助手文本流 tee 到 Discord + Web）。
      // fresh session 时 registry 可能还没写（manager 在 ready 之后才落盘，见
      // cmdCreate 步骤 6），而 channel-server 在 claude 启动时就 register 了 → 首次
      // 查不到 sessionId。故后台重试几次直到 registry 落盘，避免新会话没 watcher
      // （无 watcher = 工具/文本流既不到 Discord 也不到 Web）。
      {
        const regChannelId = msg.channelId;
        (async () => {
          for (let i = 0; i < 10; i++) {
            try {
              const regResult = await runManager("list");
              const agent = (regResult.agents || []).find((a: any) => a.channelId === regChannelId);
              if (agent?.sessionId && agent?.project) {
                const cwd = agent.project.replace(/^~/, process.env.HOME || "~");
                startWatching(agent.name, cwd, agent.sessionId, regChannelId, discord);
                return;
              }
            } catch { /* retry */ }
            await Bun.sleep(1000);
          }
        })();
      }

      break;
    }

    case "reply": {
      // v1.9.24+: 在任何 await 之前先删 pending。这样即使 Stop hook 在我们还在
      // 打 Discord API 的时候到达，后面的 cleanup 路径不会误触发。
      pendingReplies.delete(msg.chatId);

      try {
        let text = msg.text?.replace(/\s*\[DONE\]\s*$/, "") || msg.text || "";

        // v1.9.34+: [DIRECT] 标记 = 对称 direct 路由的 agent 回复。
        // strip 掉标记，**跳过 ensurePeerMentions**（不自动 @ 对方 bot），
        // 因为这条回复是给 foreign exchange 里的 HUMAN user 看的，对方 bot 不需要
        // 介入（否则对方 bot 看到 @ 会被唤醒跑一轮 LLM，就是 owner 反馈的 bug）。
        // agent 会在 text 里自己带 `<@user_id>` 让用户收到 push。
        const isDirectReply = /^\s*\[DIRECT\]\s*/i.test(text);
        if (isDirectReply) {
          text = text.replace(/^\s*\[DIRECT\]\s*/i, "");
        }

        // v2.0.0 Phase 4d: reply 从 discordReply 直接调改成构造 envelope 过 deliver。
        // from=local（发 reply 的这个 agent），to 根据 chat_id 判断 user / peer。
        // ensurePeerMentions（local exchange 自动 @ 所有 peer bot）移进 deliverToPeer，
        // reply handler 只负责 strip 标记 + 构造 envelope。isDirectReply → 置
        // skipAutoMention=true 让 deliverToPeer 跳过自动 @。
        let fromChannelId = "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }
        // v2.0.13+: agent 显式 reply() 到 peer 共享频道 = 它自己做对了，
        // 清掉 pendingPeerInbound 兜底，避免 Stop drain 时双发。
        if (fromChannelId) {
          const peerInbound = pendingPeerInbound.get(fromChannelId);
          if (peerInbound && msg.chatId === peerInbound.sharedChannelId) {
            pendingPeerInbound.delete(fromChannelId);
            console.log(`✅ peer inbound 已被 agent 正确 reply 到 ${peerInbound.sharedChannelId}，清 pending`);
          }
          // v2.0.16+: agent 调了 reply()（任意频道）= 它在回应/行动，清掉 inter-agent
          // 看门狗，Stop hook 不会再 nudge。清这个 ws 名下所有 channel key（master 挂
          // #control + #agent-exchange 两个）。
          for (const [chId, info] of clients.entries()) {
            if (info.ws === ws && pendingInterAgentMsg.delete(chId)) {
              console.log(`✅ inter-agent 看门狗清掉（${chId} 调了 reply()）`);
            }
          }
        }
        const fromEndpoint: RouterLocalEndpoint = {
          kind: "local",
          channelId: fromChannelId,
          ws,
        };
        const toEndpoint = await resolveReplyTarget(msg.chatId);
        const env: RouterEnvelope = {
          from: fromEndpoint,
          to: toEndpoint,
          intent: "response",
          content: text,
          meta: {
            messageId: `reply_${Date.now()}`,
            triggerKind: "agent_tool",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
            replyTo: msg.replyTo,
            components: msg.components,
            files: msg.files,
            skipAutoMention: isDirectReply,
          },
        };
        // Web tee：把回复文本推给该 agent 频道的 Web 订阅者（与 Discord 并行；
        // reply() 是 jsonl-watcher 的隐藏工具，不走 watcher，必须在此单独 tee）。
        if (fromChannelId && text.trim()) {
          pushToWeb(fromChannelId, { t: "text", text: text.trim() });
        }
        const delivery = await deliver(env);
        if (delivery.outcome.kind !== "sent") {
          // Web-only 模式：deliverToUser/Peer 恒 dropped（无 Discord 出口），但回复
          // 已经过 Web tee 送达 —— 给 agent 回成功 ack，别让它以为 reply 失败。
          if (!DISCORD_ENABLED && delivery.outcome.kind === "dropped") {
            ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: [] } }));
            break;
          }
          const errMsg = delivery.outcome.kind === "dropped"
            ? `reply dropped: ${delivery.outcome.reason}`
            : (delivery.outcome as any).error?.message || "unknown";
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: errMsg }));
          break;
        }
        const ids = delivery.outcome.discordMessageIds || [];
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ids } }));

        // v1.9.21+ send_to_agent 推回机制：
        // 如果 reply 的 chat_id 正好是某个 pending send_to_agent 的 target agent 的
        // channel，说明 agent 在它自己的 channel 里发了答案（discord 看得到，供审计）；
        // bridge 同时把这段 text push 回 caller 的 ws 作为合成消息，caller 不用再轮询。
        //
        // v2.0.0 Phase 4b：这条推回从直接 pending.callerWs.send 改成 deliver(envelope)。
        // from=local(target agent), to=local(caller agent), intent=response。
        // renderContentForLocal 的 from.kind==="local" 分支会拼 "[🤖 来自 <name>]"
        // 前缀（原来写的是 "[🤖 target 回复]"，语义等价 —— 都是标识"这条是别的
        // agent 发来的 response"）。
        const pending = pendingAgentCalls.get(msg.chatId);
        if (pending) {
          try {
            // v2.0.1+: from.channelId 用 originalReplyChannel（caller 手头的
            // 原 inbound 请求频道，比如 #agent-exchange）而不是 target 的私频。
            // resolveReplyBackChannel 对 from.kind=local 返回 from.channelId，
            // pushback 的 meta.chat_id 就会是原频道，caller LLM 顺手回就对了。
            // 没有 originalReplyChannel 时回退到 msg.chatId（target 私频）—
            // 这是旧行为，保守兜底。
            const replyBackHint = pending.originalReplyChannel || msg.chatId;
            const cleanedReply = text.replace(/<@!?\d+>\s*/g, "").trim();
            // v2.0.12+: 如果 caller 当时填了 `expecting`，在 push 的最前面注入
            // 一段提醒，让 caller LLM 不靠"自己记得"也知道这次答复后该续什么动作。
            const pushBody = pending.expecting
              ? `[💡 你之前 send_to_agent 给 ${pending.targetName} 时填的期望：${pending.expecting}\n对方答复如下，请按计划继续，不要只 relay 给用户。]\n\n${cleanedReply}`
              : cleanedReply;
            const pushEnv: RouterEnvelope = {
              from: {
                kind: "local",
                agentName: pending.targetName,
                channelId: replyBackHint,
                ws,
              },
              to: {
                kind: "local",
                agentName: pending.callerName,
                channelId: pending.callerChannelId,
                ws: pending.callerWs,
              },
              intent: "response",
              content: pushBody,
              meta: {
                messageId: `agent_reply_${Date.now()}`,
                triggerKind: "agent_tool",
                ts: new Date().toISOString(),
                threadId: newThreadId(),
              },
            };
            const delivery = await deliver(pushEnv);
            if (delivery.outcome.kind === "sent") {
              lastMessageSource.set(pending.callerChannelId, "agent");
              console.log(`📨 AGENT PUSH-BACK: ${pending.targetName} 回复 → push 给 caller=${pending.callerChannelId} (免去 fetch_messages 轮询)`);
              recordMetric("agent_pushback", { channelId: pending.callerChannelId, meta: { targetName: pending.targetName } });
            } else if (delivery.outcome.kind === "error") {
              console.error("AGENT PUSH-BACK 发送失败:", delivery.outcome.error);
            }
          } catch (e) {
            console.error("AGENT PUSH-BACK 异常:", e);
          }
          pendingAgentCalls.delete(msg.chatId);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "fetch_messages": {
      try {
        const result = await discordFetchMessages(discord, msg.channel, msg.limit);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "react": {
      try {
        await discordReact(discord, msg.chatId, msg.messageId, msg.emoji);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "edit_message": {
      try {
        await discordEditMessage(discord, msg.chatId, msg.messageId, msg.text);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "create_channel": {
      try {
        // Web-only（无 Discord）：合成本地 channelId。会话照常 register / 路由 / Web 按此 id 订阅。
        // Discord 开时不变：建真频道，Web 亦可订阅同一 channelId（两端镜像同一 session）。
        const channelId = DISCORD_ENABLED
          ? await discordCreateChannel(discord, msg.name, msg.category)
          : `local-${crypto.randomUUID()}`;
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channelId } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "delete_channel": {
      try {
        // 合成本地 channel 或 Web-only 模式：无 Discord 频道可删，直接 ok。
        if (DISCORD_ENABLED && !isLocalChannelId(msg.channelId)) {
          await discordDeleteChannel(discord, msg.channelId);
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "rename_channel": {
      try {
        if (DISCORD_ENABLED && !isLocalChannelId(msg.channelId)) {
          const ch = await discord.channels.fetch(msg.channelId);
          if (!ch || !("setName" in ch)) throw new Error("channel 不存在或不可重命名");
          await (ch as TextChannel).setName(msg.name);
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "announce_focus": {
      // v2.4.19+ manager create/resume 后调：在 agent 频道发一条置顶公告，带
      // 「🖥 跳到 iTerm tab」按钮（focus:<channelId>，LLM-free 直接执行）。
      // 返回 messageId 给 manager 存 registry，避免 restart 重复发。
      try {
        const annChannelId = msg.channelId as string;
        const annAgentName = msg.agentName as string;
        const ids = await discordReply(
          discord,
          annChannelId,
          `📌 **${annAgentName}** 控制台\n-# 点按钮把 Mac 上的 iTerm 切到这个 agent 的 tab`,
          undefined,
          [{
            type: "buttons",
            buttons: [
              { id: `focus:${annChannelId}`, label: "🖥 跳到 iTerm tab", style: "primary" },
            ],
          }],
        );
        const annMsgId = ids[ids.length - 1];
        // pin 失败不算错（权限不够时公告仍在，只是没置顶）
        try {
          const ch = await discord.channels.fetch(annChannelId);
          if (ch && "messages" in ch) {
            const m = await (ch as TextChannel).messages.fetch(annMsgId);
            await m.pin();
          }
        } catch (e) {
          console.warn(`📌 announce_focus pin 失败（公告已发未置顶）: ${(e as Error).message}`);
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageId: annMsgId } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "list_channels": {
      // 列出本 bot 能看到的所有文字频道。用于跨 Claudestra 场景：
      // peer 的 agent 自己看我这边有哪些频道、topic 是什么、该去哪里 @ 我的 bot。
      try {
        const channels: any[] = [];
        for (const [_, ch] of discord.channels.cache) {
          // 只要能发消息的文字频道（TextChannel type = 0）
          if (ch.type !== 0) continue;
          const textCh = ch as TextChannel;
          channels.push({
            id: textCh.id,
            name: textCh.name,
            topic: textCh.topic || "",
            guild: textCh.guild?.name || "",
            guild_id: textCh.guild?.id || "",
          });
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channels } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "route_to_agent": {
      try {
        // 找发送方的 channelId
        let fromChannelId = "";
        let fromName = msg.fromName || "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }
        // v2.0.16+: agent 调了 send_to_agent = 它在行动/回应，清掉 inter-agent 看门狗。
        // 清这个 ws 名下所有 channel key（master 挂 #control + #agent-exchange）。
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws && pendingInterAgentMsg.delete(chId)) {
            console.log(`✅ inter-agent 看门狗清掉（${chId} 调了 send_to_agent）`);
          }
        }

        // v1.9.22+: 解析 target，支持 peer: 语法：
        //   "future_data"                        → 本地 agent-future_data
        //   "peer:claudestra_ahh.future_data"    → 跨 peer，经 foreign #agent-exchange
        //   "future_data@claudestra_ahh"         → 同上（短格式）
        const rawTarget = (msg.targetName as string) || "";
        const peerMatch = rawTarget.match(/^peer:([^.]+)\.(.+)$/) || rawTarget.match(/^([^@]+)@(.+)$/);
        if (peerMatch) {
          const [, first, second] = peerMatch;
          const peerIdentifier = rawTarget.startsWith("peer:") ? first : second;
          const peerAgentName = rawTarget.startsWith("peer:") ? second : first;
          return await handlePeerRouteToAgent(ws, msg, fromChannelId, fromName, peerIdentifier, peerAgentName);
        }

        // 从 registry 找目标 agent
        const regResult = await runManager("list");
        const agents: any[] = regResult.agents || [];

        // 补全发送方名字。CONTROL_CHANNEL_ID 不在 registry（master 不是常规
        // agent），特判成 "master"；worker 查 registry；都找不到才回退到
        // channelId（理论上进不到这里，写个兜底）。
        if (!fromName && fromChannelId) {
          if (fromChannelId === CONTROL_CHANNEL_ID) {
            fromName = "master";
          } else {
            const fromAgent = agents.find((a: any) => a.channelId === fromChannelId);
            fromName = fromAgent?.name || fromChannelId;
          }
        }

        const targetName = rawTarget.startsWith("agent-") ? rawTarget : `agent-${rawTarget}`;
        const target = agents.find((a: any) => a.name === targetName);
        if (!target) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 不存在或未在 registry 中` }));
          break;
        }

        const targetClient = clients.get(target.channelId);
        if (!targetClient) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 未连接到 Bridge（可能已停止）` }));
          break;
        }

        // v2.0.0 Phase 4: 通过 deliver(envelope) 注入消息。
        // from=local(caller agent), to=local(target agent)。renderContentForLocal
        // 看到 from.kind=="local" 会自动拼 "[🤖 来自 fromName]" 前缀。
        const fromEnv: RouterLocalEndpoint = {
          kind: "local",
          agentName: fromName,
          channelId: fromChannelId,
          ws,
        };
        const toEnv: RouterLocalEndpoint = {
          kind: "local",
          agentName: targetName,
          channelId: target.channelId,
          ws: targetClient.ws,
          cwd: targetClient.cwd,
        };
        // v2.4.16+ oneShot=true：fire-and-forget，跳 pushback 和 watchdog。
        const oneShot = msg.oneShot === true;
        const env: RouterEnvelope = {
          from: fromEnv,
          to: toEnv,
          intent: "request",
          content: msg.text || "",
          meta: {
            messageId: `agent_${Date.now()}`,
            triggerKind: "agent_tool",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
            skipInterAgentWatchdog: oneShot || undefined,
          },
        };
        const delivery = await deliver(env);
        if (delivery.outcome.kind !== "sent") {
          const reason = delivery.outcome.kind === "dropped" ? delivery.outcome.reason : String((delivery.outcome as any).error);
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `deliver 失败: ${reason}` }));
          break;
        }

        // v1.9.6+: send_to_agent 触发的 turn 不发完成 @（用户没在这个 channel 问问题）
        lastMessageSource.set(target.channelId, "agent");

        // v1.9.21+: 记 pending agent call。当 target agent 下一次 reply 到自己 channel
        // 时，bridge 把那段 text 也 push 回 caller 的 ws（免 fetch_messages 轮询）。
        //
        // v2.0.1+: 同时推断 originalReplyChannel —— caller 手头正在处理的
        // inbound 请求的 intendedReplyChannel。pushback 用它做 meta.chat_id，
        // caller LLM 就不会错用 target 的私频当作回复目标（Bug 2 修复）。
        //
        // v2.4.16+: 支持 oneShot=true —— fire-and-forget 模式，不挂 pending（不会
        // pushback），同时下游 deliverToLocal 跳过给 target 挂 pendingInterAgentMsg
        // watchdog。用于 status sync / ack / FYI 等 agent 之间不期待回应的消息。
        if (fromChannelId && !oneShot) {
          let originalReplyChannel: string | undefined;
          for (const [, p] of pendingReplies.entries()) {
            if (p.targetWs === ws) {
              originalReplyChannel = p.intendedReplyChannel;
              break;
            }
          }
          pendingAgentCalls.set(target.channelId, {
            callerChannelId: fromChannelId,
            callerWs: ws,
            callerName: fromName,
            targetName,
            originalReplyChannel,
            expecting: typeof msg.expecting === "string" ? msg.expecting.trim() || undefined : undefined,
            ts: Date.now(),
          });
        }

        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          result: {
            ok: true,
            targetChannelId: target.channelId,
            targetName,
            pushBack: !oneShot,
          },
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }
  }
}

// ============================================================
// 启动
// ============================================================

// ── Hook HTTP 处理 ──
// channelId → 最近一次完成通知时间戳，用于去抖
const lastCompletionSent = new Map<string, number>();
// v1.9.6+: 记录每个 channel 的最近一次消息触发源。如果是 "agent"（peer bot / send_to_agent 转发）
// 那次 turn 结束时就不发完成 @ — 用户没问问题，不用通知他
const lastMessageSource = new Map<string, "user" | "agent">();
const COMPLETION_DEDUPE_MS = 10_000; // 10 秒内不重复发完成通知

/**
 * v1.9.22+ 对称 direct 路由：我方 bot 在对方 guild 的 foreign #agent-exchange 收到 @
 * 时，判断是否该走直接路由到我方 exposed agent。
 *
 * 信任模型（简化版，按 owner 要求）：
 *   - 消息在"我方 peer bot 能看见的 foreign #agent-exchange"（peerBots[].agentExchangeId）
 *   - @ 了我方 bot
 *   - 我方有唯一匹配 peer 的 direct exposure（按 peerBotId 或 "all"）
 *   - 人类发送者通过"信任传递"合法（peerBots 里登记过这个 peer 的 agentExchangeId，
 *     说明我们之前已经信任这个 peer；peer 在他自己的 #agent-exchange 里放进的人类就
 *     信任是 peer 的 authorized users，不额外鉴权）
 *
 * 返回 true 表示已处理（调用方 early return），false 表示没处理（调用方回到默认流程）。
 */
/**
 * v1.9.22+ 跨 peer 的 send_to_agent：调用方通过 `peer:X.Y` 或 `Y@X` 把请求
 * 发给 peer 的 agent。bridge 查 peers.json capabilities 验证、reply 到 peer 的
 * #agent-exchange @ 对方 bot 就 OK。同时记 pendingPeerCalls 在 peer bot 回复时
 * 把 text push 回 caller ws（跟 pendingAgentCalls 对称）。
 */
async function handlePeerRouteToAgent(
  ws: ServerWebSocket<unknown>,
  msg: any,
  fromChannelId: string,
  fromName: string,
  peerIdentifier: string,
  peerAgentName: string,
) {
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    const peer = peers.peerBots.find((p) => p.id === peerIdentifier || p.name === peerIdentifier || p.name.startsWith(`${peerIdentifier}#`));
    if (!peer) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `未知 peer "${peerIdentifier}"。已登记的 peers: ${peers.peerBots.map((p) => p.name).join(", ") || "(无)"}` }));
      return;
    }
    const cap = peers.capabilities.find((c) => c.peerBotId === peer.id && c.peerAgent === peerAgentName);
    if (!cap) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `peer "${peer.name}" 没有开放 agent "${peerAgentName}"。已开放: ${peers.capabilities.filter((c) => c.peerBotId === peer.id).map((c) => c.peerAgent).join(", ") || "(无)"}` }));
      return;
    }

    // peer.agentExchangeId 是**我方 guild** 里的那个 shared #agent-exchange（peer bot 能看到）
    // —— 跟 peer 通信就发在这。若 capability 带了 peerAgentExchangeId（对方 guild 的），
    //   优先用那个（更明确），否则 fall back 到 peer.agentExchangeId。
    const targetChannelId = cap.peerAgentExchangeId || peer.agentExchangeId;
    if (!targetChannelId) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `找不到跟 peer "${peer.name}" 通信的 #agent-exchange channel` }));
      return;
    }

    // v2.0.0 Phase 4b': 通过 deliver(envelope) 发给 peer。from=local(caller agent),
    // to=peer(目标 peer bot, shared channel)。content 里 @ peer bot id 让 bridge
    // ensurePeerMentions 能识别；deliverToPeer 会再补其他 peer bot 的 @（如果
    // 频道里还有别的 peer bot，通常没有）。
    const textWithMention = `<@${peer.id}> ${msg.text || ""}`.trim();
    const outboundEnv: RouterEnvelope = {
      from: {
        kind: "local",
        agentName: fromName,
        channelId: fromChannelId,
        ws,
      },
      to: {
        kind: "peer",
        peerBotId: peer.id,
        peerBotName: peer.name,
        sharedChannelId: targetChannelId,
      },
      intent: "request",
      content: textWithMention,
      meta: {
        messageId: `peer_route_${Date.now()}`,
        triggerKind: "agent_tool",
        ts: new Date().toISOString(),
        threadId: newThreadId(),
      },
    };
    const delivery = await deliver(outboundEnv);
    if (delivery.outcome.kind !== "sent") {
      const errStr = delivery.outcome.kind === "dropped"
        ? delivery.outcome.reason
        : (delivery.outcome as any).error?.message || "unknown";
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `发送到 peer 频道失败: ${errStr}` }));
      return;
    }

    // 记 pendingPeerCalls：下次这个 peer 在 shared channel 回复时，bridge push 给 caller
    pendingPeerCalls.set(targetChannelId, {
      callerChannelId: fromChannelId,
      callerWs: ws,
      callerName: fromName,
      peerBotId: peer.id,
      peerBotName: peer.name,
      peerAgent: peerAgentName,
      expecting: typeof msg.expecting === "string" ? msg.expecting.trim() || undefined : undefined,
      ts: Date.now(),
    });

    ws.send(JSON.stringify({
      type: "response",
      requestId: msg.requestId,
      result: {
        ok: true,
        targetChannelId,
        targetName: `peer:${peer.name}.${peerAgentName}`,
        pushBack: true,
      },
    }));
    console.log(`🎯 PEER ROUTE: ${fromName} → peer ${peer.name} agent ${peerAgentName} (channel ${targetChannelId})`);
    recordMetric("peer_route_send", { channelId: targetChannelId, meta: { peer: peer.name, peerAgent: peerAgentName } });
  } catch (err) {
    ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
  }
}

/**
 * v1.9.26+ D+C 组合：peer direct 路由多候选消歧义。
 *
 * 从 candidates 里选一个：
 *   1. 只有 1 个 → 直接选
 *   2. 多个 → C: 看 msg 里是否提到某个 agent 名字，唯一匹配就选那个
 *   3. 多个 + 关键词没唯一命中 → D: 在 channelId 频道发按钮让用户点，返回 "posted"
 */
type PeerDirectDecision =
  | { kind: "selected"; exposure: Exposure }
  | { kind: "button_posted" }
  | { kind: "multi_unresolved" };

type Exposure = { localAgent: string; peerBotId: string | "all"; purpose?: string; mode?: string; grantedAt: string };

async function resolvePeerDirectCandidate(
  candidates: Array<Exposure>,
  content: string,
  postChannelId: string,
  originalMsgId: string,
  senderId: string,
  kind: "local" | "foreign",
): Promise<PeerDirectDecision> {
  if (candidates.length === 1) return { kind: "selected", exposure: candidates[0] };

  // C: 关键词快路径
  const lower = content.toLowerCase();
  const nameMatched = candidates.filter((e) => {
    const n = e.localAgent.toLowerCase();
    // 完整词或带前缀 agent- 的匹配都算
    return new RegExp(`\\b${n.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(lower) ||
      lower.includes(`agent-${n}`);
  });
  if (nameMatched.length === 1) {
    console.log(`🎯 PEER DISAMBIG: C 关键词命中 → ${nameMatched[0].localAgent}`);
    return { kind: "selected", exposure: nameMatched[0] };
  }

  // D: 按钮消歧义
  try {
    const ch = await discord.channels.fetch(postChannelId);
    if (!ch || !("messages" in ch)) return { kind: "multi_unresolved" };
    // 每个候选一个 button：peer_select:<local|foreign>:<agent>:<origChannelId>:<origMsgId>
    const buttons = candidates.slice(0, 4).map((e) => ({
      id: `peer_select;${kind};${e.localAgent};${postChannelId};${originalMsgId}`,
      label: e.localAgent,
      style: "primary" as const,
      emoji: "🎯",
    }));
    buttons.push({
      id: `peer_select;${kind};__cancel__;${postChannelId};${originalMsgId}`,
      label: "都不是 / 取消",
      style: "secondary" as any,
      emoji: "🚫",
    });
    const lines = [
      `⚠️ <@${senderId}> 你这条请求匹配到 **${candidates.length}** 个候选 agent：`,
      ``,
      ...candidates.slice(0, 4).map((e) => `• **${e.localAgent}** — ${e.purpose || "（无描述）"}`),
      ``,
      `点一个按钮选一个，或者在原消息里带 agent 名字（比如 "用 ${candidates[0].localAgent} 帮我..."）再发一次走快路径。`,
    ];
    // 走 deliver(bridge → user) —— UI 按钮的发送方是 bridge 自己，接收方是发起
    // 消息的人类用户（postChannelId 即他们看消息的 channel）。discordReply 内部
    // buildComponents + trackSentMessage。
    const disambigDelivery = await deliver({
      from: { kind: "bridge", label: "peer-disambig" },
      to: { kind: "user", userId: senderId, channelId: postChannelId },
      intent: "notification",
      content: lines.join("\n"),
      meta: {
        messageId: `disambig_${Date.now()}`,
        triggerKind: "bridge_synth",
        ts: new Date().toISOString(),
        threadId: newThreadId(),
        components: [{ type: "buttons", buttons }],
      },
    });
    if (disambigDelivery.outcome.kind !== "sent") return { kind: "multi_unresolved" };
    console.log(`🎯 PEER DISAMBIG: D 按钮发出（${candidates.length} 候选）at channel=${postChannelId}`);
    recordMetric("peer_disambig_buttons", { channelId: postChannelId, meta: { candidateCount: String(candidates.length) } });
    return { kind: "button_posted" };
  } catch (e) {
    console.error("PEER DISAMBIG 按钮发送失败:", e);
    return { kind: "multi_unresolved" };
  }
}

/**
 * v2.0.0 Phase 4d: 根据 agent reply 传的 chat_id 反推该 endpoint 是 user 还
 * 是 peer。决策树：
 *   1. chat_id 在 peers.capabilities 里登记过（peerAgentExchangeId）→ 对方 guild
 *      的 foreign exchange → PeerEndpoint with 对应 peer bot 身份
 *   2. chat_id 是我方 localAgentExchangeId → 我方 #agent-exchange → PeerEndpoint
 *      with peerBotId="all"（deliverToPeer 用 ensurePeerMentions 扫频道 @ 所有
 *      peer bot；具体 bot id 不重要）
 *   3. 其他（agent 自己频道 / #control）→ UserEndpoint with ALLOWED_USER_IDS[0]
 *      作为 userId。deliverToUser 不自动 @ user（push 通知在 Stop hook 完成通知
 *      里另管）。
 */
async function resolveReplyTarget(chatId: string): Promise<RouterUserEndpoint | RouterPeerEndpoint> {
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    // 1. foreign exchange
    const foreignCap = peers.capabilities.find((c) => c.peerAgentExchangeId === chatId);
    if (foreignCap) {
      return {
        kind: "peer",
        peerBotId: foreignCap.peerBotId,
        peerBotName: foreignCap.peerBotName,
        sharedChannelId: chatId,
      };
    }
    // 2. local agent-exchange
    if (peers.localAgentExchangeId === chatId) {
      return {
        kind: "peer",
        peerBotId: "all",
        peerBotName: "peer",
        sharedChannelId: chatId,
      };
    }
  } catch { /* non-critical */ }
  // 3. user channel
  const userId = ALLOWED_USER_IDS.length > 0 ? ALLOWED_USER_IDS[0] : "";
  return { kind: "user", userId, channelId: chatId };
}

/**
 * v2.0.0 Phase 3c: messageCreate 里的 direct-route 决策抽成独立函数。
 * peer bot 在 #agent-exchange 发消息 → 查 peers.json 里 mode=direct 的
 * exposures → 用 resolvePeerDirectCandidate 挑一个 → 找对应 agentClient。
 *
 * 返回：
 *  - `direct`：选到了具体 agent，routeWs 换成 agentClient.ws
 *  - `button_pending`：按钮已 post，messageCreate 应直接 return
 *  - `fallback`：没 direct 命中 / agent 不在线 / 其他异常 → 回落到 master
 *
 * 注意：只处理 peer + 我方 #agent-exchange 场景。对称 direct（peer 在自己
 * guild 的 #agent-exchange @ 我方 bot）走的是 tryRouteForeignAgentExchange，
 * 不走这里。
 */
type DirectRouteResult =
  | { kind: "direct"; toClient: ClientInfo; agentName: string }
  | { kind: "button_pending" }
  | { kind: "fallback" };

async function tryPeerDirectRoute(
  msg: DiscordMessage,
  channelId: string,
): Promise<DirectRouteResult> {
  const localAgentExchangeId = await getLocalAgentExchangeId();
  if (!localAgentExchangeId || channelId !== localAgentExchangeId) {
    return { kind: "fallback" };
  }
  const { readPeers, effectivePeerMode } = await import("./lib/peers.js");
  const peers = await readPeers();
  const directExposures = peers.exposures.filter(
    (e) => (e.peerBotId === msg.author.id || e.peerBotId === "all") && effectivePeerMode(e) === "direct"
  );
  if (directExposures.length === 0) return { kind: "fallback" };

  const decision = await resolvePeerDirectCandidate(
    directExposures as any,
    msg.content || "",
    channelId,
    msg.id,
    msg.author.id,
    "local",
  );
  if (decision.kind === "button_posted") return { kind: "button_pending" };
  if (decision.kind !== "selected") return { kind: "fallback" };

  const targetExp = decision.exposure;
  try {
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    const targetAgent = agents.find((a: any) =>
      a.name === targetExp.localAgent || a.name === `agent-${targetExp.localAgent}`
    );
    if (!targetAgent) {
      console.log(`⚠️ PEER DIRECT fallback: agent ${targetExp.localAgent} 在 registry 找不到，回落 master`);
      return { kind: "fallback" };
    }
    if (targetAgent.status !== "active") {
      console.log(`⚠️ PEER DIRECT fallback: agent ${targetExp.localAgent} status=${targetAgent.status}，回落 master`);
      return { kind: "fallback" };
    }
    const agentClient = clients.get(targetAgent.channelId);
    if (!agentClient) {
      console.log(`⚠️ PEER DIRECT fallback: agent ${targetAgent.name} 未连接 bridge，回落 master`);
      return { kind: "fallback" };
    }
    console.log(`🎯 PEER DIRECT: ${msg.author.username} → ${targetAgent.name} (bypass master)`);
    recordMetric("peer_direct_route", { channelId, meta: { peerBotId: msg.author.id, agent: targetAgent.name } });
    return { kind: "direct", toClient: agentClient, agentName: targetAgent.name };
  } catch (e) {
    console.error("PEER DIRECT routing 失败，回落 master:", e);
    return { kind: "fallback" };
  }
}

/**
 * v1.9.28+ bridge 重启后清理残留的"💭 大聪明思考中..."按钮消息。
 * 在 ready 事件里跑：扫每个 registered channel 的近期消息，把我方 bot 发的
 * 以 💭 开头、还带 components（interrupt 按钮）的消息编辑成"bridge 重启了"，
 * 避免用户看到永远转圈的思考中 UI。
 */
async function cleanupStaleThinkingMessages(): Promise<void> {
  try {
    // 收集需要扫的 channel：master CONTROL + 本地 #agent-exchange + 所有 agent 频道 + peer 的 shared channels
    const channelIds = new Set<string>();
    if (CONTROL_CHANNEL_ID) channelIds.add(CONTROL_CHANNEL_ID);
    try {
      const { readPeers } = await import("./lib/peers.js");
      const peers = await readPeers();
      if (peers.localAgentExchangeId) channelIds.add(peers.localAgentExchangeId);
      for (const pb of peers.peerBots) {
        if (pb.agentExchangeId) channelIds.add(pb.agentExchangeId);
      }
    } catch { /* non-critical */ }
    try {
      const listResult = await runManager("list");
      for (const a of listResult.agents || []) {
        if (a.channelId) channelIds.add(a.channelId);
      }
    } catch { /* non-critical */ }

    const myBotId = getBotUserId();
    let cleaned = 0;
    for (const cid of channelIds) {
      try {
        const ch = await discord.channels.fetch(cid).catch(() => null);
        if (!ch || !("messages" in ch)) continue;
        const recent = await (ch as TextChannel).messages.fetch({ limit: 20 }).catch(() => null);
        if (!recent) continue;
        for (const [, msg] of recent) {
          // 只改我方 bot 的、以 💭 开头、还带按钮（未 Stop 编辑过）的消息
          if (msg.author.id !== myBotId) continue;
          if (!msg.content?.startsWith("💭")) continue;
          if (!msg.components || msg.components.length === 0) continue; // 已经被 Stop 清了
          try {
            await msg.edit({
              content: t(
                "⚠️ bridge 重启了，上一轮任务状态丢失。如果你的请求没完成，重新发一次就好。",
                "⚠️ Bridge restarted — previous task state is lost. If your request didn't complete, please send it again.",
              ),
              components: [],
            });
            cleaned++;
          } catch { /* non-critical */ }
        }
      } catch { /* non-critical */ }
    }
    if (cleaned > 0) {
      console.log(`🧹 启动清理：修复了 ${cleaned} 条遗留的"💭 思考中..."消息（bridge 重启前卡住的）`);
      recordMetric("bridge_start_cleanup", { meta: { cleaned: String(cleaned) } });
    }
  } catch (e) {
    console.error("cleanupStaleThinkingMessages 异常:", e);
  }
}

/**
 * v1.9.26+ 按钮点击后用指定 agent 名重放 peer direct 路由。
 * 跟 tryRouteForeignAgentExchange / messageCreate 里的 direct 分支共享
 * 消息注入逻辑，但跳过消歧义（直接用指定 agent）。
 */
async function routePeerDirectWithAgent(
  origMsg: DiscordMessage,
  origChannelId: string,
  agentName: string,
  kind: "local" | "foreign",
): Promise<boolean> {
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();

    // 验证 exposure 存在（按 agent 名找）
    const exp = peers.exposures.find((e) => e.localAgent === agentName || `agent-${e.localAgent}` === agentName);
    if (!exp) {
      console.log(`🎯 routePeerDirectWithAgent: 找不到 exposure for agent ${agentName}`);
      return false;
    }

    // 找 peer bot：
    //   local  → origMsg 的 author 就是 peer bot（peer 发消息到我方 exchange）
    //   foreign → channel 是"对方 guild 的 #agent-exchange"，lookup 用
    //              capabilities[].peerAgentExchangeId（v1.9.33+ 同 tryRouteForeignAgentExchange 修复）
    let peerBotName = "";
    let peerBotId = "";
    if (kind === "local") {
      peerBotName = origMsg.author.username;
      peerBotId = origMsg.author.id;
    } else {
      const cap = peers.capabilities.find((c) => c.peerAgentExchangeId === origChannelId);
      if (!cap) {
        console.log(`🎯 routePeerDirectWithAgent (foreign): 找不到 capability for channel ${origChannelId}`);
        return false;
      }
      peerBotId = cap.peerBotId;
      const peerBot = peers.peerBots.find((p) => p.id === peerBotId);
      peerBotName = peerBot?.name || cap.peerBotName;
    }

    // 找 agent ws
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    const targetAgent = agents.find((a: any) =>
      a.name === exp.localAgent || a.name === `agent-${exp.localAgent}`
    );
    if (!targetAgent || targetAgent.status !== "active") return false;
    const agentClient = clients.get(targetAgent.channelId);
    if (!agentClient) return false;

    // 附件
    const attachmentPaths: string[] = [];
    if (origMsg.attachments.size > 0) {
      const inboxDir = `${TMP_DIR}/inbox`;
      await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
      for (const [, att] of origMsg.attachments) {
        try {
          const resp = await fetch(att.url);
          const buf = await resp.arrayBuffer();
          const filePath = `${inboxDir}/${att.id}_${att.name}`;
          await Bun.write(filePath, buf);
          attachmentPaths.push(filePath);
        } catch { /* skip */ }
      }
    }

    const rawText = (origMsg.content || "")
      .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
      .trim();
    const contentWithAttachments = rawText +
      (attachmentPaths.length > 0 ? `\n\n${attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n")}` : "");

    // v2.0.0 Phase 4c: 构造 envelope 交给 deliver。
    // from=peer 用 channel 所属的 peer bot 身份（local 时就是 msg.author，foreign
    // 时是 capabilities lookup 拿到的）。sourceUserId=origMsg.author.id 给 foreign
    // 场景 renderPeerDirectHeader 拼 @ 发起人用。
    lastMessageSource.set(agentClient.channelId, "agent");
    const env: RouterEnvelope = {
      from: {
        kind: "peer",
        peerBotId,
        peerBotName,
        sharedChannelId: origChannelId,
      },
      to: {
        kind: "local",
        agentName: targetAgent.name,
        channelId: agentClient.channelId,
        ws: agentClient.ws,
        cwd: agentClient.cwd,
      },
      intent: "request",
      content: contentWithAttachments,
      meta: {
        messageId: origMsg.id,
        triggerKind: origMsg.author.bot ? "peer_discord" : "user_discord",
        ts: origMsg.createdAt.toISOString(),
        threadId: newThreadId(),
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
        sourceUserId: origMsg.author.id,
      },
    };
    const delivery = await deliver(env);
    if (delivery.outcome.kind !== "sent") {
      const reason = delivery.outcome.kind === "dropped" ? delivery.outcome.reason : String((delivery.outcome as any).error);
      console.error(`🎯 PEER DIRECT (button) deliver 失败: ${reason}`);
      return false;
    }
    // v2.0.13+: 记 pendingPeerInbound，Stop hook drain 时如果 agent 忘 reply 就把
    // 抓到的文字 forward 到 peer 的 #agent-exchange，避免 peer 完全看不见答复。
    pendingPeerInbound.set(agentClient.channelId, {
      localAgentName: targetAgent.name,
      sharedChannelId: origChannelId,
      peerBotId,
      peerBotName,
      isForeign: kind === "foreign",
      ts: Date.now(),
    });
    const senderLabel = origMsg.author.bot ? `peer bot ${origMsg.author.username}` : `用户 ${origMsg.author.username}`;
    console.log(`🎯 PEER DIRECT (button): ${senderLabel} → ${targetAgent.name} (kind=${kind})`);
    recordMetric("peer_direct_route_button", { channelId: origChannelId, meta: { agent: targetAgent.name, kind } });
    return true;
  } catch (e) {
    console.error("routePeerDirectWithAgent 异常:", e);
    return false;
  }
}

async function tryRouteForeignAgentExchange(msg: DiscordMessage, channelId: string): Promise<boolean> {
  try {
    const { readPeers, effectivePeerMode } = await import("./lib/peers.js");
    const peers = await readPeers();

    // v1.9.33+: 修 v1.9.22 的 bug —— 原来查 `peerBots[].agentExchangeId`，那个字段
    // 存的是"peer bot 在我方 guild 的 local scope channel"（= 我方自己的 exchange）。
    // 但对称路由触发时 channelId 是**对方 guild** 的 exchange（我方 bot 在对方 guild
    // 能看到的那个），这个 id 是从 `capabilities[].peerAgentExchangeId` 学来的
    // （对方 peer-expose 时广播的 PeerEvent 里带 exchange 字段）。
    // 正确的 lookup：通过 capabilities 反查 "这个 channel 是哪个 peer 的 foreign
    // exchange"。
    const capabilityForChannel = peers.capabilities.find((c) => c.peerAgentExchangeId === channelId);
    if (!capabilityForChannel) {
      // 这个 channel 不是任何 peer 的 #agent-exchange，交给后续流程（大概率 drop）
      return false;
    }
    // 如果是我们自己 guild 的本地 agent-exchange，不走这条（那条走 clients.get 正常路径）
    if (peers.localAgentExchangeId === channelId) return false;

    // 从 capability 拿到这是哪个 peer bot 的 channel，再去 peerBots 拿 bot 名字
    const peerBotId = capabilityForChannel.peerBotId;
    const peerBotForChannel = peers.peerBots.find((p) => p.id === peerBotId)
      ?? { id: peerBotId, name: capabilityForChannel.peerBotName };

    // 2. 找这个 peer 的 direct exposure（我们对这个 peer 开放的 agent）
    const directExposures = peers.exposures
      .filter((e) => (e.peerBotId === peerBotForChannel.id || e.peerBotId === "all") && effectivePeerMode(e) === "direct");

    if (directExposures.length === 0) {
      // v1.9.35+: 没有 direct exposure，但是 peer bot 在他自己的 foreign exchange 里
      // @ 了我们（比如 peer 用旧版 via_master 模式，agent reply 落到他自己 exchange；
      // 或 peer agent 完成工作后只想通知我们一声）→ 我们要 **relay** 这条消息到
      // 我方 #agent-exchange，让 user 能看到，避免沉默 drop。
      if (msg.author.bot && peers.localAgentExchangeId) {
        const cleanText = (msg.content || "")
          .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
          .replace(/<!--\s*CLAUDESTRA_PEER_EVENT[\s\S]*?-->/g, "")
          .replace(/\s*\[EOT\]\s*$/i, "")
          .replace(/^\s*\[DIRECT\]\s*/i, "")
          .trim();
        if (cleanText) {
          try {
            const userMention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
            const relayText = [
              `📬 **来自 peer ${peerBotForChannel.name}**（他在自己 guild 的 #agent-exchange 里 @ 了你）${userMention}`,
              ``,
              cleanText,
              ``,
              `_bridge relay — peer 没走 direct 路由（mode=via_master 或老版本），消息被原样搬到这里了_`,
            ].join("\n");
            const relayDelivery = await deliver({
              from: { kind: "bridge", label: "peer-relay" },
              to: {
                kind: "user",
                userId: ALLOWED_USER_IDS[0] || "",
                channelId: peers.localAgentExchangeId,
              },
              intent: "notification",
              content: relayText,
              meta: {
                messageId: `relay_${Date.now()}`,
                triggerKind: "bridge_synth",
                ts: new Date().toISOString(),
                threadId: newThreadId(),
              },
            });
            if (relayDelivery.outcome.kind === "sent") {
              console.log(`📬 RELAY: peer ${peerBotForChannel.name} 在 foreign exchange 的消息 relay 到本方 exchange (${cleanText.length} chars)`);
              recordMetric("peer_relay_foreign_reply", { channelId: peers.localAgentExchangeId, meta: { peer: peerBotForChannel.name, from: channelId } });
            } else if (relayDelivery.outcome.kind === "error") {
              console.error("📬 RELAY 失败:", relayDelivery.outcome.error);
            }
          } catch (e) {
            console.error("📬 RELAY 异常:", e);
          }
        }
        return true; // 已处理（relay 完），不 fall through
      }
      console.log(`🎯 SYMMETRIC: 收到 foreign #agent-exchange (${channelId}) 的 @ 但我方没对 ${peerBotForChannel.name} 开放任何 direct agent 也无法 relay，忽略`);
      return false;
    }

    // v1.9.26+ D+C 消歧义：多候选时先关键词匹配，不唯一就发按钮
    const decision = await resolvePeerDirectCandidate(
      directExposures,
      msg.content || "",
      channelId,
      msg.id,
      msg.author.id,
      "foreign",
    );
    if (decision.kind === "button_posted") return true;
    if (decision.kind === "multi_unresolved") {
      console.log(`🎯 SYMMETRIC: ${directExposures.length} 候选无法消歧，按钮也没发成功，放弃`);
      return false;
    }
    const targetExp = decision.exposure;

    // 3. 找 target agent 的 ws
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    const targetAgent = agents.find((a: any) =>
      a.name === targetExp.localAgent || a.name === `agent-${targetExp.localAgent}`
    );
    if (!targetAgent || targetAgent.status !== "active") {
      console.log(`🎯 SYMMETRIC fallback: target agent ${targetExp.localAgent} 不可用 (status=${targetAgent?.status ?? "missing"})`);
      return false;
    }
    const agentClient = clients.get(targetAgent.channelId);
    if (!agentClient) {
      console.log(`🎯 SYMMETRIC fallback: target agent ${targetAgent.name} 未连接 bridge`);
      return false;
    }

    // 4. 处理附件（跟主流程一样）
    const attachmentPaths: string[] = [];
    if (msg.attachments.size > 0) {
      const inboxDir = `${TMP_DIR}/inbox`;
      await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
      for (const [, att] of msg.attachments) {
        try {
          const resp = await fetch(att.url);
          const buf = await resp.arrayBuffer();
          const filePath = `${inboxDir}/${att.id}_${att.name}`;
          await Bun.write(filePath, buf);
          attachmentPaths.push(filePath);
        } catch { /* skip */ }
      }
    }

    // 5. 原文 strip mention + 附件
    const rawText = (msg.content || "")
      .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
      .trim();
    const contentWithAttachments = rawText +
      (attachmentPaths.length > 0 ? `\n\n${attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n")}` : "");

    // v2.0.0 Phase 4c: 构造 envelope 交给 deliver。
    // from=peer 用 peerBotForChannel（对方 peer bot 身份，对应 capabilities lookup）。
    // sharedChannelId = foreign exchange 的 channelId，deliver 里 renderPeerDirectHeader
    // 会看到 sharedChannelId ≠ 我方 localAgentExchangeId 就走对称路由 header。
    // sourceUserId 给 @发起人用（不是 peerBot 身份）。
    lastMessageSource.set(agentClient.channelId, "agent");
    const env: RouterEnvelope = {
      from: {
        kind: "peer",
        peerBotId: peerBotForChannel.id,
        peerBotName: peerBotForChannel.name,
        sharedChannelId: channelId,
      },
      to: {
        kind: "local",
        agentName: targetAgent.name,
        channelId: agentClient.channelId,
        ws: agentClient.ws,
        cwd: agentClient.cwd,
      },
      intent: "request",
      content: contentWithAttachments,
      meta: {
        messageId: msg.id,
        triggerKind: msg.author.bot ? "peer_discord" : "user_discord",
        ts: msg.createdAt.toISOString(),
        threadId: newThreadId(),
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
        sourceUserId: msg.author.id,
      },
    };
    const delivery = await deliver(env);
    if (delivery.outcome.kind !== "sent") {
      const reason = delivery.outcome.kind === "dropped" ? delivery.outcome.reason : String((delivery.outcome as any).error);
      console.error(`🎯 SYMMETRIC deliver 失败: ${reason}`);
      return false;
    }
    // v2.0.13+: 记 pendingPeerInbound — Stop drain 兜底 forward 用
    pendingPeerInbound.set(agentClient.channelId, {
      localAgentName: targetAgent.name,
      sharedChannelId: channelId,
      peerBotId: peerBotForChannel.id,
      peerBotName: peerBotForChannel.name,
      isForeign: true,
      ts: Date.now(),
    });
    const senderLabel = msg.author.bot ? `peer bot ${msg.author.username}` : `用户 ${msg.author.username}`;
    console.log(`🎯 SYMMETRIC DIRECT: ${senderLabel} 在 foreign #agent-exchange (${channelId}) → 路由到 ${targetAgent.name}`);
    recordMetric("peer_direct_route_symmetric", { channelId, meta: { sender: msg.author.id, agent: targetAgent.name } });
    return true;
  } catch (e) {
    console.error("tryRouteForeignAgentExchange 异常:", e);
    return false;
  }
}

/** v1.9.21+ 每分钟扫一次，清超过 10min 仍未被 agent 回复消化的 pendingAgentCalls。
 * 正常情况下 agent 会在几十秒内回 → 被 reply handler 清掉。残留条目只会发生在
 * agent 挂了 / 忘了回 / fetch_messages 被用户取消等极端场景。留太多占内存。 */
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 10 * 60_000;
  for (const [channelId, pending] of pendingAgentCalls.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingAgentCalls.delete(channelId);
      console.log(`🧹 pendingAgentCalls stale: 清掉 target=${pending.targetName} (caller=${pending.callerName})`);
    }
  }
  for (const [channelId, pending] of pendingPeerCalls.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingPeerCalls.delete(channelId);
      console.log(`🧹 pendingPeerCalls stale: 清掉 target=${pending.peerBotName}/${pending.peerAgent}`);
    }
  }
  for (const [channelId, pending] of pendingPeerInbound.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingPeerInbound.delete(channelId);
      console.log(`🧹 pendingPeerInbound stale: 清掉 agent=${pending.localAgentName} (peer=${pending.peerBotName})`);
    }
  }
  for (const [channelId, pending] of pendingInterAgentMsg.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingInterAgentMsg.delete(channelId);
      console.log(`🧹 pendingInterAgentMsg stale: 清掉 ${channelId}（来自 ${pending.fromLabel}）`);
    }
  }
  // v2.0.19+: AskUserQuestion state，留 30 min 给用户慢慢选
  import("./bridge/ask-user-question.js").then(({ auqStates }) => {
    for (const [channelId, state] of auqStates.entries()) {
      if (now - state.ts > 30 * 60_000) {
        auqStates.delete(channelId);
        console.log(`🧹 auqStates stale: 清掉 ${channelId}（${state.questions.length} 问，30min 没 submit）`);
      }
    }
  }).catch(() => { /* non-critical */ });
}, 60_000).unref();

/** 返回跟 channelId 共享同一个 ws 的所有其他 channelId（不含自身）。
 *  master ws 挂了 #control + #agent-exchange 两个 channel key，任何一端的
 *  Stop hook 都得同步清另一端的 typing / status message。 */
function sameWsChannels(channelId: string): string[] {
  const self = clients.get(channelId);
  if (!self) return [];
  const out: string[] = [];
  for (const [otherId, info] of clients.entries()) {
    if (otherId !== channelId && info.ws === self.ws) out.push(otherId);
  }
  return out;
}

async function handleHookRequest(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { channelId: string; event: string };
    const { channelId, event } = body;
    if (!channelId || !event) {
      return new Response("Missing channelId or event", { status: 400 });
    }

    // 所有 hook 事件都停 typing / 清 safety timer
    // 兼容旧版 hook 发的 "stop"
    if (event === "Stop" || event === "StopFailure" || event === "Notification" || event === "stop") {
      console.log(`🏁 Hook 收到 ${event}: channel=${channelId}`);
      // typing + safety timer：本 channel + 共享 ws 的所有 channel 都停（参见
      // sameWsChannels 的注释）。
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      for (const otherId of sameWsChannels(channelId)) {
        stopTyping(otherId);
        clearSafetyTimer(otherId);
      }

      // 只有 Stop / StopFailure 触发完成通知，Notification 不触发（避免 Stop+Notification 连发两次）
      // 同时 10 秒内去抖，防止 Claude Code 重复 fire Stop 事件
      let shouldNotify = event === "Stop" || event === "StopFailure" || event === "stop";
      const now = Date.now();
      const last = lastCompletionSent.get(channelId) || 0;
      if (shouldNotify && now - last < COMPLETION_DEDUPE_MS) {
        console.log(`🏁 去抖跳过（${Math.round((now - last) / 1000)}s 内已发过）: channel=${channelId}`);
        return new Response("ok");
      }

      // v1.9.6+: 如果最近一次 message 来自 agent（peer bot / send_to_agent 转发），
      // 这次 Stop 是"为 agent 工作" — 用户没问过问题，不用 @ 他
      if (shouldNotify && lastMessageSource.get(channelId) === "agent") {
        console.log(`🏁 跳过完成通知（上一次消息来自 agent，非 user 触发）: channel=${channelId}`);
        shouldNotify = false;
      }

      // 防御性：等 Claude Code TUI 稳定下来（~1.5s），再看 pane 状态确认真的"完成"。
      // 有几种场景 Stop 会提前触发：
      //   - pane 上有权限/session-idle 弹窗 → Claude 实际在等用户输入
      //   - pane 不在 ❯ idle 提示符 → Claude 可能在下一步（工具调用流转等）
      // 这两种都应该跳过完成通知，等真正 idle 时的下一个 Stop 事件再发。
      if (shouldNotify) {
        await Bun.sleep(1500);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) {
            const target = windowTarget(agent.name);
            const pane = await tmuxCapture(target, 30);
            if (detectRuntimePermissionPrompt(pane) || detectSessionIdlePrompt(pane)) {
              console.log(`🏁 pane 有弹窗，跳过完成通知: channel=${channelId} agent=${agent.name}`);
              shouldNotify = false;
            } else {
              const { isIdle } = await import("./lib/tmux-helper.js");
              const idle = await isIdle(target);
              if (!idle) {
                console.log(`🏁 Stop 触发但 pane 不是 ❯ idle 状态，Claude 还在工作 → 跳过这次通知，等下一个 Stop: channel=${channelId} agent=${agent.name}`);
                shouldNotify = false;
              }
            }
            // v2.4.17+ 检测 ScheduleWakeup：新版 Claude Code 把任务包成
            // run_in_background bash + ScheduleWakeup 排队回调，turn 干净结束 →
            // Stop hook 误判为"已完成" → @ 用户。用户反馈这种情况频繁。
            // 检测命中就跳过 @，等真正的"用户任务"完成时下一个 Stop 再走通知。
            if (shouldNotify && agent.sessionId && agent.project) {
              const cwd = String(agent.project).replace(/^~/, process.env.HOME || "~");
              const wakeupPending = await hasRecentScheduleWakeup(cwd, agent.sessionId);
              if (wakeupPending) {
                console.log(`🌀 跳过完成通知（agent 用 ScheduleWakeup 排队下次回调，任务未结束）: channel=${channelId} agent=${agent.name}`);
                shouldNotify = false;
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // 收集所有需要清状态消息的 channel：Stop 的 channelId + 共享同一个 ws 的
      // 其他 channel（master 的 #agent-exchange）+ v1.9.35+ 对称 direct 路由的
      // foreign exchange（那些 channel 不在 clients 里，要从 pendingReplies 的
      // targetWs 匹配反查 intendedReplyChannel）。否则"💭 思考中..."按钮永远
      // 不会变成"✅ 完成"。
      const channelsToClear = new Set<string>([channelId]);
      const thisClientForStatus = clients.get(channelId);
      if (thisClientForStatus) {
        for (const otherId of sameWsChannels(channelId)) {
          channelsToClear.add(otherId);
        }
        for (const [, pending] of pendingReplies.entries()) {
          if (pending.targetWs === thisClientForStatus.ws) {
            channelsToClear.add(pending.intendedReplyChannel);
            stopTyping(pending.intendedReplyChannel);
            clearSafetyTimer(pending.intendedReplyChannel);
          }
        }
      }

      // v1.9.37+: 在"改 ✅ / 发完成通知"前，强制让 watcher 把这条 channel 的
      // jsonl 读干净 + flush pending textQueue。这样 turn 结束的"agent 只打字
      // 不 reply" 场景里，watcher debounce 还没 fire 的 `💬 text` 不会丢，也不
      // 需要再跑一份 rescue 从 jsonl 另外抽一遍（双发源头）。
      // channelsToClear 里每个 channel 都 drain —— direct route + agent-exchange
      // 场景可能 ws 在 master 但 intendedReplyChannel 是别的。
      if (event === "Stop" || event === "StopFailure" || event === "stop") {
        const { drainChannelWatcher } = await import("./bridge/jsonl-watcher.js");
        for (const cid of channelsToClear) {
          try {
            const drainResult = await drainChannelWatcher(cid, discord);
            const drainedText = drainResult.text;

            // Web tee：drain 把残留 tool/text 刷完后，通知 Web 本轮结束。
            pushToWeb(cid, { t: "done" });

            // v2.0.13+ 兜底 1: 本地 send_to_agent caller 在等 push。如果 target 这轮
            // 走了 watcher drain（assistant 文字直接 post 到自己 channel）而**不是**
            // reply()，老 pushback 路径根本不触发 → caller 永远等不到。这里在 Stop
            // drain 之后强制 pushback 一次：
            //   - drain 出了文字 → push 该文字
            //   - drain 没文字（连 assistant text 都没有）→ push 一句 "对方结束了
            //     turn 但没回复"，至少让 caller 不会无限静默等
            const pendingAgent = pendingAgentCalls.get(cid);
            if (pendingAgent) {
              if (!drainedText) {
                // v2.4.16+ no-text 静默清掉 pending，**不 push** 回 caller。
                // 历史上这里 push 一条"[⚠️ 对方没产出，你需要主动追问或换路线]"，
                // 等于积极激励 caller 再发一轮 send_to_agent → target 又没产出
                // → 又一轮 push → 死循环（agent 之间永无止境聊天的根因）。
                // 现在静默：caller 的 send_to_agent promise 不 resolve，caller 早
                // 就 end_turn 了，最多等 staleCleanup 10min 扫掉。caller 没收到推
                // 不会发起新轮 → 链条天然中断，对应"对方没回话就别盯着"的人类直觉。
                pendingAgentCalls.delete(cid);
                console.log(
                  `🤫 drain兜底 no-text 静默清 pending: ${pendingAgent.targetName} → ${pendingAgent.callerName}`
                );
                recordMetric("agent_pushback_drain_silent", {
                  channelId: pendingAgent.callerChannelId,
                  meta: { target: pendingAgent.targetName },
                });
              } else {
                try {
                  const callerCtxLine = pendingAgent.expecting
                    ? `[💡 你之前 send_to_agent 给 ${pendingAgent.targetName} 时填的期望：${pendingAgent.expecting}]\n`
                    : "";
                  const pushBody = `${callerCtxLine}[ℹ️ 对方 (${pendingAgent.targetName}) 这轮没用 reply() 工具，下面是 bridge 从 assistant 文字兜底转发的：]\n\n${drainedText}`;
                  const stopWsClient = clients.get(cid);
                  const replyBackHint = pendingAgent.originalReplyChannel || cid;
                  const drainPushEnv: RouterEnvelope = {
                    from: {
                      kind: "local",
                      agentName: pendingAgent.targetName,
                      channelId: replyBackHint,
                      ws: stopWsClient?.ws ?? pendingAgent.callerWs,
                    },
                    to: {
                      kind: "local",
                      agentName: pendingAgent.callerName,
                      channelId: pendingAgent.callerChannelId,
                      ws: pendingAgent.callerWs,
                    },
                    intent: "response",
                    content: pushBody,
                    meta: {
                      messageId: `agent_drain_${Date.now()}`,
                      triggerKind: "agent_tool",
                      ts: new Date().toISOString(),
                      threadId: newThreadId(),
                    },
                  };
                  await deliver(drainPushEnv);
                  pendingAgentCalls.delete(cid);
                  console.log(`📨 AGENT PUSH-BACK (drain兜底): ${pendingAgent.targetName} → ${pendingAgent.callerName}（drain 文字）`);
                  recordMetric("agent_pushback_drain", { channelId: pendingAgent.callerChannelId, meta: { hadText: "yes" } });
                } catch (e) {
                  console.error("AGENT PUSH-BACK (drain兜底) 失败:", e);
                }
              }
            }

            // v2.0.13+ 兜底 2: 跨 peer 入站请求。peer 的 agent 这轮如果忘了 reply()
            // 到 peer 的 #agent-exchange，watcher drain 把文字贴到 agent **自己** local
            // channel，peer 完全看不见。这里 forward 到 peer 共享频道，让 peer 的
            // bridge 通过 messageCreate 看到 → 老的 pendingPeerCalls pushback 就接力上。
            const peerInbound = pendingPeerInbound.get(cid);
            if (peerInbound) {
              if (!drainedText) {
                // v2.4.16+ 镜像本地 drain兜底：no-text 静默清掉 pending，**不 forward**
                // 到 peer 的 #agent-exchange。之前 forward "[⚠️ ...你那边请主动追问或
                // 换路线]" 等于鼓动 peer 再发一轮 → 跨 peer 死循环（symmetrically 跟
                // 本地一样的问题）。
                pendingPeerInbound.delete(cid);
                console.log(
                  `🤫 PEER INBOUND DRAIN no-text 静默清: ${peerInbound.localAgentName} (peer=${peerInbound.peerBotName})`
                );
                recordMetric("peer_inbound_drain_silent", {
                  channelId: peerInbound.sharedChannelId,
                  meta: { agent: peerInbound.localAgentName },
                });
              } else {
                try {
                  const forwardBody = `[ℹ️ ${peerInbound.localAgentName} 这轮没用 reply() 工具回到 #agent-exchange，下面是 bridge 从 assistant 文字兜底转发的：]\n\n${drainedText}`;
                  await discordReply(discord, peerInbound.sharedChannelId, forwardBody);
                  console.log(`📨 PEER INBOUND DRAIN (兜底): ${peerInbound.localAgentName} → ${peerInbound.sharedChannelId}（forwarded ${drainedText.length} chars）`);
                  recordMetric("peer_inbound_drain", { channelId: peerInbound.sharedChannelId, meta: { agent: peerInbound.localAgentName } });
                  pendingPeerInbound.delete(cid);
                } catch (e) {
                  console.error("PEER INBOUND DRAIN (兜底) 失败:", e);
                }
              }
            }

            // v2.0.16+ inter-agent 看门狗: 这一轮结束时如果 cid 还挂着 inter-agent
            // 消息 pending（agent 既没 reply 也没 send_to_agent —— 大概率收到消息后
            // 啥也没干或没报告），注一条 nudge 到它的 ws 提醒处理 + reply() 报告。
            // v2.4.16+: 最多 nudge **1** 次（之前是 2 次，跟 drain兜底 no-text push
            // 叠加导致 agent 反复 wake-up 抓 LLM turn，是"聊不停"的另一个根因）。
            // 1 次未响应直接放弃，少打扰对面 + 少烧 token。
            const iaPending = pendingInterAgentMsg.get(cid);
            if (iaPending) {
              if (iaPending.retries >= 1) {
                pendingInterAgentMsg.delete(cid);
                console.log(`⚠️ inter-agent 看门狗放弃（${cid} nudge 1 次仍无响应，来自 ${iaPending.fromLabel}）`);
              } else {
                const stopClientForNudge = clients.get(cid);
                if (stopClientForNudge) {
                  try {
                    const nudgeText = [
                      `[ℹ️ 上一轮你收到来自 ${iaPending.fromLabel} 的消息，turn 结束时既没 reply() 也没 send_to_agent。`,
                      `如果你**判断它不需要回应**（比如纯 FYI、已经被你内部处理掉了、对方只是状态同步），end_turn 是 OK 的，这条 nudge 忽略即可。`,
                      `如果是**漏了**：现在补上 reply() 到自己频道告诉用户做了什么；如果是问你的就 send_to_agent 回 ${iaPending.fromLabel}。`,
                      `避免毫无产出地静默 end_turn，但也别为了应付这条 nudge 编一段"我收到了"——那只会污染对话。]`,
                    ].join("\n");
                    // 标记这个 channel 最近一条消息源是 agent/系统，避免 nudge 被处理后
                    // 的 Stop hook 误 @ 用户。
                    lastMessageSource.set(cid, "agent");
                    await deliver({
                      from: { kind: "bridge", label: "ia-watchdog" },
                      to: { kind: "local", channelId: cid, ws: stopClientForNudge.ws, cwd: stopClientForNudge.cwd },
                      intent: "notification",
                      content: nudgeText,
                      meta: {
                        messageId: `ia_nudge_${Date.now()}`,
                        triggerKind: "bridge_synth",
                        ts: new Date().toISOString(),
                        threadId: newThreadId(),
                      },
                    });
                    iaPending.retries += 1;
                    console.log(`📨 inter-agent 看门狗 nudge #${iaPending.retries} → ${cid}（来自 ${iaPending.fromLabel}）`);
                    recordMetric("ia_watchdog_nudge", { channelId: cid, meta: { from: iaPending.fromLabel, retry: String(iaPending.retries) } });
                  } catch (e) {
                    console.error("inter-agent 看门狗 nudge 失败:", e);
                  }
                } else {
                  // agent 的 ws 没了 → 清掉 pending，没法 nudge
                  pendingInterAgentMsg.delete(cid);
                }
              }
            }
          } catch { /* non-critical */ }
        }
      }

      // 清所有 pending*（targetWs 匹配这次 Stop ws 的那些）。watcher drain 完
      // 就不再需要 "pending 挂着等 rescue" 的语义了，留着只会让下次 Stop 误判。
      // 同时 pendingThreads 按 threadId 带 log，知道哪些具体 thread 结束了。
      const stopClientForPending = clients.get(channelId);
      if (stopClientForPending && (event === "Stop" || event === "StopFailure" || event === "stop")) {
        for (const [cid, pending] of pendingReplies.entries()) {
          if (pending.targetWs === stopClientForPending.ws) pendingReplies.delete(cid);
        }
        const closedThreads: string[] = [];
        for (const [tid, t] of pendingThreads.entries()) {
          if (t.targetWs === stopClientForPending.ws) {
            pendingThreads.delete(tid);
            closedThreads.push(tid);
          }
        }
        if (closedThreads.length > 0) {
          console.log(`🧵 Stop 清 pending threads: ${closedThreads.join(", ")} (channel=${channelId})`);
        }
      }

      // 把所有相关 channel 的"💭 思考中..."状态消息改成"✅ 完成"并去掉 interrupt 按钮
      for (const cid of channelsToClear) {
        const statusMsgId = activeStatusMessages.get(cid);
        if (!statusMsgId) continue;
        try {
          const ch = await discord.channels.fetch(cid);
          if (ch && "messages" in ch) {
            const sm = await (ch as TextChannel).messages.fetch(statusMsgId);
            await sm.edit({ content: t("✅ 完成", "✅ Done"), components: [] });
          }
        } catch { /* non-critical */ }
        activeStatusMessages.delete(cid);
      }

      // 发完成通知 @ user（仅 Stop/StopFailure）。watcher 已经把 agent 的消息推
      // 到 Discord 了，这条就是纯"活干完了戳你一下"的 push 通知 —— umadone 短语
      // 不带实质内容，跟 watcher 推的 `💬 text` 不重复。
      if (shouldNotify) {
        try {
          const ch = await discord.channels.fetch(channelId);
          if (ch && "messages" in ch) {
            const textCh = ch as TextChannel;
            const mention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
            if (mention) {
              await textCh.send(`${randomUmaDone()} ${mention}`);
              lastCompletionSent.set(channelId, now);
              console.log(`🏁 完成通知已发送: channel=${channelId}`);
              recordMetric("agent_completed", { channelId });
            }
          }
        } catch (e) {
          console.error(`🏁 完成通知发送失败:`, e);
        }
      }
    }

    return new Response("ok");
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
}

const server = Bun.serve({
  port: BRIDGE_PORT,
  async fetch(req, server) {
    if (server.upgrade(req)) return undefined;

    // Hook HTTP endpoint
    const url = new URL(req.url);
    if (url.pathname === "/hook" && req.method === "POST") {
      return handleHookRequest(req);
    }

    // Skills 重新扫描（manager 在 create/resume/kill 后调）
    if (url.pathname === "/skills/rescan" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          agent?: string;
          cwd?: string;
          action?: "add" | "remove" | "full";
        };
        const action = body.action || "full";
        if (action === "remove" && body.agent) {
          clearProjectSkills(body.agent);
          clearWedgeState(body.agent);
        } else if (action === "add" && body.agent && body.cwd) {
          await scanProjectSkills(body.agent, body.cwd);
        } else {
          // full rescan
          await scanGlobalSkills();
          try {
            const listResult = await runManager("list");
            for (const a of listResult.agents || []) {
              if (a.status === "active" && a.cwd) {
                await scanProjectSkills(a.name, a.cwd);
              } else {
                clearProjectSkills(a.name);
              }
            }
          } catch { /* non-critical */ }
        }
        await registerSlashCommands();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // v2.4.16+ manager kill 后调用 → 清掉所有引用该 channel 的 inter-agent /
    // cross-peer pending。避免被 kill 的 agent 复活/被 resume 后被陈年 pushback /
    // watchdog nudge 轰炸。restart (transient flap) 不调，只在永久 kill 调。
    if (url.pathname === "/agent/cleanup" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { channelId?: string };
        if (!body.channelId) {
          return new Response(JSON.stringify({ ok: false, error: "missing channelId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const n = clearInterAgentPendingsForChannel(body.channelId);
        console.log(`🧹 /agent/cleanup channel=${body.channelId} 清掉 ${n} 条 pending`);
        return new Response(JSON.stringify({ ok: true, cleared: n }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // v1.9.0+: peer-expose / peer-revoke CLI 通过这里触发广播（在 #agent-exchange 发带 PeerEvent 标记的消息）
    if (url.pathname === "/peer/announce" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          kind: "grant" | "revoke";
          local: string;
          peer: string; // peer bot id 或 "all"
          purpose?: string;
          mode?: "direct" | "via_master";
        };
        const { readPeers, encodePeerEvent } = await import("./lib/peers.js");
        const peers = await readPeers();
        if (!peers.localAgentExchangeId) {
          return new Response(JSON.stringify({ ok: false, error: "没找到 #agent-exchange（还没有 peer 加入过？）" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const ch = await discord.channels.fetch(peers.localAgentExchangeId).catch(() => null);
        if (!ch || !("messages" in ch)) {
          return new Response(JSON.stringify({ ok: false, error: "agent-exchange 频道不存在" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const event = encodePeerEvent({
          kind: body.kind,
          local: body.local,
          peer: body.peer,
          purpose: body.purpose,
          exchange: peers.localAgentExchangeId,
          mode: body.mode,
        });
        // 找目标 peer 的 @mention（如果是 "all" 就 @ 所有 peer bot）
        let atMentions = "";
        if (body.peer === "all") {
          atMentions = peers.peerBots.map((p) => `<@${p.id}>`).join(" ");
        } else {
          atMentions = `<@${body.peer}>`;
        }
        const humanMsg =
          body.kind === "grant"
            ? `🤝 **开放 agent**: 我这边 **${body.local}** 对 ${atMentions} 开放${body.purpose ? `（${body.purpose}）` : ""}。可以直接在本频道 @ 我 bot 问这 agent 处理的话题。`
            : `🚫 **撤销**: 我这边 **${body.local}** 对 ${atMentions} 的开放已撤回。`;
        // 走 deliver(bridge → peer)。skipAutoMention=true 因为 atMentions 已经
        // 拼进 content，不走 ensurePeerMentions 避免重复。peerBotId 用 body.peer
        // 或 "all" sentinel（deliverToPeer 不依赖 peerBotId 做实际 @mention，只
        // 用来标注 envelope 的"信任目标"）。
        await deliver({
          from: { kind: "bridge", label: "peer-event" },
          to: {
            kind: "peer",
            peerBotId: body.peer,
            peerBotName: body.peer === "all" ? "all" : (peers.peerBots.find((p) => p.id === body.peer)?.name ?? body.peer),
            sharedChannelId: peers.localAgentExchangeId,
          },
          intent: "broadcast",
          content: `${event}\n${humanMsg}`,
          meta: {
            messageId: `peer_event_${Date.now()}`,
            triggerKind: "bridge_synth",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
            skipAutoMention: true,
          },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ── Web 前端网关（与 Discord 并行的接入面）─────────────────────────
    // Next.js BFF（已鉴权后）server-to-server 调用；浏览器永不直连 3847。

    // 注入一条用户消息给指定会话（channelId 由 BFF 从 registry 解析 agent 得到）。
    if (url.pathname === "/web/inject" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { channelId?: string; text?: string };
        const channelId = body.channelId;
        const text = (body.text || "").trim();
        if (!channelId || !text) {
          return new Response(JSON.stringify({ ok: false, error: "missing channelId/text" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const client = clients.get(channelId);
        if (!client) {
          return new Response(JSON.stringify({ ok: false, error: "session not connected" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        // 直接走 deliver(user→local)：不经 messageCreate，故不发 Discord 的「💭思考中」UI。
        await deliver({
          from: { kind: "user", userId: "web", channelId, username: "web" },
          to: { kind: "local", channelId: client.channelId, ws: client.ws, cwd: client.cwd },
          intent: "request",
          content: text,
          meta: {
            messageId: `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            triggerKind: "user_discord",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
          },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 某会话的持久输出流（SSE）。订阅 web-hub 的 channelId 通道。
    if (url.pathname === "/web/stream" && req.method === "GET") {
      const channelId = url.searchParams.get("channelId");
      if (!channelId) return new Response("missing channelId", { status: 400 });
      const encoder = new TextEncoder();
      let unsub: (() => void) | null = null;
      let hb: ReturnType<typeof setInterval> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: string) => {
            try { controller.enqueue(encoder.encode(`data: ${payload}\n\n`)); } catch { /* closed */ }
          };
          send(JSON.stringify({ t: "status", status: "running" } satisfies WebStreamEvent));
          unsub = subscribeWeb(channelId, (evt) => send(JSON.stringify(evt)));
          hb = setInterval(() => send("[DONE]"), 30000);
          req.signal.addEventListener("abort", () => {
            unsub?.(); if (hb) clearInterval(hb);
            try { controller.close(); } catch { /* already closed */ }
          });
        },
        cancel() { unsub?.(); if (hb) clearInterval(hb); },
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    // ── Web 会话管理（新建 / kill / restart）───────────────────────────
    // 复用 runManager（Bun 进程内直接跑 manager.ts，bun 必在 PATH）。返回 manager
    // 的 JSON 原样透传给 BFF。让 Web 前门真能开门，不用回终端。
    if (url.pathname === "/web/agents" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          name?: string; dir?: string; purpose?: string;
        };
        const name = (body.name || "").trim();
        const dir = (body.dir || "").trim();
        if (!name || !dir) {
          return new Response(JSON.stringify({ ok: false, error: "missing name/dir" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const args = ["create", name, dir];
        if (body.purpose && body.purpose.trim()) args.push(body.purpose.trim());
        const result = await runManager(...args);
        // 新建/kill/restart 后触发 slash 重扫（与 Discord 侧一致，非关键失败可忽略）
        return new Response(JSON.stringify(result), {
          status: result?.ok === false ? 400 : 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (
      (url.pathname === "/web/agents/kill" || url.pathname === "/web/agents/restart") &&
      req.method === "POST"
    ) {
      try {
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        const name = (body.name || "").trim();
        if (!name) {
          return new Response(JSON.stringify({ ok: false, error: "missing name" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const cmd = url.pathname.endsWith("/kill") ? "kill" : "restart";
        const result = await runManager(cmd, name);
        return new Response(JSON.stringify(result), {
          status: result?.ok === false ? 400 : 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Claude Orchestrator Bridge", { status: 200 });
  },
  websocket: {
    // v2.2.0+: 抬高 idleTimeout（Bun 默认 120s）。配合 channel-server 每 25s 的
    // keepalive ping，空闲 agent 的连接不会被关 → 不再 flap。255 是 Bun 上限。
    idleTimeout: 255,
    open(ws) {
      console.log("🔌 新的 channel-server 连接");
    },
    message(ws, message) {
      handleClientMessage(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close(ws) {
      for (const [channelId, info] of clients.entries()) {
        if (info.ws === ws) {
          clients.delete(channelId);
          // 同步兜底：直接按 channelId 在 watcher Map 中查，避免依赖异步 runManager
          stopWatchingByChannel(channelId);
          console.log(`🔌 断开: 频道 ${channelId} (剩余 ${clients.size} 个)`);
        }
      }
    },
  },
});

console.log(`🚀 Bridge WebSocket 启动: ws://localhost:${BRIDGE_PORT}`);

if (!DISCORD_ENABLED) {
  // Web-only 模式：不连 Discord，只跑 HTTP/WS 网关 + 本地会话。
  // discord.once("ready") 回调、shard 看门狗、messageCreate 等都不会触发（未 login）。
  console.warn(
    "⚠️  未设置 DISCORD_BOT_TOKEN — 以 Web-only 模式启动（Discord 前端禁用；仅 Web 网关 + 本地会话编排）",
  );
} else {
  discord.login(DISCORD_TOKEN);
}
