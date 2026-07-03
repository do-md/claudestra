import { getSessionFromCookie } from "@/lib/services/auth.service";

/**
 * 鉴权：外部脚本/skill 走 x-api-key（INTERNAL_API_KEY），其余走 cookie session。
 * 遵循 prin-475132：需被脚本调用的 route 在 handler 层自检 x-api-key，不只依赖 middleware。
 */
export async function isAuthed(request: Request): Promise<boolean> {
  const apiKey = request.headers.get("x-api-key");
  const internalKey = process.env.INTERNAL_API_KEY;
  if (internalKey && apiKey === internalKey) return true;
  return !!(await getSessionFromCookie());
}
