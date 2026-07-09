/**
 * v2.8+ bg 活动追踪 —— subagent / 后台 shell 任务的发现 + 子区流式呈现。
 *
 * 两类后台活动（都归属于某个注册 agent 的当前 session）：
 *   - subagent：Claude Code 把每个 Agent 工具调用的对话独立落盘在
 *     ~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl，与主会话同格式
 *   - 后台 shell（run_in_background Bash）：实时输出写在
 *     /tmp/claude-<uid>/<slug>/<sessionId>/tasks/<taskId>.output 纯文本
 *
 * 呈现：每个活动在 owner agent 的主会话下开一个「子会话」（ChatAdapter.provisionThread，
 * Discord = thread 子区），把工具调用 / 文本 / shell 输出流进去，结束发总结 + 归档。
 * 主频道零污染。全程 transport 中立：adapter 没有 provisionThread 能力就只发事件。
 *
 * 事件：bg_task_started / bg_task_update / bg_task_completed（SSE 同步可见，
 * web 前端可以不依赖 Discord 自行渲染进度线）。
 *
 * 结束判定（v1 务实策略）：文件连续 IDLE_DONE_MS 不增长 → 视为结束。subagent
 * 没有权威的"完成"落盘标记，等主 session 的 tool_result 匹配过于耦合；display
 * 通道晚归档几分钟无伤大雅。
 *
 * 重启防重放：启动后第一轮 poll 只记 baseline（已存在的文件全部标记 seen 不开流），
 * 之后只对新出现的文件开活动 —— bridge 重启不会把历史 subagent 全部重播一遍。
 */

import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { projectsSlug } from "../lib/jsonl-cost.js";
import { adapterFor, type ChatAdapter } from "./adapters.js";
import { parseChatId } from "./router.js";
import { emitEvent } from "./event-bus.js";
import { formatTool } from "./jsonl-watcher.js";
import { recordMetric } from "../lib/metrics.js";

const POLL_MS = 10_000;
const FLUSH_MS = 2_500; // 子区推送 debounce（Discord 限速友好）
const IDLE_DONE_MS = 3 * 60_000; // 文件 3min 不增长 → 活动结束
const MAX_MSG_LEN = 1900;
const MAX_ACTIVE_PER_AGENT = 8; // 防 thread 轰炸（workflow 大扇出时超出的只发事件）
const MAX_TEXT_PER_ITEM = 400; // subagent 单条文本进子区的截断长度

export type BgActivityKind = "subagent" | "shell";

interface Activity {
  key: string; // 全局唯一（文件路径）
  kind: BgActivityKind;
  agentName: string;
  ownerChatId: string;
  filePath: string;
  threadId: string | null; // 建 thread 失败 → null，只发事件
  adapter: ChatAdapter | null;
  offset: number; // 已消费字节
  lastGrowth: number;
  startedAt: number;
  queue: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  eventCount: number;
  finished: boolean;
}

interface AgentLite {
  name: string;
  channelId: string;
  cwd: string;
  sessionId: string;
}

const activities = new Map<string, Activity>();
/** 见过的文件（含 baseline + 已结束的），防重复开流 */
const seen = new Set<string>();
let baselined = false;

// ── 目录定位 ───────────────────────────────────────────────────────────

function subagentsDirFor(cwd: string, sessionId: string): string {
  return join(
    process.env.HOME || "~", ".claude", "projects", projectsSlug(cwd), sessionId, "subagents",
  );
}

function shellTasksDirFor(cwd: string, sessionId: string): string {
  // Claude Code 的 session scratchpad 根：/tmp/claude-<uid>/<slug>/<sessionId>/
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join("/tmp", `claude-${uid}`, projectsSlug(cwd), sessionId, "tasks");
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(suffix)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function readRegistryAgents(): Promise<AgentLite[]> {
  const p = `${process.env.HOME}/.claude-orchestrator/registry.json`;
  if (!existsSync(p)) return [];
  try {
    const reg = (await Bun.file(p).json()) as { agents?: Record<string, any> };
    return Object.entries(reg.agents || {})
      .filter(([, a]) => a?.status === "active" && a?.channelId && a?.sessionId && (a?.cwd || a?.dir))
      .map(([name, a]) => ({
        name,
        channelId: String(a.channelId),
        cwd: String(a.cwd || a.dir),
        sessionId: String(a.sessionId),
      }));
  } catch {
    return [];
  }
}

// ── 活动生命周期 ───────────────────────────────────────────────────────

function activeCountFor(agentName: string): number {
  let n = 0;
  for (const a of activities.values()) if (a.agentName === agentName && !a.finished) n++;
  return n;
}

function titleFor(kind: BgActivityKind, filePath: string): string {
  const base = basename(filePath).replace(/\.(jsonl|output)$/, "");
  return kind === "subagent" ? `🤖 subagent ${base.replace(/^agent-/, "").slice(0, 20)}` : `🐚 bg shell ${base}`;
}

async function startActivity(
  kind: BgActivityKind,
  agent: AgentLite,
  filePath: string,
): Promise<void> {
  seen.add(filePath);
  const title = titleFor(kind, filePath);
  const { transport } = parseChatId(agent.channelId);
  const adapter = adapterFor(transport);

  let threadId: string | null = null;
  if (adapter?.provisionThread && activeCountFor(agent.name) < MAX_ACTIVE_PER_AGENT) {
    try {
      const r = await adapter.provisionThread(agent.channelId, title);
      threadId = r.chatId;
    } catch (e) {
      console.error(`🧵 建子区失败 (${agent.name} ${title}):`, (e as Error).message);
    }
  }

  const act: Activity = {
    key: filePath,
    kind,
    agentName: agent.name,
    ownerChatId: agent.channelId,
    filePath,
    threadId,
    adapter,
    offset: 0,
    lastGrowth: Date.now(),
    startedAt: Date.now(),
    queue: [],
    flushTimer: null,
    eventCount: 0,
    finished: false,
  };
  activities.set(filePath, act);
  console.log(`🧵 bg 活动开始: ${agent.name} ${title}${threadId ? ` → thread ${threadId}` : "（无子区，仅事件）"}`);
  recordMetric("bg_activity_started", { agent: agent.name, meta: { kind } });
  emitEvent({
    agent: agent.name,
    chatId: agent.channelId,
    type: "bg_task_started",
    data: { kind, file: filePath, threadId, title },
  });
}

/** 消费一个活动文件的新增字节，渲染进 queue */
async function consume(act: Activity): Promise<void> {
  let size = 0;
  try {
    size = (await stat(act.filePath)).size;
  } catch {
    // 文件消失（session 清理）→ 直接收尾
    await finalize(act, "文件已消失");
    return;
  }
  if (size <= act.offset) return;
  const chunk = await Bun.file(act.filePath).slice(act.offset, size).text();
  act.offset = size;
  act.lastGrowth = Date.now();

  if (act.kind === "shell") {
    for (const line of chunk.split("\n")) {
      if (line.trim()) act.queue.push(line.slice(0, 300));
    }
  } else {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "assistant") continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && b.name) {
          act.queue.push(`-# 🔧 ${formatTool(b.name, b.input)}`);
          act.eventCount++;
        } else if (b?.type === "text" && b.text?.trim()) {
          const t = b.text.trim();
          act.queue.push(`💬 ${t.length > MAX_TEXT_PER_ITEM ? t.slice(0, MAX_TEXT_PER_ITEM) + "…" : t}`);
          act.eventCount++;
        }
      }
    }
  }
  if (act.queue.length && !act.flushTimer) {
    act.flushTimer = setTimeout(() => void flush(act), FLUSH_MS);
  }
}

