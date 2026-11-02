import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './logger.js';

let db;

export function initDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  // 迁移机制：v2 增加密码哈希和服务端会话。后续表结构变化时按 user_version 递增执行迁移脚本，
  // 保持列类型/约束可映射到 Postgres（TEXT UUID + timestamptz + enum check）。
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    db.exec('BEGIN');
    try {
      db.exec(schema);
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    logger.info('db', `初始化数据库 ${config.dbPath}`);
  } else if (version > 2) {
    throw new Error(`数据库版本 ${version} 高于当前程序支持的版本 2`);
  }

  if (version < 2) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN password_hash TEXT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      PRAGMA user_version = 2;
      COMMIT;`);
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // 数据库已关闭时无需处理。
  }
  db = undefined;
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId() {
  return crypto.randomUUID();
}

export function lowKey(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

export function touchCourse(courseId, at = nowIso()) {
  getDb()
    .prepare('UPDATE courses SET updated_at = ? WHERE id = ?')
    .run(at, courseId);
}

export function withTransaction(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // 保留原始异常，回滚失败不覆盖错误原因。
    }
    throw err;
  }
}

export function isUniqueViolation(err) {
  const message = String(err?.message || '');
  return message.includes('UNIQUE constraint failed') || err?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function courseOwnedBy(courseId, userId) {
  return getDb()
    .prepare('SELECT * FROM courses WHERE id = ? AND user_id = ?')
    .get(courseId, userId);
}

export function noteOwnedBy(noteId, userId) {
  return getDb()
    .prepare(
      `SELECT n.*, c.user_id AS owner_user_id, c.name AS course_name
       FROM notes n JOIN courses c ON c.id = n.course_id
       WHERE n.id = ? AND c.user_id = ?`,
    )
    .get(noteId, userId);
}

export function deleteFileQuiet(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    logger.warn('files', `删除临时文件失败：${filePath}`, err.message);
  }
}
