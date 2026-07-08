/**
 * 只读用量看板（v2.4.25+）
 *
 * 一个只读频道（📊-claudestra-stats）里常驻一条 embed 消息，每次「对话完成」hook 就
 * 编辑它 —— 走消息编辑限流（~5/5s per channel），几乎不受限，避开了改 topic 那条严格的
 * 2 次/10min。数据两块：
 *   - per-agent（上下文 / 模型 / 今日·本周 token）：本地 JSONL 即时算（agent-stats.ts）
 *   - 账号级 5h/周 limit 占比：抓 /status 面板（慢变化，缓存 3min，惰性由 hook 触发刷新）
 *
 * 同一份快照另开 `GET /stats` JSON 接口，给以后的 Web 端。
 */

import {
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type TextChannel,
} from "discord.js";
import { existsSync } from "fs";
import { tmuxRaw, MASTER_SESSION } from "../lib/tmux-helper.js";
import { readConfig, setStatsDashboard } from "../lib/config-store.js";
import { discordCreateChannel } from "./discord-api.js";
import {
  computeAgentStats,
  formatTokens,
  type AgentStat,
  type AgentLike,
} from "../lib/agent-stats.js";

const DASHBOARD_CHANNEL_NAME = "📊-claudestra-stats";
const ACCOUNT_TTL_MS = 3 * 60 * 1000; // 账号级 %，慢变化，3min 才重抓
const DEBOUNCE_MS = 3000; // 合并瞬时连发的多个 hook
const TICK_MS = 10 * 60 * 1000; // 低频兜底：挂机没 hook 时也刷一次，反映 5h/周 limit 重置

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AccountUsage {
  sessionPct: number | null;
  sessionResets: string;
  weekPct: number | null;
  weekResets: string;
  totalCost: string | null;
  apiDuration: string | null;
  /** 去掉进度条字符后的 Usage 面板原文（保底：Web 端要什么都能再解析） */
  raw: string;
  scrapedAt: number;
}

export interface StatsSnapshot {
  global: AccountUsage | null;
  agents: AgentStat[];
  updatedAt: number;
}

// ── 账号级 /status 抓取 ────────────────────────────────────────────────

let accountCache: AccountUsage | null = null;
let scraping: Promise<AccountUsage | null> | null = null;

function parseUsagePanel(raw: string): AccountUsage {
  const lines = raw.split("\n");
  let sessionPct: number | null = null;
  let sessionResets = "";
  let weekPct: number | null = null;
  let weekResets = "";
  for (let i = 0; i < lines.length; i++) {
    const anchor = /Current session/.test(lines[i])
      ? "session"
      : /Current week/.test(lines[i])
        ? "week"
        : null;
    if (!anchor) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const pm = lines[j].match(/(\d+)%\s*used/);
      const rm = lines[j].match(/Resets\s+(.+?)\s*$/);
      if (anchor === "session") {
        if (pm && sessionPct === null) sessionPct = Number(pm[1]);
        if (rm && !sessionResets) sessionResets = rm[1].trim();
      } else {
        if (pm && weekPct === null) weekPct = Number(pm[1]);
        if (rm && !weekResets) weekResets = rm[1].trim();
      }
    }
  }
  const cost = raw.match(/Total cost:\s*\$([\d.,]+)/);
  const durApi = raw.match(/Total duration \(API\):\s*([^\n]+)/);
  // raw 只留 Usage 面板本身（capture -S -80 会带进上方的对话 scrollback，切掉）
  let startIdx = lines.findIndex((l) => /Settings\s+Status\s+Config\s+Usage/.test(l));
  if (startIdx < 0) startIdx = lines.findIndex((l) => /^\s*Session\s*$/.test(l));
  if (startIdx < 0) startIdx = 0;
  const cleaned = lines
    .slice(startIdx)
    .filter((l) => l.trim() && !/^[\s█▉▊▋▌▍▎▏░▓]+$/.test(l))
    .map((l) => l.replace(/[█▉▊▋▌▍▎▏░▓]+/g, "").replace(/\s+$/, ""))
    .join("\n");
  return {
    sessionPct,
    sessionResets,
    weekPct,
    weekResets,
    totalCost: cost ? cost[1] : null,
    apiDuration: durApi ? durApi[1].trim() : null,
    raw: cleaned.slice(0, 3500),
    scrapedAt: Date.now(),
  };
}

