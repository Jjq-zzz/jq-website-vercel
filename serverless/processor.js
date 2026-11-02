import OpenAI from 'openai';
import { rows, first, run, stmt, id, now, titleOf } from '../cloudflare/common.js';
import { buildPrompt, splitIntoChunks } from '../server/ai/prompt.js';
import { mergeAiChunks, validateAiMarkdown } from '../server/ai/markdown.js';
import { generateLocalNotes } from '../server/ai/local-fallback.js';
import { summarizeMarkdown } from '../server/utils.js';

/** 可跨平台复用的逐分块任务处理器。 */
export class NoteProcessor {
  constructor(env) { this.env = env; this.controllers = new Map(); }
  async step(job, lane) {
    const controller = new AbortController();
    this.controllers.set(job.note_id, controller);
    try {
      await run(this.env, `UPDATE upload_queue SET status='processing',updated_at=? WHERE id=?`, now(), job.id);
      if (!job.raw_text) await this.parse(job, lane, controller.signal);
      else await this.generate(job, controller.signal);
    } catch (error) {
      const existing = await first(this.env, 'SELECT id FROM notes WHERE id=?', job.note_id);
      if (!existing || controller.signal.aborted) return;
      let message = String(error.message || '处理失败');
      const secret = this.env.AI_API_KEY || this.env.DEEPSEEK_API_KEY;
      if (secret) message = message.replaceAll(secret, '[密钥已隐藏]');
      message = message.slice(0, 300);
      const failed = error.permanent || job.retry_count >= 2;
      const at = now();
      await this.env.DB.batch([
        stmt(this.env, `UPDATE notes SET status=?,error_message=?,attempts=?,updated_at=? WHERE id=?`, failed ? 'failed' : 'processing', message, job.retry_count + 1, at, job.note_id),
        stmt(this.env, `UPDATE upload_queue SET status=?,retry_count=?,error_message=?,available_at=?,updated_at=? WHERE id=?`, failed ? 'failed' : 'queued', job.retry_count + 1, message, Date.now() + 1000 * (2 ** job.retry_count), at, job.id),
      ]);
      if (failed && job.file_path) {
        await this.env.UPLOADS.delete(job.file_path);
        await run(this.env, "UPDATE upload_queue SET file_path='',generation_state='{}' WHERE id=?", job.id);
      }
      console.error(JSON.stringify({ event: failed ? '任务最终失败' : '任务自动重试', noteId: job.note_id, attempt: job.retry_count + 1, code: error.code, message }));
    } finally { this.controllers.delete(job.note_id); }
  }
  async parse(job, lane, signal) {
    const object = await this.env.UPLOADS.get(job.file_path);
    if (!object) throw Object.assign(new Error('原始课件不存在，请重新上传'), { permanent: true });
    const response = await this.env.PARSER_FETCH(`/parse?filename=${encodeURIComponent(job.source_filename)}`, { method: 'POST', body: object.body, signal }, lane);
    const result = await response.json();
    if (!response.ok || !result.items?.length) {
      await this.env.UPLOADS.delete(job.file_path);
      throw Object.assign(new Error(result.error || '压缩包内没有可解析的文件'), { permanent: response.status === 422 || response.ok });
    }
    signal.throwIfAborted();
    if (!(await first(this.env, 'SELECT id FROM notes WHERE id=?', job.note_id))) { await this.env.UPLOADS.delete(job.file_path); return; }
    const statements = [];
    const at = now();
    for (const [index, item] of result.items.entries()) {
      const noteId = index === 0 ? job.note_id : id();
      const raw = item.rawText || '';
      const status = item.error ? 'failed' : 'processing';
      if (index === 0) {
        statements.push(stmt(this.env, 'UPDATE notes SET title=?,source_filename=?,raw_text=?,status=?,error_message=?,updated_at=? WHERE id=?', titleOf(item.filename), item.filename, raw, status, item.error || null, at, noteId));
        statements.push(stmt(this.env, "UPDATE upload_queue SET file_path='',status=?,error_message=?,updated_at=? WHERE note_id=?", item.error ? 'failed' : 'queued', item.error || null, at, noteId));
      } else {
        statements.push(stmt(this.env, 'INSERT INTO notes (id,course_id,title,source_filename,raw_text,status,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', noteId, job.course_id, titleOf(item.filename), item.filename, raw, status, item.error || null, at, at));
        statements.push(stmt(this.env, "INSERT INTO upload_queue (id,note_id,file_path,status,created_at,updated_at) VALUES (?,?,'',?,?,?)", id(), noteId, item.error ? 'failed' : 'queued', at, at));
      }
    }
    await this.env.DB.batch(statements);
    await this.env.UPLOADS.delete(job.file_path);
    console.log(JSON.stringify({ event: '文本提取完成并删除原文件', noteId: job.note_id, files: result.items.length, skipped: result.skipped?.length || 0 }));
  }
  async generate(job, signal) {
    const secret = this.env.AI_API_KEY || this.env.DEEPSEEK_API_KEY;
    if (!secret) {
      const generated = generateLocalNotes({ rawText: job.raw_text, title: job.title });
      await this.finish(job, generated.markdown, 'local-fallback');
      return;
    }
    const state = JSON.parse(job.generation_state || '{}');
    state.parts ||= splitIntoChunks(job.raw_text, Math.min(Number(this.env.AI_CHUNK_CHARS) || 4000, 4000)).map((text) => ({ text, markdown: null }));
    const index = state.parts.findIndex((part) => !part.markdown);
    if (index === -1) { await this.finish(job, mergeAiChunks(state.parts.map((p) => p.markdown), job.title), 'ai'); return; }
    const part = state.parts[index];
    const client = new OpenAI({ apiKey: secret, baseURL: this.env.AI_BASE_URL || 'https://api.deepseek.com/v1', maxRetries: 0, timeout: 120000 });
    console.log(JSON.stringify({ event: 'AI 调用', noteId: job.note_id, part: index + 1, total: state.parts.length, attempt: job.retry_count + 1 }));
    try {
      const response = await client.chat.completions.create({ model: this.env.AI_MODEL || 'deepseek-chat', messages: [{ role: 'user', content: buildPrompt(part.text) }], temperature: 0.2, max_tokens: Number(this.env.AI_MAX_TOKENS) || 8192 }, { signal });
      if (response.choices?.[0]?.finish_reason === 'length') throw Object.assign(new Error('AI 输出被截断，正在缩块重试'), { code: 'AI_TRUNCATED_RESPONSE' });
      const markdown = response.choices?.[0]?.message?.content?.trim() || '';
      validateAiMarkdown(markdown);
      part.markdown = markdown;
    } catch (error) {
      if (error.code === 'AI_TRUNCATED_RESPONSE' && part.text.length > 1000) {
        const prefix = part.text.match(/^\[Page \d+\]\n/)?.[0].length || 0;
        const pieces = splitIntoChunks(part.text, Math.max(500, Math.ceil((part.text.length - prefix) / 2) + prefix));
        state.parts.splice(index, 1, ...pieces.map((text) => ({ text, markdown: null })));
        await run(this.env, 'UPDATE upload_queue SET generation_state=? WHERE id=?', JSON.stringify(state), job.id);
      }
      throw error;
    }
    signal.throwIfAborted();
    if (state.parts.reduce((sum, p) => sum + (p.markdown?.length || 0), 0) > 200000) throw Object.assign(new Error('笔记内容过长，请拆分课件'), { permanent: true });
    await run(this.env, 'UPDATE upload_queue SET generation_state=?,status=\'queued\',updated_at=? WHERE id=?', JSON.stringify(state), now(), job.id);
    if (state.parts.every((p) => p.markdown)) await this.finish(job, mergeAiChunks(state.parts.map((p) => p.markdown), job.title), 'ai');
  }
  async finish(job, markdown, engine) {
    const at = now();
    await this.env.DB.batch([
      stmt(this.env, "UPDATE notes SET markdown_content=?,summary=?,status='done',engine=?,error_message=NULL,attempts=?,updated_at=? WHERE id=? AND status='processing'", markdown, summarizeMarkdown(markdown), engine, job.retry_count + 1, at, job.note_id),
      stmt(this.env, 'DELETE FROM upload_queue WHERE id=?', job.id),
      stmt(this.env, 'UPDATE courses SET updated_at=? WHERE id=?', at, job.course_id),
    ]);
  }
}
