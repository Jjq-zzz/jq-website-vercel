import { DurableObject } from 'cloudflare:workers';
import { decryptKey } from '../shared/key-crypto.js';
import { NoteProcessor } from '../serverless/processor.js';
import { rows, first, run, stmt, id, now, titleOf } from './common.js';
import { buildPrompt, splitIntoChunks } from '../server/ai/prompt.js';
import { mergeAiChunks, validateAiMarkdown } from '../server/ai/markdown.js';
import { generateLocalNotes } from '../server/ai/local-fallback.js';
import { summarizeMarkdown } from '../server/utils.js';

/** 所有实例共用一个持久化协调器，闹钟每次只处理两篇、每篇一个分块。 */
export class NoteCoordinator extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.processor = new NoteProcessor(env); this.controllers = this.processor.controllers; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/login-limit') {
      const ip = (await request.text()).slice(0, 100);
      const key = `login:${ip}`;
      // SQLite 持久化计数，部署或休眠不会清空登录限流。
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER, until INTEGER)');
      sql.exec('DELETE FROM login_limits WHERE until < ?', Date.now());
      sql.exec('INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', key, Date.now() + 900000);
      const row = [...sql.exec('SELECT count FROM login_limits WHERE key=?', key)][0];
      return new Response(null, { status: row.count > 30 ? 429 : 204 });
    }
    if (path === '/cancel') {
      const { ids } = await request.json();
      for (const noteId of ids) this.controllers.get(noteId)?.abort();
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > Date.now() + 100) await this.ctx.storage.setAlarm(Date.now() + 100);
    return new Response(null, { status: 204 });
  }
  async alarm() {
    // 先设恢复闹钟：进程异常或数据库短暂不可用时，任务仍可恢复。
    await this.ctx.storage.setAlarm(Date.now() + 240000);
    try {
      const jobs = await rows(this.env, `SELECT q.*, n.title,n.raw_text,n.course_id,n.source_filename,u.ai_key_cipher,u.ai_key_iv,u.ai_base_url,u.ai_model
        FROM upload_queue q JOIN notes n ON n.id=q.note_id JOIN courses c ON c.id=n.course_id JOIN users u ON u.id=c.user_id
        WHERE n.status='processing' AND q.available_at<=? ORDER BY q.created_at,q.id LIMIT 2`, Date.now());
      await Promise.all(jobs.map((job, lane) => this.step(job, lane)));
      const pending = await first(this.env, `SELECT MIN(q.available_at) AS due FROM upload_queue q JOIN notes n ON n.id=q.note_id WHERE n.status='processing'`);
      if (pending?.due !== null && pending?.due !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, pending.due));
      else await this.ctx.storage.deleteAlarm();
    } catch (error) {
      console.error(JSON.stringify({ event: '队列基础设施异常', message: String(error.message).slice(0, 200) }));
      await this.ctx.storage.setAlarm(Date.now() + 30000);
    }
  }
  async step(job, lane) {
    let userKey = null;
    if (job.ai_key_cipher) {
      try { userKey = await decryptKey(job.ai_key_cipher, job.ai_key_iv, this.env); }
      catch { console.warn('用户密钥解密失败，使用全局兜底或本地模式'); }
    }
    // 每个任务独立注入配置，避免并发任务串用其他用户的密钥。
    const processor = new NoteProcessor({ ...this.env,
      AI_API_KEY: userKey || this.env.AI_API_KEY || this.env.DEEPSEEK_API_KEY,
      AI_BASE_URL: job.ai_base_url || this.env.AI_BASE_URL,
      AI_MODEL: job.ai_model || this.env.AI_MODEL });
    processor.controllers = this.controllers;
    return processor.step(job, lane);
  }
}
