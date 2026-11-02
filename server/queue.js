import fs from 'node:fs/promises';
import { config } from './config.js';
import { getDb, touchCourse, deleteFileQuiet, nowIso } from './db.js';
import { logger } from './logger.js';
import { parseCourseware, parseErrorUserMessage, isPermanentParseError } from './parsers/index.js';
import { generateNotes } from './ai/provider.js';
import { summarizeMarkdown, sleep, truncateForLog } from './utils.js';

const MAX_ATTEMPTS = config.ai.maxRetries + 1;

function publicError(err) {
  if (err?.code === 'AI_TRUNCATED_RESPONSE') {
    return 'AI 输出达到长度上限而被截断，请提高 AI_MAX_TOKENS 或降低 AI_CHUNK_CHARS 后重试';
  }
  if (err?.code === 'AI_INVALID_MARKDOWN') {
    return 'AI 已返回内容，但格式不符合要求：需要章节标题及 5～8 条本章速记，请重试';
  }
  if (err?.code === 'AI_TIMEOUT') {
    return 'AI 请求超时，请稍后重试，或提高 AI_TIMEOUT_MS';
  }
  if (err?.code === 'AI_CALL_FAILED') {
    if ([401, 403].includes(err.aiStatus)) return 'AI 接口拒绝授权，请检查密钥和接口地址是否匹配';
    if (err.aiStatus === 402) return 'AI 接口提示余额不足，请检查供应商账户余额';
    if (err.aiStatus === 429) return 'AI 接口触发请求限流，请稍后重试';
    if (err.aiStatus >= 500) return 'AI 供应商服务暂时异常，请稍后重试';
    return 'AI 接口或网络请求失败，请查看终端中的具体调用错误后重试';
  }
  if (err?.code === 'AI_EMPTY_RESPONSE') {
    return 'AI 返回内容为空，请点击重试';
  }
  return parseErrorUserMessage(err);
}

class NoteQueue {
  constructor(concurrency = config.ai.concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
    this.pendingIds = new Set();
    this.activeIds = new Set();
    this.controllers = new Map();
    this.ready = false;
  }

  enqueue(noteId, { front = false } = {}) {
    if (!noteId) return false;
    if (this.pendingIds.has(noteId) || this.activeIds.has(noteId)) return false;
    this.pendingIds.add(noteId);
    if (front) this.pending.unshift(noteId);
    else this.pending.push(noteId);
    this.pump();
    return true;
  }