/**
 * 驱动 master:0 的 /status，确定性导航到 Usage tab，抓 session/week 占比。
 * master 忙就返回 null（用旧缓存）。全程本地、不调用 LLM。
 */
function paneIdle(pane: string): boolean {
  return /❯/.test(pane) && !/esc to interrupt/.test(pane);
}

/**
 * 挑一个 idle 的 Claude 会话来抓 /status。账号 5h/周 gauge 是**全局**的（"all models"、
 * 固定 reset 时间），任何会话读都一样，所以不必非得读 master。之前固定读 master:0，
 * 但 master 作为大总管常年在忙 → idle 守卫每次 bail → gauge 永远冻结。优先 master，
 * 它忙就退回任意 idle agent 窗口（通常刚跑完 hook 的那个就是 idle 的）。
 */
async function findIdleScrapeTarget(): Promise<string | null> {
  const candidates: string[] = [`${MASTER_SESSION}:0`];
  const wins = (await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"]).catch(() => ""))
    .split("\n")
    .filter((w) => w.startsWith("agent-"));
  candidates.push(...wins.map((w) => `${MASTER_SESSION}:${w}`));
  for (const t of candidates) {
    const pane = await tmuxRaw(["capture-pane", "-t", t, "-p"]).catch(() => "");
    if (paneIdle(pane)) return t;
  }
  return null;
}

async function scrapeAccountUsage(): Promise<AccountUsage | null> {
  const target = await findIdleScrapeTarget();
  if (!target) return null; // 没有任何 idle 会话可借，下次再说（沿用旧缓存）
  try {
    await tmuxRaw(["send-keys", "-t", target, "-l", "/status"]);
    await sleep(150);
    await tmuxRaw(["send-keys", "-t", target, "Enter"]);
    await sleep(500);

    let panel = "";
    let found = false;
    for (let i = 0; i < 6; i++) {
      panel = await tmuxRaw(["capture-pane", "-t", target, "-p", "-S", "-80"]).catch(() => "");
      if (/Current session/.test(panel) && /%\s*used/.test(panel)) {
        found = true;
        break;
      }
      // 还没到 Usage tab：右移一格，给足渲染时间再判断（避免过冲）
      await tmuxRaw(["send-keys", "-t", target, "Right"]);
      await sleep(300);
    }
    // 关闭面板恢复会话
    await tmuxRaw(["send-keys", "-t", target, "Escape"]);
    await sleep(80);
    await tmuxRaw(["send-keys", "-t", target, "Escape"]);
    if (!found) return null;
    const usage = parseUsagePanel(panel);
    console.log(`📊 账号用量已刷新: session=${usage.sessionPct}% week=${usage.weekPct}% (via ${target})`);
    return usage;
  } catch (e) {
    console.error("📊 /status 抓取失败:", (e as Error).message);
    try {
      await tmuxRaw(["send-keys", "-t", target, "Escape"]);
      await tmuxRaw(["send-keys", "-t", target, "Escape"]);
    } catch {}
    return null;
  }
}

/**
 * 带 TTL 缓存 + in-flight 去重的账号用量获取。抓不到就沿用旧缓存。
 * 关键：整个抓取套一层超时 —— 万一某次 tmux/osascript 卡住，`scraping` 也会在超时后
 * 复位，绝不会永久卡住让 gauge 冻结（这是之前 6h 不更新的根源之一）。
 */
async function getAccountUsage(): Promise<AccountUsage | null> {
  if (accountCache && Date.now() - accountCache.scrapedAt < ACCOUNT_TTL_MS) return accountCache;
  if (scraping) return scraping;
  scraping = Promise.race([
    scrapeAccountUsage(),
    new Promise<null>((r) => setTimeout(() => r(null), 15000)),
  ])
    .then((u) => {
      if (u) accountCache = u;
      return accountCache;
    })
    .catch(() => accountCache)
    .finally(() => {
      scraping = null;
    });
  return scraping;
}

// ── 快照组装 ───────────────────────────────────────────────────────────

async function listAgents(): Promise<AgentLike[]> {
  const p = `${process.env.HOME}/.claude-orchestrator/registry.json`;
  if (!existsSync(p)) return [];
  try {
    const reg = (await Bun.file(p).json()) as { agents?: Record<string, any> };
    return Object.entries(reg.agents || {}).map(([name, v]) => ({ name, ...(v as object) }));
  } catch {
    return [];
  }
}

export async function buildSnapshot(): Promise<StatsSnapshot> {
  const [agents, global] = await Promise.all([
    listAgents().then((list) => computeAgentStats(list)),
    getAccountUsage(),
  ]);
  agents.sort((a, b) => b.contextTokens - a.contextTokens);
  return { global, agents, updatedAt: Date.now() };
}

// ── Discord 渲染 ───────────────────────────────────────────────────────

function fmtResets(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim(); // 去掉尾部 (Asia/Singapore)
}

function bar(pct: number | null, w = 10): string {
  if (pct == null) return "?".padEnd(w + 4);
  const f = Math.round((Math.min(100, pct) / 100) * w);
  return "▰".repeat(f) + "▱".repeat(w - f) + ` ${String(pct).padStart(3)}%`;
}

// 预警阈值（%）。上下文占用：≥75 该 compact 了；账号 limit：≥80 快撞墙。
const CTX_YELLOW = 50, CTX_RED = 75;
const LIMIT_YELLOW = 50, LIMIT_RED = 80;

function ctxDot(pct: number): string {
  return pct >= CTX_RED ? "🔴" : pct >= CTX_YELLOW ? "🟡" : "🟢";
}
function limitDot(pct: number | null): string {
  if (pct == null) return "⚪";
  return pct >= LIMIT_RED ? "🔴" : pct >= LIMIT_YELLOW ? "🟡" : "🟢";
}
/** embed 左侧边框色跟最严重的账号 limit 走：绿/黄/红 */
function limitColor(pct: number | null): number {
  if (pct == null) return 0x5865f2;
  return pct >= LIMIT_RED ? 0xed4245 : pct >= LIMIT_YELLOW ? 0xfee75c : 0x57f287;
}

/**
 * 用 Discord 原生 embed 字段渲染，而不是等宽代码块表格 ——
 * 代码块在窄手机屏（~33 字符）会硬折行、把列冲乱。原生字段全宽堆叠、按文字自然换行，
 * 还能用 emoji。每个 agent 一个非 inline 字段：名字前用颜色点表示上下文占用预警
 * （🟢正常 / 🟡偏高 / 🔴该 compact），value 行放模型 + 今日/本周。账号级 limit 两条
 * 进度条放在 description，也各带颜色点，边框色跟最严重的 limit 走。
 */
function renderEmbed(snap: StatsSnapshot): EmbedBuilder {
  const g = snap.global;
  const desc: string[] = ["**🌐 账号 limit（所有 agent 共享）**"];
  let worstLimit: number | null = null;
  if (g && (g.sessionPct != null || g.weekPct != null)) {
    worstLimit = Math.max(g.sessionPct ?? 0, g.weekPct ?? 0);
    desc.push(`⏱ 5h　${limitDot(g.sessionPct)} ${bar(g.sessionPct, 8)}${g.sessionResets ? "　⟳ " + fmtResets(g.sessionResets) : ""}`);
    desc.push(`📆 周　${limitDot(g.weekPct)} ${bar(g.weekPct, 8)}${g.weekResets ? "　⟳ " + fmtResets(g.weekResets) : ""}`);
  } else {
    desc.push("_（/status 抓取中 / master 忙，下次对话完成时刷新）_");
  }
  desc.push("_🟢 正常 · 🟡 偏高 · 🔴 需注意（点=上下文占用 / 前缀=limit）_");

  const emb = new EmbedBuilder()
    .setTitle("📊 Claudestra 用量看板")
    .setColor(limitColor(worstLimit))
    .setDescription(desc.join("\n"))
    .setFooter({ text: "本地 JSONL + /status · 每次对话完成自动更新" })
    .setTimestamp(new Date(snap.updatedAt));

  for (const a of snap.agents.slice(0, 24)) {
    const name = a.name.replace(/^agent-/, "");
    emb.addFields({
      name: `${ctxDot(a.contextPct)} ${name} · 📖 ${formatTokens(a.contextTokens)} ${a.contextPct}%`,
      value: `${a.model.replace(/^claude-/, "")} · 今 ${formatTokens(a.today.tokens)} · 周 ${formatTokens(a.week.tokens)}`,
      inline: false,
    });
  }
  return emb;
}

// ── 频道 / 消息 保障 ───────────────────────────────────────────────────

async function ensureChannel(discord: Client): Promise<string | null> {
  const cfg = await readConfig();
  if (cfg.statsDashboard?.channelId) {
    const ch = await discord.channels.fetch(cfg.statsDashboard.channelId).catch(() => null);
    if (ch) return cfg.statsDashboard.channelId;
  }
  // 复用 discordCreateChannel（带 peer-deny），再把 @everyone 设成不可发言（只读）
  try {
    const chId = await discordCreateChannel(discord, DASHBOARD_CHANNEL_NAME);
    const ch = (await discord.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch && ch.guild) {
      await ch.permissionOverwrites
        .edit(ch.guild.roles.everyone, { SendMessages: false, AddReactions: false })
        .catch(() => {});
      await ch.setTopic("Claudestra 实时用量看板（只读，自动更新）").catch(() => {});
    }
    await setStatsDashboard(chId, "");
    console.log(`📊 已创建用量看板频道: ${chId}`);
    return chId;
  } catch (e) {
    console.error("📊 创建看板频道失败:", (e as Error).message);
    return null;
  }
}

/** 看板消息底部的「🔄 刷新」按钮（点了强制立即刷新，绕过账号 gauge 的 3min 缓存）。 */
function refreshRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("stats_refresh").setLabel("🔄 刷新").setStyle(ButtonStyle.Secondary),
  );
}

