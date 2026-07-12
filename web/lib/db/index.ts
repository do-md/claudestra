import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { runAuthMigrations } from "./migrations/auth";
import { runSettingsMigrations } from "./migrations/settings";

/**
 * Claudestra Web 数据根目录。与编排器状态同处 ~/.claude-orchestrator/ 下的 web/ 子目录，
 * 避免和 claude-os 的 ~/.claude-os 数据混淆。可用 CLAUDESTRA_DATA_ROOT 覆盖。
 */
export const DATA_ROOT = path.join(
  process.env.CLAUDESTRA_DATA_ROOT ||
    path.join(os.homedir(), ".claude-orchestrator"),
  "web"
);
export const DB_DIR = path.join(DATA_ROOT, "db");

const dbCache = new Map<string, Database.Database>();

const migrations: Record<string, (db: Database.Database) => void> = {
  auth: runAuthMigrations,
  settings: runSettingsMigrations,
};

export function getDb(name = "auth"): Database.Database {
  let db = dbCache.get(name);
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(path.join(DB_DIR, `${name}.db`));
    db.pragma("journal_mode = WAL");
    migrations[name]?.(db);
    dbCache.set(name, db);
  }
  return db;
}
