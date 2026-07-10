import { bridgeGet, MASTER_AGENT_NAME } from "./bridge-api";

export { MASTER_AGENT_NAME };

/**
 * Web 会话 = claudestra 的一个 agent。
 *
 * 2026-07-10 迁移：列表来源从「BFF 直读 registry.json + /web/master」换成
 * Bridge 的 GET /api/v1/agents（token scope 过滤；master 显式列入 scope 时
 * 由 Bridge 置入列表，fork 增强）。BFF 不再碰 registry / 文件系统。
 */
export interface AgentSession {
  /** agent 名，作为会话 id（大总管用保留名 __master__） */
  name: string;
  displayName: string;
  purpose: string;
  cwd: string;
  status: "active" | "stopped";
  /** 大总管置顶入口——不可 kill/restart，列表第一位。 */
  pinnedMaster?: boolean;
  /** 遗留字段（mock 模式已随 /api/v1 迁移移除，恒为 undefined）。 */
  mock?: boolean;
}

interface ApiAgent {
  name: string;
  status?: string;
  idle?: boolean;
  purpose?: string;
}

/**
 * 读取 agent 列表（GET /api/v1/agents）。
 * master（token scope 显式含 "master" 时 Bridge 会置入）映射为置顶的 __master__。
 * Bridge 不可达时抛错（由路由层转成 5xx；不再有 mock 回退）。
 */
export async function loadAgents(): Promise<AgentSession[]> {
  const json = await bridgeGet<{ ok: boolean; agents: ApiAgent[] }>("/agents", {
    timeoutMs: 5000,
  });
  const list = (json.agents || []).map((a): AgentSession => {
    if (a.name === "master") {
      return {
        name: MASTER_AGENT_NAME,
        displayName: "大总管",
        purpose: a.purpose || "调度员：管理/派发多个 agent",
        cwd: "",
        status: a.status === "stopped" ? "stopped" : "active",
        pinnedMaster: true,
      };
    }
    const bare = a.name.replace(/^agent-/, "");
    return {
      name: bare,
      displayName: bare,
      purpose: a.purpose || "",
      cwd: "",
      status: a.status === "stopped" ? "stopped" : "active",
    };
  });
  // master 置顶（Bridge 已 unshift，这里兜底排序）
  return list.sort((a, b) => Number(!!b.pinnedMaster) - Number(!!a.pinnedMaster));
}
