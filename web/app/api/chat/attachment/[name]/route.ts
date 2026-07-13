export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import { isAuthed } from "@/lib/api-auth";

/**
 * 聊天附件取回（2026-07-13 owner：图片要在聊天框里显示/预览/保存,且永久保留）。
 *
 * 附件由 Bridge 落盘（Discord 下载 + web multipart 上传同一目录），BFF 与
 * Bridge 同机直读。2026-07-14 起落盘目录迁到持久位置 ~/.claude-orchestrator/
 * inbox（owner 要求永久保存;旧目录在 /tmp 重启即清）。这里按「持久目录优先、
 * 旧 /tmp 目录兜底」查找——历史消息里的旧文件已一次性迁移,兜底只为万一。
 * 安全：只接受 basename（防穿越），目录白名单固定两个 inbox。
 */

const INBOX_DIRS = [
  `${process.env.HOME}/.claude-orchestrator/inbox`,
  "/tmp/claude-orchestrator/inbox",
];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json",
};

export async function GET(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name } = await ctx.params;
  const safe = basename(decodeURIComponent(name));
  if (!safe || safe.startsWith(".")) {
    return NextResponse.json({ error: "bad name" }, { status: 400 });
  }
  for (const dir of INBOX_DIRS) {
    try {
      const buf = await readFile(join(dir, safe));
      const ext = safe.split(".").pop()?.toLowerCase() || "";
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "Content-Type": MIME[ext] || "application/octet-stream",
          // 文件名带雪花 id 前缀,内容不可变 → 放心长缓存
          "Cache-Control": "private, max-age=604800, immutable",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(safe)}`,
        },
      });
    } catch {
      /* 试下一个目录 */
    }
  }
  return NextResponse.json({ error: "attachment not found" }, { status: 404 });
}
