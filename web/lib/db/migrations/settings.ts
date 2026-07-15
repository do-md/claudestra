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
  // 用户个人资料（owner 2026-07-14:设置里自定义头像+昵称,显示在对话里）。
  // 单账号单行表;avatar 是前端压缩后的 data URL(128px jpeg,~15KB),
  // 存库省去文件管理,GET 直出。
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nickname TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  // Skill 快捷入口偏好(owner 2026-07-15:「斜杠太隐蔽,加按钮+管理页」)。
  // pinned=置顶(updated_at 定置顶组内顺序),used_count=使用频次(排序依据)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_prefs (
      name TEXT PRIMARY KEY,
      pinned INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  // Claude 侧也可自定义头像+名称(owner 同日追加)。ALTER 幂等:查列缺才加。
  const cols = (db.prepare("PRAGMA table_info(user_profile)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("claude_nickname")) {
    db.exec("ALTER TABLE user_profile ADD COLUMN claude_nickname TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("claude_avatar")) {
    db.exec("ALTER TABLE user_profile ADD COLUMN claude_avatar TEXT NOT NULL DEFAULT ''");
  }
}
