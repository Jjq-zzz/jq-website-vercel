import { decryptKey } from './key-crypto.js';
import { NoteProcessor } from '../serverless/processor.js';
import { first, run } from '../cloudflare/common.js';

/** 数据库中的两个租约槽跨实例限流，单个函数最多执行一个解析阶段或 AI 分块。 */
export async function consumeNote(env, message) {
  const owner = crypto.randomUUID();
  const until = Date.now() + 300000;
  const slot = await env.DB.prepare(`UPDATE worker_slots SET owner=?,expires_at=? WHERE id=(SELECT id FROM worker_slots WHERE expires_at<? ORDER BY id LIMIT 1) RETURNING id`).bind(owner, until, Date.now()).first();
  if (!slot) throw new Error('并发槽已满，等待重试');
  let job;
  try {
    job = await first(env, `SELECT q.*,n.title,n.raw_text,n.course_id,n.source_filename,u.ai_key_cipher,u.ai_key_iv,u.ai_base_url,u.ai_model FROM upload_queue q JOIN notes n ON n.id=q.note_id JOIN courses c ON c.id=n.course_id JOIN users u ON u.id=c.user_id WHERE q.note_id=? AND n.status='processing'`, message.noteId);
    if (!job) return;
    if (job.available_at > Date.now()) throw new Error('等待任务退避');
    const claimed = await run(env, 'UPDATE upload_queue SET lease_owner=?,lease_until=? WHERE id=? AND lease_until<?', owner, until, job.id, Date.now());
    if (!claimed.meta.changes) throw new Error('任务已在另一实例处理中');
    let userKey = null;
    if (job.ai_key_cipher) {
      try { userKey = await decryptKey(job.ai_key_cipher, job.ai_key_iv, env); }
      catch { console.warn('用户密钥解密失败，使用全局兜底或本地模式'); }
    }
    const jobEnv = { ...env, AI_API_KEY: userKey || env.AI_API_KEY || env.DEEPSEEK_API_KEY,
      AI_BASE_URL: job.ai_base_url || env.AI_BASE_URL, AI_MODEL: job.ai_model || env.AI_MODEL };
    const processor = new NoteProcessor(jobEnv);
    await processor.step(job, slot.id - 1);
    // 先投递下一阶段，再确认当前消息。投递失败时由托管队列重试当前消息。
    const next = await first(env, `SELECT q.* FROM upload_queue q JOIN notes n ON n.id=q.note_id WHERE q.id=? AND n.status='processing'`, job.id);
    if (next) await env.publish({ noteId: job.note_id }, { idempotencyKey: `${next.id}:${next.updated_at}`, delaySeconds: Math.max(0, Math.ceil((next.available_at - Date.now()) / 1000)) });
    // ZIP 新展开的条目也需要进入持久化队列。
    if (!job.raw_text) await env.wake();
  } finally {
    if (job) await run(env, 'UPDATE upload_queue SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?', job.id, owner);
    await run(env, 'UPDATE worker_slots SET owner=NULL,expires_at=0 WHERE id=? AND owner=?', slot.id, owner);
  }
}
