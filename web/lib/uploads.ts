import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { DATA_ROOT } from "./db";

/**
 * 上传文件落盘目录：工作目录 ~/.claude-orchestrator/web/uploads/（不在代码库、不在 /tmp）。
 * owner 要求上传的图片/文件放项目「工作目录」而非代码目录（2026-07-10）。
 *
 * 存法：BFF（fork-only web/）自己收 multipart 存到这里，再把绝对路径注入消息文本发给
 * Bridge——agent 用 Read 打开（channel-server 本就把附件当路径传，图片 Claude Code 能直接看）。
 * 不走 upstream messages 端点的 multipart（那个存 /tmp/claude-orchestrator/inbox），零后端改动。
 */
export const UPLOAD_DIR = path.join(DATA_ROOT, "uploads");

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 与 Bridge multipart 一致
const MAX_FILES = 5;
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif", ".avif",
]);

export interface SavedUpload {
  /** 绝对路径（注入给 agent） */
  path: string;
  /** 原始文件名（展示 / 提示用） */
  name: string;
  kind: "image" | "file";
}

function todayDir(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 取 basename 并清洗成安全文件名（去路径分隔符 + 只留 \w.-）。 */
function sanitize(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
}

/** 保存一批上传文件到工作目录（按天分目录，uuid 前缀防碰撞）。超限抛错。 */
export async function saveUploads(files: File[]): Promise<SavedUpload[]> {
  const picked = files.slice(0, MAX_FILES);
  const dir = path.join(UPLOAD_DIR, todayDir());
  await fs.mkdir(dir, { recursive: true });
  const out: SavedUpload[] = [];
  for (const f of picked) {
    if (f.size > MAX_FILE_BYTES) throw new Error(`文件「${f.name}」超过 10MB`);
    const clean = sanitize(f.name);
    const ext = path.extname(clean).toLowerCase();
    const dest = path.join(dir, `${randomUUID().slice(0, 8)}-${clean}`);
    await fs.writeFile(dest, Buffer.from(await f.arrayBuffer()));
    out.push({ path: dest, name: clean, kind: IMAGE_EXT.has(ext) ? "image" : "file" });
  }
  return out;
}

/** 把已存文件拼成注入消息末尾的附件说明块（绝对路径 + 提示用 Read 查看）。 */
export function attachmentBlock(saved: SavedUpload[]): string {
  if (!saved.length) return "";
  const lines = saved.map((s) => `- ${s.path}`).join("\n");
  return `\n\n[用户上传了 ${saved.length} 个文件（绝对路径，需要时用 Read 工具查看；图片可直接读取查看）:\n${lines}\n]`;
}
