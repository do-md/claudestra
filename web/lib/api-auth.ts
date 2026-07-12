import { timingSafeEqual } from "crypto";
import { getSessionFromCookie } from "@/lib/services/auth.service";

/** 定长安全比较（L5）：避免 === 短路带来的计时侧信道。长度不等直接 false。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 鉴权：外部脚本/skill 走 x-api-key（INTERNAL_API_KEY），其余走 cookie session。
 * 遵循 prin-475132：需被脚本调用的 route 在 handler 层自检 x-api-key，不只依赖 middleware。
 */
export async function isAuthed(request: Request): Promise<boolean> {
  const apiKey = request.headers.get("x-api-key");
  const internalKey = process.env.INTERNAL_API_KEY;
  if (internalKey && apiKey && safeEqual(apiKey, internalKey)) return true;
  return !!(await getSessionFromCookie());
}
