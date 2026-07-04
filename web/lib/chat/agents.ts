import path from "path";
import os from "os";
import fs from "fs";

/** Web 会话 = claudestra 的一个 agent。列表来源：registry.json（真实）或 mock（后端未配时）。 */
export interface AgentSession {
  /** agent 名，作为会话 id */
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  status: "active" | "stopped";
  /** Bridge 侧路由用的 channelId（真实 registry 才有；mock 无）。 */
  channelId?: string;
  /** 是否为 mock 数据（真实 registry 缺失时） */
  mock?: boolean;
  /** 大总管（master orchestrator）置顶入口——不在 registry，靠 CONTROL_CHANNEL_ID；不可 kill/restart。 */
  pinnedMaster?: boolean;
}

/** 大总管的保留会话名（前端 openAgent / 路由用它识别 master）。 */
export const MASTER_AGENT_NAME = "__master__";

const BRIDGE = process.env.BRIDGE_HTTP_URL || "http://localhost:3847";

export interface MasterInfo {
  channelId: string;
  cwd: string;
  sessionId: string | null;
  connected: boolean;
  displayName: string;
}

/**
 * 取大总管信息（channelId + cwd + 当前 sessionId），server 端调 Bridge /web/master。
 * Bridge 无 CONTROL_CHANNEL_ID / 不可达 → 返回 null（前端就不显示大总管入口）。
 */
export async function getMasterInfo(): Promise<MasterInfo | null> {
  try {
    const res = await fetch(`${BRIDGE}/web/master`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { available?: boolean } & MasterInfo;
    if (!j.available || !j.channelId) return null;
    return {
      channelId: j.channelId,
      cwd: j.cwd,
      sessionId: j.sessionId ?? null,
      connected: !!j.connected,
      displayName: j.displayName || "大总管",
    };
  } catch {
    return null;
  }
}

/** 把 MasterInfo 转成置顶的 AgentSession（供 /api/agents 前插）。 */
export function masterAgentSession(m: MasterInfo): AgentSession {
  return {
    name: MASTER_AGENT_NAME,
    displayName: m.displayName,
    purpose: "调度员：管理/派发多个 agent",
    cwd: m.cwd,
    status: m.connected ? "active" : "stopped",
    channelId: m.channelId,
    pinnedMaster: true,
  };
}

const REGISTRY_PATH = path.join(
  process.env.CLAUDESTRA_REGISTRY_PATH ||
    path.join(os.homedir(), ".claude-orchestrator"),
  "registry.json"
);

const MOCK_AGENTS: AgentSession[] = [
  {
    name: "worker-alpha",
    displayName: "worker-alpha",
    purpose: "示例会话（mock）——后端配好后此处显示真实 agent",
    cwd: "~/code/project-a",
    status: "active",
    mock: true,
  },
  {
    name: "worker-bravo",
    displayName: "worker-bravo",
    purpose: "示例会话（mock）",
    cwd: "~/code/project-b",
    status: "active",
    mock: true,
  },
  {
    name: "worker-charlie",
    displayName: "worker-charlie",
    purpose: "示例会话（mock，已停止）",
    cwd: "~/code/project-c",
    status: "stopped",
    mock: true,
  },
];

interface RegistryAgentInfo {
  project?: string;
  purpose?: string;
  status?: "active" | "stopped";
  cwd?: string;
  displayName?: string;
  channelId?: string;
  sessionId?: string;
}

/** 一个 agent 的会话定位信息（供历史加载定位 jsonl）。 */
export interface AgentSessionRef {
  channelId?: string;
  sessionId?: string;
  cwd?: string;
}

/** 读取 agent 列表。registry.json 存在则用真实数据，否则回退 mock。 */
export function loadAgents(): AgentSession[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const reg = JSON.parse(raw) as {
      agents?: Record<string, RegistryAgentInfo>;
    };
    const entries = Object.entries(reg.agents ?? {});
    if (entries.length === 0) return MOCK_AGENTS;
    return entries.map(([key, info]) => {
      // registry key 形如 "agent-<name>"
      const name = key.replace(/^agent-/, "");
      return {
        name,
        displayName: info.displayName || name,
        purpose: info.purpose || "",
        cwd: info.cwd || info.project || "",
        status: info.status === "stopped" ? "stopped" : "active",
        channelId: info.channelId,
      };
    });
  } catch {
    return MOCK_AGENTS;
  }
}

/** 解析 agent 名 → Bridge channelId。找不到（含 mock）返回 null。 */
export function resolveChannelId(agentName: string): string | null {
  const agent = loadAgents().find((a) => a.name === agentName);
  return agent?.channelId ?? null;
}

/**
 * 解析 agent 名 → 会话定位信息（channelId + sessionId + cwd），供历史加载读 jsonl。
 * 直接读 registry（不经 loadAgents 的 mock 回退），mock/缺失返回 null。
 */
export function resolveSession(agentName: string): AgentSessionRef | null {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const reg = JSON.parse(raw) as {
      agents?: Record<string, RegistryAgentInfo>;
    };
    const info =
      reg.agents?.[`agent-${agentName}`] ?? reg.agents?.[agentName];
    if (!info) return null;
    return {
      channelId: info.channelId,
      sessionId: info.sessionId,
      cwd: info.cwd || info.project,
    };
  } catch {
    return null;
  }
}
