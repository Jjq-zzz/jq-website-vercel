import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { unsupportedFormatMessage } from '../../shared/file-formats.js';
import {
  getDb,
  nowIso,
  randomId,
  touchCourse,
  withTransaction,
  isUniqueViolation,
  courseOwnedBy,
  deleteFileQuiet,
} from '../db.js';
import { logger } from '../logger.js';
import { noteQueue } from '../queue.js';
import { extractZip } from '../parsers/zip.js';
import { requireUser } from './auth.js';
import {
  HttpError,
  asyncHandler,
  basenameOf,
  contentDisposition,
  decodeUploadName,
  extensionOf,
  normalizeTitle,
  noteMarkdownForDownload,
  safeExportName,
  supportedKind,
  titleFromFilename,
  truncateForLog,
} from '../utils.js';

export const coursesRouter = express.Router();
coursesRouter.use(requireUser);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      fsSync.mkdirSync(config.tmpDir, { recursive: true });
      cb(null, config.tmpDir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    cb(null, `upload-${Date.now()}-${crypto.randomUUID()}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.maxFileSize,
    files: config.maxFilesPerUpload,
    fields: 10,
  },
});

function publicCourse(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    noteCount: Number(row.note_count ?? 0),
    doneCount: Number(row.done_count ?? 0),
    processingCount: Number(row.processing_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
  };
}

function courseWithStats(courseId, userId) {
  const row = getDb()
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id) AS note_count,
        (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'processing') AS processing_count,
        (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'failed') AS failed_count
       FROM courses c WHERE c.id = ? AND c.user_id = ?`,
    )
    .get(courseId, userId);
  return row ? publicCourse(row) : null;
}

