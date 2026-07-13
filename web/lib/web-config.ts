import { mkdir, readFile, writeFile } from "fs/promises";

/**
 * Web 前端的服务端配置（2026-07-14 owner：API key 要有地方在界面上填）。
 * 存 ~/.claude-orchestrator/web/config.json（与 web SQLite 同根,持久),
 * 不进 git、不进 .env(env 改了要重启 dev server,文件读取即时生效)。
 */

const DIR = `${process.env.HOME}/.claude-orchestrator/web`;
const FILE = `${DIR}/config.json`;

export interface WebConfig {
  /** Groq API key（语音转写用;界面可配） */
  groqApiKey?: string;
}

export async function readWebConfig(): Promise<WebConfig> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as WebConfig;
  } catch {
    return {};
  }
}

export async function writeWebConfig(patch: Partial<WebConfig>): Promise<WebConfig> {
  const cur = await readWebConfig();
  const next: WebConfig = { ...cur, ...patch };
  // 空字符串语义 = 清除该项
  for (const k of Object.keys(next) as (keyof WebConfig)[]) {
    if (next[k] === "") delete next[k];
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2));
  return next;
}
