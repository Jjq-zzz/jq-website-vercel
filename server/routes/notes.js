import express from 'express';
import { getDb, nowIso, touchCourse, noteOwnedBy, deleteFileQuiet } from '../db.js';
import { noteQueue } from '../queue.js';
import { requireUser } from './auth.js';
import {
  HttpError,
  asyncHandler,
  contentDisposition,
  noteMarkdownForDownload,
  safeExportName,
} from '../utils.js';

export const notesRouter = express.Router();
notesRouter.use(requireUser);

function publicNote(row) {
  return {
    id: row.id,
    title: row.title,
    sourceFilename: row.source_filename,
    summary: row.summary || '',
    markdownContent: row.markdown_content || '',
    status: row.status,
    engine: row.engine || null,
    errorMessage: row.error_message || null,
    canRetry: row.status === 'failed' && Boolean(row.raw_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

notesRouter.get(
  '/:noteId',
  asyncHandler(async (req, res) => {
    const row = noteOwnedBy(req.params.noteId, req.user.id);
    if (!row) throw new HttpError(404, 'NOTE_NOT_FOUND', '笔记不存在');
    const siblings = getDb()
      .prepare(
        `SELECT id, title, status FROM notes WHERE course_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(row.course_id);
    res.json({
      note: publicNote(row),
      course: { id: row.course_id, name: row.course_name },
      siblings: siblings.map((item) => ({ id: item.id, title: item.title, status: item.status })),
    });
  }),
);

notesRouter.get(
  '/:noteId/download',
  asyncHandler(async (req, res) => {
    const row = noteOwnedBy(req.params.noteId, req.user.id);
    if (!row) throw new HttpError(404, 'NOTE_NOT_FOUND', '笔记不存在');
    if (row.status !== 'done') {
      throw new HttpError(409, 'NOTE_NOT_READY', row.status === 'failed' ? '这篇笔记处理失败，暂不能下载' : '笔记还在整理中');
    }
    const markdown = noteMarkdownForDownload(row);
    const filename = `${safeExportName(row.title, '笔记')}.md`;
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', contentDisposition(filename));
    res.send(markdown);
  }),
);

notesRouter.delete(
  '/:noteId',
  asyncHandler(async (req, res) => {
    const row = noteOwnedBy(req.params.noteId, req.user.id);
    if (!row) throw new HttpError(404, 'NOTE_NOT_FOUND', '笔记不存在');
    const queue = getDb().prepare('SELECT file_path FROM upload_queue WHERE note_id = ?').get(row.id);
    noteQueue.cancel(row.id);
    getDb().prepare('DELETE FROM notes WHERE id = ?').run(row.id);
    deleteFileQuiet(queue?.file_path);
    touchCourse(row.course_id);
    res.status(204).end();
  }),
);

notesRouter.post(
  '/:noteId/retry',
  asyncHandler(async (req, res) => {
    const row = noteOwnedBy(req.params.noteId, req.user.id);
    if (!row) throw new HttpError(404, 'NOTE_NOT_FOUND', '笔记不存在');
    if (row.status !== 'failed') {
      throw new HttpError(409, 'NOTE_NOT_FAILED', '只有处理失败的笔记可以重试');
    }

    const queue = getDb()
      .prepare('SELECT * FROM upload_queue WHERE note_id = ?')
      .get(row.id);
    if (!queue || !row.raw_text) {
      throw new HttpError(409, 'FILE_EXPIRED', '没有可重试的课件文本，原始文件已按隐私策略删除，请重新上传');
    }
    deleteFileQuiet(queue.file_path);

    const at = nowIso();
    getDb().prepare(
      `UPDATE notes SET status = 'processing', attempts = 0, error_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(at, row.id);
    getDb().prepare(
      `UPDATE upload_queue SET status = 'queued', file_path = '', retry_count = 0, error_message = NULL, updated_at = ?
       WHERE note_id = ?`,
    ).run(at, row.id);
    touchCourse(row.course_id, at);
    noteQueue.enqueue(row.id, { front: true });

    res.status(202).json({
      note: { id: row.id, title: row.title, status: 'processing' },
    });
  }),
);

// P1 扩展点：
// - PUT /:noteId          手动编辑 Markdown（需 version 字段做乐观锁）
// - GET /:noteId/mindmap  生成 mermaid 思维导图（复用 raw_text / markdown_content）
// - POST /:noteId/quiz    根据笔记生成练习题
// - POST /courses/:id/share 分享只读链接（新增 share_tokens 表）