function publicNoteSummary(row) {
  return {
    id: row.id,
    title: row.title,
    sourceFilename: row.source_filename,
    summary: row.summary || '',
    status: row.status,
    engine: row.engine || null,
    errorMessage: row.error_message || null,
    canRetry: row.status === 'failed' && Boolean(row.raw_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureCourse(req) {
  const course = courseOwnedBy(req.params.courseId, req.user.id);
  if (!course) throw new HttpError(404, 'COURSE_NOT_FOUND', '课程不存在');
  return course;
}

async function cleanupFiles(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
}

async function moveIntoUploads(sourcePath, filename) {
  const ext = extensionOf(filename);
  const target = path.join(config.uploadsDir, `note-${crypto.randomUUID()}${ext}`);
  try {
    await fs.rename(sourcePath, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.copyFile(sourcePath, target);
      await fs.unlink(sourcePath).catch(() => {});
    } else {
      throw err;
    }
  }
  return target;
}

function insertQueuedNote({ courseId, title, sourceFilename, filePath }) {
  const db = getDb();
  const noteId = randomId();
  const queueId = randomId();
  const at = nowIso();
  withTransaction(() => {
    db.prepare(
      `INSERT INTO notes (id, course_id, title, source_filename, raw_text, markdown_content, summary,
         status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', '', 'processing', 0, ?, ?)`,
    ).run(noteId, courseId, title, sourceFilename, at, at);
    db.prepare(
      `INSERT INTO upload_queue (id, note_id, file_path, retry_count, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'queued', ?, ?)`,
    ).run(queueId, noteId, filePath, at, at);
    touchCourse(courseId, at);
  });
  return { id: noteId, noteId, title, sourceFilename, status: 'processing' };
}

// ---------- 课程 CRUD ----------

coursesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT c.*,
          (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id) AS note_count,
          (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'done') AS done_count,
          (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'processing') AS processing_count,
          (SELECT COUNT(*) FROM notes n WHERE n.course_id = c.id AND n.status = 'failed') AS failed_count
         FROM courses c WHERE c.user_id = ?
         ORDER BY c.updated_at DESC, c.created_at DESC`,
      )
      .all(req.user.id);
    res.json({ courses: rows.map(publicCourse) });
  }),
);

coursesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = normalizeTitle(req.body?.name, 40);
    if (!name) throw new HttpError(400, 'INVALID_COURSE_NAME', '请输入课程名');
    const at = nowIso();
    const id = randomId();
    try {
      getDb()
        .prepare('INSERT INTO courses (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, req.user.id, name, at, at);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(409, 'DUPLICATE_COURSE', '已经有同名课程了');
      }
      throw err;
    }
    res.status(201).json({ course: courseWithStats(id, req.user.id) });
  }),
);

coursesRouter.patch(
  '/:courseId',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const name = normalizeTitle(req.body?.name, 40);
    if (!name) throw new HttpError(400, 'INVALID_COURSE_NAME', '请输入课程名');
    try {
      getDb()
        .prepare('UPDATE courses SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, nowIso(), course.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'DUPLICATE_COURSE', '已经有同名课程了');
      throw err;
    }
    res.json({ course: courseWithStats(course.id, req.user.id) });
  }),
);

coursesRouter.delete(
  '/:courseId',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const noteIds = getDb().prepare('SELECT id FROM notes WHERE course_id = ?').all(course.id);
    for (const note of noteIds) noteQueue.cancel(note.id);
    const paths = getDb()
      .prepare('SELECT q.file_path FROM upload_queue q JOIN notes n ON n.id = q.note_id WHERE n.course_id = ?')
      .all(course.id)
      .map((row) => row.file_path)
      .filter(Boolean);
    getDb().prepare('DELETE FROM courses WHERE id = ?').run(course.id);
    await Promise.all(paths.map((filePath) => fs.unlink(filePath).catch(() => {})));
    res.status(204).end();
  }),
);

// ---------- 课程详情 ----------

coursesRouter.get(
  '/:courseId',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const notes = getDb()
      .prepare('SELECT * FROM notes WHERE course_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(course.id);
    res.json({
      course: {
        id: course.id,
        name: course.name,
        createdAt: course.created_at,
        updatedAt: course.updated_at,
      },
      notes: notes.map(publicNoteSummary),
    });
  }),
);

// ---------- 批量上传 ----------

coursesRouter.post(
  '/:courseId/files',
  upload.array('files', config.maxFilesPerUpload),
  asyncHandler(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    let course;
    try {
      course = ensureCourse(req);
    } catch (err) {
      await cleanupFiles(files);
      throw err;
    }
    if (!files.length) throw new HttpError(400, 'NO_FILES', '请选择要上传的课件');

    const accepted = [];
    const skipped = [];
    const extractedPaths = [];

    try {
      for (const file of files) {
        const originalName = decodeUploadName(file.originalname);
        const kind = supportedKind(originalName);
        const ext = extensionOf(originalName);

        if (!kind) {
          skipped.push({ name: basenameOf(originalName) || '未命名文件', reason: unsupportedFormatMessage(originalName) });
          continue;
        }

        if (kind === 'zip') {
          try {
            const expansion = await extractZip(file.path, config.uploadsDir, {
              maxFiles: config.maxFilesFromZip,
              maxBytes: config.maxZipExtractBytes,
            });
            skipped.push(...expansion.skipped);
            if (!expansion.files.length) {
              skipped.push({ name: basenameOf(originalName), reason: '压缩包内没有支持的办公文档、电子书或文本文件' });
            }
            for (const entry of expansion.files) {
              extractedPaths.push(entry.path);
              try {
                const created = insertQueuedNote({
                  courseId: course.id,
                  title: titleFromFilename(entry.originalName),
                  sourceFilename: entry.originalName,
                  filePath: entry.path,
                });
                accepted.push(created);
              } catch (err) {
                logger.error('upload', `ZIP 内文件入队失败 ${entry.originalName}：${err.message}`);
                deleteFileQuiet(entry.path);
                skipped.push({ name: entry.originalName, reason: '写入队列失败，请单独重试' });
              }
            }
          } catch (err) {
            logger.error('upload', `ZIP 解压失败《${originalName}》：${err.message}`);
            skipped.push({ name: basenameOf(originalName), reason: err.message || 'ZIP 解压失败' });
          } finally {
            deleteFileQuiet(file.path);
          }
          continue;
        }

        // 单文件：先移动到私有上传目录，再创建 processing 笔记 + 队列记录。
        let storedPath;
        try {
          storedPath = await moveIntoUploads(file.path, originalName);
          extractedPaths.push(storedPath);
          const created = insertQueuedNote({
            courseId: course.id,
            title: titleFromFilename(originalName),
            sourceFilename: basenameOf(originalName),
            filePath: storedPath,
          });
          accepted.push(created);
        } catch (err) {
          logger.error('upload', `文件入队失败《${originalName}》：${err.message}`);
          skipped.push({ name: basenameOf(originalName), reason: '写入队列失败，请稍后重试' });
          if (storedPath) deleteFileQuiet(storedPath);
        }
      }
    } finally {
      // multer 原文件：已移动的路径不存在，未处理的（不支持格式）会被清掉。
      await cleanupFiles(files);
    }

    if (!accepted.length) {
      const reason = skipped.map((item) => `${item.name}：${item.reason}`).join('；');
      const error = new HttpError(
        400,
        'NO_SUPPORTED_FILES',
        reason ? `没有可处理的课件。${truncateForLog(reason, 300)}` : '没有可处理的课件',
      );
      error.details = { skipped };
      throw error;
    }

    // 只把任务放进内存队列，接口立即返回；前端通过 /queue 轮询进度。
    for (const note of accepted) noteQueue.enqueue(note.noteId);
    logger.info(
      'upload',
      `已接收 ${accepted.length} 个课件到《${course.name}》| 跳过 ${skipped.length} 个 | queue=${JSON.stringify(noteQueue.stats())}`,
    );

    res.status(202).json({
      accepted: accepted.length,
      notes: accepted,
      skipped,
      message:
        skipped.length > 0
          ? `已加入队列 ${accepted.length} 个文件，另有 ${skipped.length} 个文件被跳过`
          : `已加入队列，共 ${accepted.length} 个文件`,
    });
  }),
);

// ---------- 处理队列 ----------

coursesRouter.get(
  '/:courseId/queue',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const rows = getDb()
      .prepare(
        `SELECT n.*, q.status AS queue_status, q.retry_count, q.error_message AS queue_error
         FROM notes n LEFT JOIN upload_queue q ON q.note_id = n.id
         WHERE n.course_id = ?
         ORDER BY n.created_at ASC, n.rowid ASC`,
      )
      .all(course.id);

    const summary = { total: rows.length, done: 0, processing: 0, queued: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === 'done') summary.done += 1;
      else if (row.status === 'failed') summary.failed += 1;
      else if (row.queue_status === 'queued') summary.queued += 1;
      else summary.processing += 1;
    }

    res.json({
      active: summary.processing + summary.queued > 0,
      summary,
      items: rows.map((row) => ({
        noteId: row.id,
        title: row.title,
        status: row.status,
        queueStatus: row.queue_status || null,
        engine: row.engine || null,
        retryCount: Number(row.retry_count ?? Math.max(0, row.attempts - 1)),
        attempts: Number(row.attempts || 0),
        errorMessage: row.status === 'failed' ? row.error_message || row.queue_error : null,
        canRetry: row.status === 'failed' && Boolean(row.raw_text),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  }),
);

// ---------- 课程内搜索 ----------

function plainMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(^|\s)[-*+]\s+/g, '$1')
    .replace(/[*_~`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 定位命中所在的 Markdown 标题：命中在标题行内时取完整标题，否则优先取最近的二级标题。 */
function nearestHeading(markdown, index) {
  const source = String(markdown);
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const lineEndRaw = source.indexOf('\n', index);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  const currentLine = source.slice(lineStart, lineEnd).trim();
  if (/^#{1,6}\s+/.test(currentLine)) return currentLine.replace(/^#+\s+/, '').slice(0, 60);

  const before = source.slice(0, lineStart);
  const lines = before.split('\n');
  let fallback = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!/^#{1,6}\s+/.test(line)) continue;
    const title = line.replace(/^#+\s+/, '').slice(0, 60);
    if (!fallback) fallback = title;
    if (/^##\s+/.test(line)) return title;
  }
  return fallback;
}

coursesRouter.get(
  '/:courseId/search',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const query = normalizeTitle(req.query.q, 50);
    if (!query) throw new HttpError(400, 'INVALID_QUERY', '请输入要搜索的关键词');

    const notes = getDb()
      .prepare(
        `SELECT id, title, markdown_content, summary FROM notes
         WHERE course_id = ? AND status = 'done' ORDER BY created_at ASC, rowid ASC`,
      )
      .all(course.id);

    const needle = query.toLowerCase();
    const results = [];
    let matchedNotes = 0;

    for (const note of notes) {
      const markdown = note.markdown_content || '';
      const haystack = `${note.title}\n${markdown}`;
      const lower = haystack.toLowerCase();
      if (!lower.includes(needle)) continue;
      matchedNotes += 1;

      const bodyLower = markdown.toLowerCase();
      const positions = [];
      let cursor = 0;
      while (positions.length < 3) {
        const found = bodyLower.indexOf(needle, cursor);
        if (found === -1) break;
        if (!positions.length || found - positions[positions.length - 1] > 30) positions.push(found);
        cursor = found + Math.max(1, needle.length);
      }
      const matchCount = bodyLower.split(needle).length - 1;

      if (!positions.length) {
        results.push({
          noteId: note.id,
          title: note.title,
          heading: '',
          snippet: `标题匹配：${note.title}`,
          matchCount: Math.max(1, matchCount),
          occurrence: 0,
        });
        continue;
      }

      for (const position of positions) {
        if (results.length >= 40) break;
        const start = Math.max(0, position - 60);
        const end = Math.min(markdown.length, position + needle.length + 60);
        let snippet = plainMarkdown(markdown.slice(start, end));
        if (start > 0) snippet = `……${snippet}`;
        if (end < markdown.length) snippet = `${snippet}……`;
        results.push({
          noteId: note.id,
          title: note.title,
          heading: nearestHeading(markdown, position),
          snippet: snippet.slice(0, 240),
          matchCount,
          occurrence: positions.indexOf(position),
        });
      }
      if (results.length >= 40) break;
    }

    res.json({ query, total: results.length, matchedNotes, results });
  }),
);

// ---------- 导出 ----------

function buildMergedMarkdown(course, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const head = `# ${course.name}\n\n> 共 ${notes.length} 篇笔记 · 由「课研」整理 · ${date}\n`;
  const body = notes
    .map((note) => `${noteMarkdownForDownload(note)}\n---\n`)
    .join('\n');
  return `${head}\n---\n\n${body}`;
}

coursesRouter.get(
  '/:courseId/export',
  asyncHandler(async (req, res) => {
    const course = ensureCourse(req);
    const format = String(req.query.format || 'md').toLowerCase();
    if (!['md', 'zip'].includes(format)) throw new HttpError(400, 'INVALID_FORMAT', '仅支持 md 或 zip 导出');

    const notes = getDb()
      .prepare(
        `SELECT * FROM notes WHERE course_id = ? AND status = 'done'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(course.id);
    if (!notes.length) throw new HttpError(409, 'NO_NOTES', '这个课程还没有已完成的笔记');

    const merged = buildMergedMarkdown(course, notes);
    const baseName = safeExportName(course.name, '课程');

    if (format === 'md') {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.set('Content-Disposition', contentDisposition(`${baseName}-复习笔记.md`));
      res.send(merged);
      return;
    }

    const zip = new AdmZip();
    const used = new Set();
    notes.forEach((note, index) => {
      let filename = `${String(index + 1).padStart(2, '0')}-${safeExportName(note.title)}.md`;
      if (used.has(filename)) filename = `${String(index + 1).padStart(2, '0')}-${safeExportName(note.title)}-${index + 1}.md`;
      used.add(filename);
      zip.addFile(filename, Buffer.from(noteMarkdownForDownload(note), 'utf8'));
    });
    zip.addFile('全部笔记.md', Buffer.from(merged, 'utf8'));
    zip.addFile(
      'README.md',
      Buffer.from(
        `# ${course.name}\n\n- 笔记数量：${notes.length}\n- 导出时间：${new Date().toISOString()}\n- 由「课研」生成，仅供个人复习使用。\n`,
        'utf8',
      ),
    );
    const buffer = zip.toBuffer();
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDisposition(`${baseName}-复习笔记.zip`));
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  }),
);