async function flush(act: Activity): Promise<void> {
  if (act.flushTimer) {
    clearTimeout(act.flushTimer);
    act.flushTimer = null;
  }
  if (!act.queue.length) return;
  const lines = act.queue.splice(0, act.queue.length);
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_update",
    data: { kind: act.kind, file: act.filePath, lines: lines.length, threadId: act.threadId },
  });
  if (!act.threadId || !act.adapter) return;

  // shell 输出裹代码块；subagent 行本身已带 markdown 前缀
  let text = lines.join("\n");
  if (act.kind === "shell") text = "```\n" + text + "\n```";
  // 超长只保尾部（display 通道，最新进展 > 完整性；完整内容在源文件里）
  if (text.length > MAX_MSG_LEN) {
    text = (act.kind === "shell" ? "```\n…" : "…") + text.slice(-MAX_MSG_LEN + 40) + (act.kind === "shell" ? "" : "");
  }
  try {
    await act.adapter.send(act.threadId, { text });
  } catch (e) {
    console.error(`🧵 子区推送失败 (${act.agentName}):`, (e as Error).message);
  }
}

async function finalize(act: Activity, reason = "结束"): Promise<void> {
  if (act.finished) return;
  act.finished = true;
  await flush(act).catch(() => {});
  activities.delete(act.key);
  const mins = ((Date.now() - act.startedAt) / 60_000).toFixed(1);
  console.log(`🧵 bg 活动结束: ${act.agentName} ${basename(act.filePath)}（${mins}min, ${reason}）`);
  recordMetric("bg_activity_completed", { agent: act.agentName, meta: { kind: act.kind } });
  emitEvent({
    agent: act.agentName,
    chatId: act.ownerChatId,
    type: "bg_task_completed",
    data: { kind: act.kind, file: act.filePath, threadId: act.threadId, durationMs: Date.now() - act.startedAt },
  });
  if (act.threadId && act.adapter) {
    try {
      await act.adapter.send(act.threadId, {
        text: `✅ ${act.kind === "subagent" ? "subagent 结束" : "后台任务结束"} · ${mins}min${act.eventCount ? ` · ${act.eventCount} 条动态` : ""}`,
      });
      await act.adapter.archiveThread?.(act.threadId);
    } catch { /* non-critical */ }
  }
}

// ── 主循环 ─────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const agents = await readRegistryAgents();
  const first = !baselined;
  baselined = true;

  for (const agent of agents) {
    const subFiles = await listFiles(subagentsDirFor(agent.cwd, agent.sessionId), ".jsonl");
    const shellFiles = await listFiles(shellTasksDirFor(agent.cwd, agent.sessionId), ".output");
    for (const [kind, files] of [["subagent", subFiles], ["shell", shellFiles]] as const) {
      for (const f of files) {
        if (seen.has(f)) continue;
        if (first) {
          seen.add(f); // baseline：存量文件不重播
          continue;
        }
        await startActivity(kind, agent, f).catch((e) =>
          console.error(`🧵 bg 活动启动失败 (${agent.name}):`, (e as Error).message),
        );
      }
    }
  }

  // 消费 + 结束判定
  for (const act of [...activities.values()]) {
    await consume(act).catch(() => {});
    if (!act.finished && Date.now() - act.lastGrowth > IDLE_DONE_MS) {
      await finalize(act).catch(() => {});
    }
  }
}

export function startBgActivityWatcher(): void {
  setInterval(() => void tick().catch(() => {}), POLL_MS);
  void tick().catch(() => {}); // 立即 baseline，避免启动后第一批新文件被当存量
  console.log(`🧵 bg 活动追踪启动（每 ${POLL_MS / 1000}s 扫 subagents + bg shell tasks）`);
}

/** 测试/诊断：当前活跃活动数 */
export function activeBgActivities(): number {
  return activities.size;
}
