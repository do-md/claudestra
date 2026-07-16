import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import webpush from "web-push";

/**
 * VAPID 密钥对——原生 Web Push 的服务端身份(owner 2026-07-16「做 pwa 推送」,
 * 选型:自托管 VAPID 而非 OneSignal,零第三方注册零外部依赖)。
 * 首次访问自动生成并落盘 ~/.claude-orchestrator/web/push-vapid.json,之后复用
 * ——换密钥会让所有既有订阅失效,所以必须持久化。
 */

const DATA_ROOT = process.env.CLAUDESTRA_DATA_ROOT || join(homedir(), ".claude-orchestrator", "web");
const VAPID_FILE = join(DATA_ROOT, "push-vapid.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;
let applied = false;

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;
  if (existsSync(VAPID_FILE)) {
    cached = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as VapidKeys;
  } else {
    cached = webpush.generateVAPIDKeys();
    mkdirSync(DATA_ROOT, { recursive: true });
    writeFileSync(VAPID_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
  }
  return cached;
}

/** 给 web-push 应用 VAPID 身份(幂等)。subject 用占位 mailto(规范要求非空)。 */
export function ensureVapid(): VapidKeys {
  const keys = getVapidKeys();
  if (!applied) {
    webpush.setVapidDetails("mailto:push@claudestra.local", keys.publicKey, keys.privateKey);
    applied = true;
  }
  return keys;
}
