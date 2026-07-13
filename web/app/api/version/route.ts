export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";

/**
 * 版本信息（Splash 底部署名用）。version 取仓库根 package.json（Claudestra
 * 版本；web 自己的 0.1.0 无意义），commit 每次现取——owner 2026-07-13：
 * 「不一定每次改动都发版，所以加一个 Commit ID」,dev 常驻进程用构建时注入
 * 会陈旧。无鉴权：非敏感元数据,且 Splash 在登录态确立前就要显示。
 */

let cache: { version: string; commit: string; at: number } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 30_000) {
    return NextResponse.json({ version: cache.version, commit: cache.commit });
  }
  let version = "";
  try {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "..", "package.json"), "utf8")) as {
      version?: string;
    };
    version = pkg.version ?? "";
  } catch {
    /* 根 package.json 读不到就只显示 commit */
  }
  const commit = await new Promise<string>((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }, (e, out) =>
      resolve(e ? "" : out.trim())
    );
  });
  cache = { version, commit, at: Date.now() };
  return NextResponse.json({ version, commit });
}