async function ensureMessage(discord: Client, channelId: string, embed: EmbedBuilder): Promise<string | null> {
  const ch = (await discord.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!ch || !("send" in ch)) return null;
  const payload = { embeds: [embed], components: [refreshRow()] };
  const cfg = await readConfig();
  const existingId = cfg.statsDashboard?.messageId;
  if (existingId) {
    const msg = await ch.messages.fetch(existingId).catch(() => null);
    if (msg) {
      await msg.edit(payload);
      return existingId;
    }
  }
  const msg = await ch.send(payload);
  await setStatsDashboard(channelId, msg.id);
  return msg.id;
}

// ── 对外：更新 / 初始化 / HTTP ─────────────────────────────────────────

let debTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending = false;

async function doUpdate(discord: Client): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const snap = await buildSnapshot();
    const channelId = await ensureChannel(discord);
    if (!channelId) return;
    await ensureMessage(discord, channelId, renderEmbed(snap));
  } catch (e) {
    console.error("📊 看板更新失败:", (e as Error).message);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      void doUpdate(discord);
    }
  }
}

/** 看板「🔄 刷新」按钮：强制刷新账号 gauge（清缓存年龄）+ 立即重渲染。 */
export async function forceRefreshStatsDashboard(discord: Client): Promise<void> {
  if (accountCache) accountCache.scrapedAt = 0; // 让下次 getAccountUsage 强制重抓
  await doUpdate(discord);
}

/** 每次「对话完成」hook 调这个（防抖合并瞬时连发）。 */
export function updateStatsDashboard(discord: Client): void {
  if (debTimer) return;
  debTimer = setTimeout(() => {
    debTimer = null;
    void doUpdate(discord);
  }, DEBOUNCE_MS);
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 启动时确保频道 + 消息存在，刷一次，并起一个低频兜底 tick。 */
export async function initStatsDashboard(discord: Client): Promise<void> {
  try {
    await doUpdate(discord);
  } catch (e) {
    console.error("📊 看板初始化失败:", (e as Error).message);
  }
  // 低频兜底：主更新仍是「对话完成」hook，但挂机、没任何 hook 时账号 5h/周 limit 的
  // 重置就反映不出来。这个 tick 每 10min 刷一次补上（doUpdate 内部有 running 锁 + 账号
  // 抓取自带 TTL/超时，不会跟 hook 更新打架）。
  if (!tickTimer) tickTimer = setInterval(() => void doUpdate(discord), TICK_MS);
}

/** GET /stats —— 开放 JSON 接口，给 Web 端。 */
export async function handleStatsRequest(): Promise<Response> {
  try {
    const snap = await buildSnapshot();
    return new Response(JSON.stringify(snap, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