  pump() {
    if (!this.ready) return;
    while (this.running < this.concurrency && this.pending.length > 0) {
      const noteId = this.pending.shift();
      this.pendingIds.delete(noteId);
      this.activeIds.add(noteId);
      const controller = new AbortController();
      this.controllers.set(noteId, controller);
      this.running += 1;
      this.run(noteId, controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return;
          // 兜底：worker 自身任何异常都不得影响队列。
          logger.error('queue', `worker 未捕获异常 note=${noteId}：${err.stack || err.message}`);
        })
        .finally(() => {
          this.activeIds.delete(noteId);
          this.controllers.delete(noteId);
          this.running -= 1;
          this.pump();
          if (this.running === 0 && this.pending.length === 0) {
            logger.info('queue', '处理队列空闲');
          }
        });
    }
  }

  /** 删除笔记或课程时移除排队项，并中止正在进行的模型请求。 */
  cancel(noteId) {
    this.pendingIds.delete(noteId);
    this.pending = this.pending.filter((id) => id !== noteId);
    this.controllers.get(noteId)?.abort(new Error('任务已删除'));
  }

  async run(noteId, signal) {
    const db = getDb();
    let note = db
      .prepare(
        `SELECT n.*, q.file_path AS queue_file_path, q.id AS queue_id, c.id AS course_id_check
         FROM notes n
         LEFT JOIN upload_queue q ON q.note_id = n.id
         JOIN courses c ON c.id = n.course_id
         WHERE n.id = ?`,
      )
      .get(noteId);

    if (!note) {
      logger.warn('queue', `任务对应的笔记已不存在，跳过 note=${noteId}`);
      return;
    }
    if (note.status === 'done') return;
    const uploadPath = note.queue_file_path;
    if (!uploadPath && !note.raw_text) {
      this.fail(noteId, 'failed', null, '没有可重试的文本，请重新上传该课件');
      return;
    }

    logger.info('queue', `开始处理《${note.title}》 note=${noteId} 并发=${this.running}/${this.concurrency}`);

    // 解析只做一次；保存文本后立即删除课件，AI 自动重试和手动重试均复用文本。
    let rawText = note.raw_text;
    let pageCount = null;
    try {
      if (!rawText) {
        const parsed = await parseCourseware(uploadPath);
        rawText = parsed.rawText;
        pageCount = parsed.pageCount;
        db.prepare('UPDATE notes SET raw_text = ?, updated_at = ? WHERE id = ?')
          .run(rawText, nowIso(), noteId);
      }
    } catch (err) {
      if (signal.aborted) return;
      logger.error('queue', `解析失败 note=${noteId} | code=${err.code || '-'} | ${truncateForLog(err.message)}`);
      this.fail(noteId, 'failed', uploadPath, publicError(err), 1);
      return;
    } finally {
      deleteFileQuiet(uploadPath);
      db.prepare("UPDATE upload_queue SET file_path = '' WHERE note_id = ?").run(noteId);
    }

    let attempt = Number(note.attempts) || 0;
    const generationState = {};
    if (attempt >= MAX_ATTEMPTS) {
      this.fail(noteId, 'failed', uploadPath, '任务中断且已达到自动重试上限，可使用已提取文本手动重试', attempt);
      return;
    }
    while (attempt < MAX_ATTEMPTS && !signal.aborted) {
      attempt += 1;
      const started = Date.now();
      db.prepare(
        `UPDATE notes SET status = 'processing', attempts = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
      ).run(attempt, nowIso(), noteId);
      db.prepare(
        `UPDATE upload_queue SET status = 'processing', retry_count = ?, error_message = NULL, updated_at = ?
         WHERE note_id = ?`,
      ).run(attempt - 1, nowIso(), noteId);

      try {
        note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
        if (!note) return;

        const generated = await generateNotes({
          rawText,
          title: note.title,
          noteId,
          state: generationState,
          signal,
        });

        const markdown = String(generated.markdown || '').trim();
        if (!markdown) {
          const err = new Error('生成的笔记为空');
          err.code = 'AI_EMPTY_RESPONSE';
          throw err;
        }

        const updatedAt = nowIso();
        const summary = summarizeMarkdown(markdown);
        const changed = db
          .prepare(
            `UPDATE notes SET raw_text = ?, markdown_content = ?, summary = ?, status = 'done',
               engine = ?, error_message = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(rawText, markdown, summary, generated.engine, updatedAt, noteId);
        if (!changed.changes) {
          // 课程可能在处理途中被删除，安静清理临时文件即可。
          deleteFileQuiet(uploadPath);
          db.prepare('DELETE FROM upload_queue WHERE note_id = ?').run(noteId);
          return;
        }
        touchCourse(note.course_id, updatedAt);
        db.prepare('DELETE FROM upload_queue WHERE note_id = ?').run(noteId);
        deleteFileQuiet(uploadPath);

        logger.info(
          'queue',
          `✅ 完成《${note.title}》 ${Date.now() - started}ms | engine=${generated.engine} | pages=${pageCount ?? '已提取'} | chunks=${generated.chunks}`,
        );
        return;
      } catch (err) {
        if (signal.aborted) return;
        const permanent = isPermanentParseError(err);
        logger.error(
          'queue',
          `❌ 处理失败（尝试 ${attempt}/${MAX_ATTEMPTS}）《${note.title}》 ${Date.now() - started}ms | code=${err.code || '-'} | ${truncateForLog(err.message)}`,
        );
        if (permanent) {
          this.fail(noteId, 'failed', uploadPath, publicError(err), attempt);
          return;
        }
        if (attempt >= MAX_ATTEMPTS) {
          this.fail(
            noteId,
            'failed',
            uploadPath,
            `${publicError(err)}（已尝试 ${attempt} 次）`,
            attempt,
          );
          return;
        }
        const backoff = 1000 * 2 ** (attempt - 1);
        logger.warn('queue', `↻ ${backoff}ms 后自动重试《${note.title}》（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）`);
        db.prepare(
          `UPDATE notes SET error_message = ?, updated_at = ? WHERE id = ?`,
        ).run(publicError(err), nowIso(), noteId);
        try {
          await sleep(backoff, signal);
        } catch (err) {
          if (signal.aborted) return;
          throw err;
        }
        const stillThere = db.prepare('SELECT status FROM notes WHERE id = ?').get(noteId);
        if (!stillThere) return;
      }
    }
  }

  fail(noteId, queueStatus, filePath, message, attempts) {
    deleteFileQuiet(filePath);
    const db = getDb();
    const note = db.prepare('SELECT course_id, error_message FROM notes WHERE id = ?').get(noteId);
    if (!note) return;
    const at = nowIso();
    db.prepare(
      `UPDATE notes SET status = 'failed', error_message = ?, attempts = COALESCE(?, attempts), updated_at = ?
       WHERE id = ?`,
    ).run(message, attempts ?? null, at, noteId);
    const queue = db.prepare('SELECT id FROM upload_queue WHERE note_id = ?').get(noteId);
    if (queue) {
      db.prepare(
        `UPDATE upload_queue SET status = 'failed', file_path = ?, retry_count = ?, error_message = ?, updated_at = ?
         WHERE note_id = ?`,
      ).run('', Math.max(0, (attempts || 1) - 1), message, at, noteId);
    }
    touchCourse(note.course_id, at);
    logger.error('queue', `任务最终失败 note=${noteId} | ${message}`);
  }

  /** 服务重启后恢复未完成任务；丢失临时文件的记录明确标记失败。 */
  async recover() {
    const db = getDb();
    db.exec("UPDATE upload_queue SET status = 'queued' WHERE status = 'processing'");
    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.raw_text, n.status AS note_status, q.file_path, q.status AS queue_status
         FROM notes n LEFT JOIN upload_queue q ON q.note_id = n.id
         WHERE n.status = 'processing'`,
      )
      .all();

    for (const row of rows) {
      if (!row.file_path && !row.raw_text) {
        this.fail(row.id, 'failed', '', '服务重启时任务中断，请重新上传该课件');
        continue;
      }
      try {
        if (!row.raw_text) await fs.access(row.file_path);
        // 恢复时保留已消耗的尝试次数，防止反复重启绕过自动重试上限。
        db.prepare(
          "UPDATE notes SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?",
        ).run(nowIso(), row.id);
        logger.info('queue', `恢复未完成任务《${row.title}》 note=${row.id}`);
        this.enqueue(row.id, { front: true });
      } catch {
        this.fail(row.id, 'failed', '', '临时文件已丢失，请重新上传该课件');
      }
    }

    // 同时清理旧版本遗留的失败课件，失败重试只使用数据库文本。
    await this.cleanupFinishedFiles(false);
    await this.cleanupOrphanUploads();

    // 启动时清掉遗留的 multer 临时文件（服务尚未 listen，不会有新请求写入）。
    try {
      const names = await fs.readdir(config.tmpDir);
      await Promise.all(names.map((name) => fs.unlink(`${config.tmpDir}/${name}`).catch(() => {})));
    } catch {
      // 临时目录不存在时无需清理。
    }

    this.ready = true;
    this.pump();
  }

  /** 清理终态任务遗留文件；启动时与定时任务共用。 */
  async cleanupFinishedFiles(verbose = true) {
    const db = getDb();
    const stale = db
      .prepare(
        `SELECT q.id, q.note_id, q.file_path FROM upload_queue q JOIN notes n ON n.id = q.note_id
         WHERE n.status IN ('done', 'failed') AND q.file_path <> ''`,
      )
      .all();
    for (const row of stale) {
      deleteFileQuiet(row.file_path);
      db.prepare(
        "UPDATE upload_queue SET file_path = '' WHERE id = ?",
      ).run(row.id);
    }
    if (stale.length && verbose) logger.info('queue', `已按隐私策略清理 ${stale.length} 个终态任务文件`);
    return stale.length;
  }

  /** 清理“文件已落地但队列记录不存在”的孤儿文件（通常来自崩溃窗口），排除 1 小时内的新文件。 */
  async cleanupOrphanUploads() {
    const db = getDb();
    const referenced = new Set(
      db
        .prepare("SELECT file_path FROM upload_queue WHERE file_path <> ''")
        .all()
        .map((row) => row.file_path.split(/[\\/]/).pop()),
    );
    let removed = 0;
    try {
      const names = await fs.readdir(config.uploadsDir);
      for (const name of names) {
        if (referenced.has(name)) continue;
        const full = `${config.uploadsDir}/${name}`;
        try {
          const stat = await fs.stat(full);
          if (Date.now() - stat.mtimeMs < 3600_000) continue;
          await fs.unlink(full);
          removed += 1;
        } catch {
          // 文件可能已由任务完成流程删除。
        }
      }
    } catch {
      // 上传目录不存在时无需清理。
    }
    if (removed) logger.info('queue', `清理 ${removed} 个孤儿上传文件`);
    return removed;
  }

  stats() {
    return {
      running: this.running,
      pending: this.pending.length,
      concurrency: this.concurrency,
    };
  }
}

export const noteQueue = new NoteQueue();
