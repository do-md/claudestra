import { getDb } from "../db";
import { nanoid } from "nanoid";
import { Client } from "ssh2";
import { cookies } from "next/headers";
import type { Session } from "../types";

export const SESSION_COOKIE = "cstra_session";
const SESSION_DAYS = 7;

// ---- SSH/PAM authentication ----
// 通过连接本机 SSH 服务校验账号密码（等价 PAM）。成功即视为鉴权通过。

export function verifySSH(
  username: string,
  password: string,
  host = "127.0.0.1",
  port = 22
): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.end();
        resolve(true);
      })
      .on("error", () => {
        resolve(false);
      })
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 5000,
      });
  });
}

// ---- Rate limiting (in-memory) ----

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

// ---- Session ----

export function createSession(username: string): Session {
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session: Session = {
    id: nanoid(32),
    username,
    expires_at: expires.toISOString(),
    created_at: now.toISOString(),
  };
  db.prepare(
    `INSERT INTO sessions (id, username, expires_at, created_at)
     VALUES (@id, @username, @expires_at, @created_at)`
  ).run(session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
    .get(sessionId, new Date().toISOString()) as Session | undefined;
}

export function deleteSession(sessionId: string) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

// ---- Cookie helpers ----

export async function getSessionFromCookie(): Promise<Session | undefined> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value;
  if (!sessionId) return undefined;
  return getSession(sessionId);
}
