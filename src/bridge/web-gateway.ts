/**
 * v2.10+ Web 前端网关件 —— docs/web-frontend-guide.md §7 三堵墙中的两堵：
 * CORS 与静态托管。纯函数（可单测），接线在 bridge.ts 的 Bun.serve fetch：
 * OPTIONS preflight 短路 → 正常路由 → 响应统一补 CORS 头 → 未匹配 GET 落静态。
 *
 * 两者都默认关闭（环境变量不设 = 行为与 v2.9 完全一致）：
 *   BRIDGE_CORS_ORIGIN  逗号分隔 origin 白名单，或 "*"
 *   BRIDGE_STATIC_DIR   要托管的静态目录（SPA 前端构建产物）
 */

import { existsSync, statSync } from "fs";
import { join, normalize, resolve } from "path";

/**
 * 按白名单算这次请求该发的 CORS 头。返回 null = 不发（未开启 / origin 不在名单）。
 * 白名单精确匹配 origin 字符串（如 "http://localhost:5173"）；"*" 允许任意。
 */
export function corsHeadersFor(
  reqOrigin: string | null,
  allowSetting: string,
): Record<string, string> | null {
  const allowed = (allowSetting || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return null;
  let origin: string | null = null;
  if (allowed.includes("*")) origin = "*";
  else if (reqOrigin && allowed.includes(reqOrigin)) origin = reqOrigin;
  if (!origin) return null;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*") headers["Vary"] = "Origin";
  return headers;
}

/**
 * 静态文件路径解析：穿越防护 + SPA fallback。
 * - 命中真实文件 → 绝对路径
 * - 路径不存在且不像资源文件（最后一段无扩展名）→ index.html（前端路由 fallback）
 * - 穿越出 root / 资源文件缺失 / root 未设 → null（调用方 404）
 */
export function resolveStaticPath(rootDir: string, pathname: string): string | null {
  if (!rootDir) return null;
  const root = resolve(rootDir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // 非法 %-编码
  }
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + "/")) return null; // ../ 穿越
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  } catch {
    return null;
  }
  // 资源文件（.js/.css/.png…）缺失就该 404，不能回 index.html 造成诡异的 MIME 错误
  const lastSeg = rel.split("/").pop() || "";
  if (lastSeg.includes(".")) return null;
  const index = join(root, "index.html");
  return existsSync(index) ? index : null;
}
