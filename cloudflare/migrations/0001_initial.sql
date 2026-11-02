-- 「课研」SQLite schema v1
-- 设计说明：
-- * 所有主键使用 TEXT(UUID)，时间使用 ISO-8601 文本，便于后续迁移到 Postgres。
-- * 不依赖 SQLite 专有 FTS；搜索使用 LIKE，P1 可平滑切换 pg_trgm。
-- * 原始课件文件永不入库，只保存提取后的文本与 Markdown。

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  nickname_key  TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  password_hash TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_courses_user_updated
  ON courses (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id                TEXT PRIMARY KEY,
  course_id         TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  source_filename   TEXT NOT NULL,
  raw_text          TEXT NOT NULL DEFAULT '',
  markdown_content  TEXT NOT NULL DEFAULT '',
  summary           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing', 'done', 'failed')),
  engine            TEXT CHECK (engine IN ('ai', 'local-fallback') OR engine IS NULL),
  error_message     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_course_created
  ON notes (course_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_notes_status
  ON notes (status);

CREATE TABLE IF NOT EXISTS upload_queue (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processing', 'failed')),
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_queue_status
  ON upload_queue (status, created_at ASC);

CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
ALTER TABLE upload_queue ADD COLUMN generation_state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE upload_queue ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;
