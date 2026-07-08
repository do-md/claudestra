/**
 * v2.6.0+ 多前端身份与授权（设计 docs/design-multi-frontend.md §3.4）。
 *
 * principal = transport-scoped 身份：
 *   discord:<userId>   owner / Discord 用户（现阶段 Discord 主链路鉴权仍走
 *                      ALLOWED_USER_IDS，这里只登记，便于未来统一）
 *   token:<tokenId>    HTTP API 用户（Phase B 的主角）
 *   telegram:<userId>  future
 *
 * 授权模型：
 *   - agents 白名单："*" = 全部普通 agent；master 必须显式列名
 *   - role: "owner" 才有管理能力（v1 管理面不进 API，字段先留位）
 *   - token 的 secret 只在创建时返回一次完整值
 *
 * ⚠️ 共享上下文风险（R1）：token scope 只控制"能不能跟 agent 说话"，管不了
 * agent 上下文里已有什么。CLI 会对未标 external 的 agent 要求 --force。
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export interface Principal {
  /** 统一形态："token:tok_xxx" / "discord:<uid>" / "telegram:<uid>" */
  id: string;
  /** owner = 全能力；external = 只有会话权（默认） */
  role: "owner" | "external";
  /** 人类可读名（token 必填，进 agent 看到的 header） */
  name?: string;
  /** agent 白名单。"*" = 全部普通 agent（不含 master，master 需显式） */
  agents: string[];
  /** 仅 token: 类有。Bearer 鉴权用的 secret（hex）。 */
  secret?: string;
  disabled?: boolean;
  createdAt: string;
  /** R2 审计镜像开关（默认 true = API 对话镜像到 agent 的 Discord 频道） */
  mirror?: boolean;
}

export interface PrincipalsFile {
  principals: Principal[];
}

const CONFIG_DIR = join(homedir(), ".claude-orchestrator");
export const PRINCIPALS_PATH = join(CONFIG_DIR, "principals.json");

export async function readPrincipals(path = PRINCIPALS_PATH): Promise<PrincipalsFile> {
  try {
    if (!existsSync(path)) return { principals: [] };
    const data = JSON.parse(await readFile(path, "utf-8"));
    if (!Array.isArray(data.principals)) return { principals: [] };
    return data as PrincipalsFile;
  } catch {
    return { principals: [] };
  }
}

export async function writePrincipals(data: PrincipalsFile, path = PRINCIPALS_PATH): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  try { await chmod(path, 0o600); } catch { /* best-effort */ }
}

/** 生成一个新 token principal（不落盘，调用方决定何时 write） */
export function newTokenPrincipal(name: string, agents: string[]): Principal {
  const tokenId = `tok_${randomBytes(4).toString("hex")}`;
  return {
    id: `token:${tokenId}`,
    role: "external",
    name,
    agents,
    secret: randomBytes(32).toString("hex"),
    disabled: false,
    createdAt: new Date().toISOString(),
    mirror: true,
  };
}

/** token principal 的短 id（"token:tok_xxx" → "tok_xxx"） */
export function tokenIdOf(p: Principal): string {
  return p.id.startsWith("token:") ? p.id.slice(6) : p.id;
}

/** Bearer secret → principal（禁用的不算） */
export function findByBearer(file: PrincipalsFile, secret: string): Principal | null {
  if (!secret) return null;
  const p = file.principals.find(
    (x) => x.id.startsWith("token:") && x.secret === secret && !x.disabled,
  );
  return p ?? null;
}

/** 按 token 短 id 或 name 找（CLI revoke/show 用） */
export function findToken(file: PrincipalsFile, idOrName: string): Principal | null {
  return (
    file.principals.find(
      (x) => x.id === `token:${idOrName}` || x.id === idOrName ||
             (x.id.startsWith("token:") && x.name === idOrName),
    ) ?? null
  );
}

/**
 * scope 检查。registry 名带 "agent-" 前缀（如 "agent-worker"），token 里可能
 * 存的是用户输入的裸名（"worker"）—— 双向兼容（与 peers.ts exposures 同款）。
 * "*" 只覆盖普通 agent；master（含 "master" 本名）必须显式列出。
 */
export function agentInScope(p: Principal, agentName: string): boolean {
  if (p.disabled) return false;
  const isMaster = agentName === "master";
  for (const a of p.agents) {
    if (a === "*") {
      if (!isMaster) return true;
      continue;
    }
    if (a === agentName || `agent-${a}` === agentName || a === `agent-${agentName}`) return true;
  }
  return false;
}

/**
 * 内存滑动窗口限流（纯逻辑，可测）。默认 30 次 / 60s。
 * bridge 每个 principal 一个实例；重启清零（可接受）。
 */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
  ) {}

  /** 记一次调用。true = 放行，false = 超限 */
  tryAcquire(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** 当前窗口内已用次数（诊断用） */
  used(now = Date.now()): number {
    const cutoff = now - this.windowMs;
    return this.hits.filter((t) => t > cutoff).length;
  }
}
