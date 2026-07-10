/**
 * v2.9+ 归档每日兜底 —— session-archive 只在会话退役时触发（kill / fork 换代 /
 * adopt / resume 替换）；这里每天对所有 active agent 补一次快照（copyIfLarger
 * 幂等，无变化零成本），把「bridge 崩溃 / 断电导致退役归档没跑」以及「长寿
 * session 从未退役过」的丢档窗口也堵上。
 */

import { readActiveAgents } from "../lib/registry.js";
import { archiveSession } from "../lib/session-archive.js";

const SWEEP_MS = 24 * 3600_000;
const FIRST_DELAY_MS = 10 * 60_000; // 启动 10min 后跑首轮，避开 bridge 启动风暴

export async function sweepArchives(): Promise<{ agents: number; archived: number }> {
  const agents = await readActiveAgents();
  let archived = 0;
  for (const a of agents) {
    if (!a.sessionId) continue;
    const r = await archiveSession(a.name, a.cwd, a.sessionId).catch(() => null);
    if (r?.archived.length) archived += r.archived.length;
  }
  console.log(`🗄 归档兜底扫描: ${agents.length} agents, 新增/更新 ${archived} 个文件`);
  return { agents: agents.length, archived };
}

export function startArchiveSweeper(): void {
  setTimeout(() => {
    void sweepArchives().catch(() => {});
    setInterval(() => void sweepArchives().catch(() => {}), SWEEP_MS);
  }, FIRST_DELAY_MS);
  console.log("🗄 归档每日兜底启动（首轮 10min 后，此后每 24h）");
}
