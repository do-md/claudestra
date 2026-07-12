import type Database from "better-sqlite3";

/**
 * per-agent 前端配置。当前只有 init_message：clear 会话后自动发送的「开机指令」。
 *
 * 这是**用户层**的数据——Claudestra 产品（bridge/manager）对它零感知：clear 端点
 * 只做原生 /clear，开机指令由前端在 clear 成功后作为普通消息发出（可见、可审计）。
 * 知识注入（如项目图谱加载）藏在指令文本里，产品不知道图谱的存在。
 */
export function runSettingsMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      agent TEXT PRIMARY KEY,
      init_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
}
