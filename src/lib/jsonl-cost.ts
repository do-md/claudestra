/**
 * JSONL 会话文件 → token 用量 rollup
 *
 * Claude Code 把每轮对话写到 ~/.claude/projects/<slug>/<sessionId>.jsonl。
 * 每条 assistant 消息带 `usage: { input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens }`。按 model 分类累加。
 */

import { existsSync, readdirSync, realpathSync } from "fs";

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  requests: number;
}

export interface ModelUsage extends Usage {
  model: string;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0 };
}

function addUsage(acc: Usage, u: any): void {
  if (!u) return;
  acc.input += Number(u.input_tokens || 0);
  acc.cacheCreation += Number(u.cache_creation_input_tokens || 0);
  acc.cacheRead += Number(u.cache_read_input_tokens || 0);
  acc.output += Number(u.output_tokens || 0);
  acc.requests += 1;
}

/**
 * 解析一个 JSONL 文件，按 model 分桶返回用量。
 * 可选 sinceTs（ms）只统计晚于该时间戳的记录。
 */
export async function rollupJsonl(path: string, sinceTs = 0): Promise<ModelUsage[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const buckets = new Map<string, Usage>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "assistant") continue;
    if (sinceTs > 0) {
      const ts = new Date(rec.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < sinceTs) continue;
    }
    const model = rec?.message?.model || "unknown";
    const usage = rec?.message?.usage;
    if (!usage) continue;
    const acc = buckets.get(model) || emptyUsage();
    addUsage(acc, usage);
    buckets.set(model, acc);
  }
  return [...buckets.entries()].map(([model, u]) => ({ model, ...u }));
}

/**
 * cwd → Claude Code projects 目录 slug（"-" + 去掉开头 / 后把 / 换成 -）。
 *
 * ⚠️ 必须先 realpath：Claude Code 是按解析符号链接后的 cwd 算 slug 的。
 * macOS 上 /tmp → /private/tmp，注册 cwd=/tmp 的 agent 实际 jsonl 落在
 * -private-tmp/，不 resolve 的话 watcher 会盯着永远不存在的 -tmp/ 目录
 * （2026-07-09 agent-temp 实例：流式输出全程静默）。
 */
export function projectsSlug(cwd: string): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    /* 目录已不存在 → 按原样算，让上层走 findJsonlBySessionId 兜底 */
  }
  return "-" + resolved.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * 根据项目 slug 自动推 JSONL 路径。
 */
export function projectJsonlPath(cwd: string, sessionId: string): string {
  return `${process.env.HOME}/.claude/projects/${projectsSlug(cwd)}/${sessionId}.jsonl`;
}

/** 兜底：如果上面的路径不存在，遍历 projects 子目录找 session */
export function findJsonlBySessionId(sessionId: string): string | null {
  const root = `${process.env.HOME}/.claude/projects`;
  if (!existsSync(root)) return null;
  let slugs: string[] = [];
  try { slugs = readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const p = `${root}/${slug}/${sessionId}.jsonl`;
    if (existsSync(p)) return p;
  }
  return null;
}

/** 合并多条 ModelUsage（跨 agent sum） */
export function mergeByModel(rows: ModelUsage[]): ModelUsage[] {
  const m = new Map<string, Usage>();
  for (const r of rows) {
    const acc = m.get(r.model) || emptyUsage();
    acc.input += r.input;
    acc.cacheCreation += r.cacheCreation;
    acc.cacheRead += r.cacheRead;
    acc.output += r.output;
    acc.requests += r.requests;
    m.set(r.model, acc);
  }
  return [...m.entries()].map(([model, u]) => ({ model, ...u }));
}
