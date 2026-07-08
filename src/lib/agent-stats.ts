/**
 * Agent 统计数据层（纯本地，无 LLM）
 *
 * 每个 agent 的「上下文大小 / 今日 token / 本周 token」全部从
 * ~/.claude/projects/<slug>/<sessionId>.jsonl 里算出来 —— Claude Code 自己的
 * /status Usage 面板也是 "based on local sessions on this machine"，同一数据源。
 *
 * 账号级的 5h / 周 limit **占比** 不在本地文件里（见 bridge/stats-dashboard.ts 抓
 * /status），所以那部分不在这里，这里只管 per-agent，保持可单测。
 *
 * 性能：每个 JSONL 单遍扫描同时算出 上下文 + 今日 + 本周；并按 (mtime, 日界, 周界)
 * 缓存，只有文件真变了（= 那个刚收尾的 agent）才重读，避免每次 hook 重读 13 个大文件。
 */

import { existsSync, statSync } from "fs";
import { projectJsonlPath, findJsonlBySessionId } from "./jsonl-cost.js";

export interface UsageWindow {
  tokens: number;
  requests: number;
}

export interface AgentStat {
  name: string;
  channelId: string;
  model: string;
  status: string;
  /** 当前会话上下文占用 ≈ 最后一条 assistant 的 input + cacheRead + cacheCreation */
  contextTokens: number;
  contextPct: number; // 相对 CONTEXT_CEILING
  today: UsageWindow;
  week: UsageWindow;
  jsonl: string | null;
}

export interface AgentLike {
  name: string;
  channelId?: string;
  status?: string;
  cwd?: string;
  dir?: string;
  sessionId?: string;
  model?: string;
}

/** 上下文窗口天花板（用于算占比）。会话实测能涨到 ~1M。 */
export const CONTEXT_CEILING = 1_000_000;

/** 今天本地 00:00 的 ms 时间戳 */
export function dayStartTs(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周一本地 00:00 的 ms 时间戳（ISO 周，周一为一周开始） */
export function weekStartTs(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - day);
  return d.getTime();
}

interface FileStats {
  contextTokens: number;
  today: UsageWindow;
  week: UsageWindow;
  /** 最后一条 assistant 实际用的 model（真相），可能跟 registry 钉的不一样 */
  model: string;
}

const fileCache = new Map<string, { key: string; stats: FileStats }>();

/** 单遍扫描一个 JSONL，同时算上下文 + 今日 + 本周；带 (mtime,日界,周界) 缓存 */
async function readFileStats(path: string): Promise<FileStats> {
  const empty: FileStats = {
    contextTokens: 0,
    today: { tokens: 0, requests: 0 },
    week: { tokens: 0, requests: 0 },
    model: "",
  };
  if (!existsSync(path)) return empty;
  const dayTs = dayStartTs();
  const weekTs = weekStartTs();
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return empty; }
  const key = `${mtimeMs}:${dayTs}:${weekTs}`;
  const cached = fileCache.get(path);
  if (cached && cached.key === key) return cached.stats;

  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  const today: UsageWindow = { tokens: 0, requests: 0 };
  const week: UsageWindow = { tokens: 0, requests: 0 };
  let contextTokens = 0;
  let model = "";
  let ctxFound = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "assistant") continue;
    const u = rec?.message?.usage;
    if (!u) continue;
    if (!ctxFound) {
      // 从尾往前第一条带 usage 的 assistant = 当前上下文快照 + 实际在跑的模型
      contextTokens =
        Number(u.input_tokens || 0) +
        Number(u.cache_read_input_tokens || 0) +
        Number(u.cache_creation_input_tokens || 0);
      model = String(rec?.message?.model || "");
      ctxFound = true;
    }
    const ts = new Date(rec.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < weekTs) continue;
    const tok =
      Number(u.input_tokens || 0) +
      Number(u.cache_creation_input_tokens || 0) +
      Number(u.cache_read_input_tokens || 0) +
      Number(u.output_tokens || 0);
    week.tokens += tok;
    week.requests += 1;
    if (ts >= dayTs) {
      today.tokens += tok;
      today.requests += 1;
    }
  }
  const stats: FileStats = { contextTokens, today, week, model };
  fileCache.set(path, { key, stats });
  return stats;
}

function resolveJsonl(agent: AgentLike): string | null {
  const cwd = agent.cwd || agent.dir;
  if (cwd && agent.sessionId) {
    const p = projectJsonlPath(cwd, agent.sessionId);
    if (existsSync(p)) return p;
  }
  if (agent.sessionId) return findJsonlBySessionId(agent.sessionId);
  return null;
}

/** 对一批 agent（通常来自 registry.json）算 per-agent 统计。跳过非 active 的。 */
export async function computeAgentStats(agents: AgentLike[]): Promise<AgentStat[]> {
  const out: AgentStat[] = [];
  for (const a of agents) {
    if (a.status && a.status !== "active") continue;
    const jsonl = resolveJsonl(a);
    const fs = jsonl
      ? await readFileStats(jsonl)
      : { contextTokens: 0, today: { tokens: 0, requests: 0 }, week: { tokens: 0, requests: 0 }, model: "" };
    out.push({
      name: a.name,
      channelId: a.channelId || "",
      // 实际在跑的模型（jsonl 真相）优先；不是正常 claude- 模型（如 <synthetic>）时退回 registry
      model: fs.model.startsWith("claude-") ? fs.model : (a.model || fs.model || "?"),
      status: a.status || "active",
      contextTokens: fs.contextTokens,
      contextPct: Math.min(100, Math.round((fs.contextTokens / CONTEXT_CEILING) * 100)),
      today: fs.today,
      week: fs.week,
      jsonl,
    });
  }
  return out;
}

/** 1234567 → "1.2M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(Math.round(n));
}
