import { get, del, head, list } from '@vercel/blob';
import { QueueClient } from '@vercel/queue';
import { createDatabase } from './database.js';
import { parserFetch } from './parser.js';
import { first, rows, run } from '../cloudflare/common.js';

let singleton;
export const queueClient = new QueueClient({ region: process.env.VERCEL_REGION || 'iad1' });
export const TOPIC = 'course-notes';
export function createEnvironment({ database, blob, publish, variables = process.env } = {}) {
  const env = { ...variables, DEPLOYMENT: 'vercel', DB: database || createDatabase(), PARSER_FETCH: parserFetch };
  env.BLOB = blob || { get, del, head, list };
  env.UPLOADS = {
    async get(key) {
      const result = await env.BLOB.get(key, { access: 'private', useCache: false });
      return result ? { body: result.stream } : null;
    },
    async delete(key) { await env.BLOB.del(key); },
  };
  env.publish = publish || ((message, options) => queueClient.send(TOPIC, message, options));
  env.wake = async () => {
    const pending = await rows(env, `SELECT q.id,q.note_id,q.updated_at,q.available_at FROM upload_queue q JOIN notes n ON n.id=q.note_id WHERE n.status='processing' AND q.lease_until<? AND (q.published_key<>q.updated_at OR q.published_at<?) ORDER BY q.created_at LIMIT 120`, Date.now(), Date.now() - 12 * 3600000);
    for (const job of pending) {
      await env.publish({ noteId: job.note_id }, { idempotencyKey: `${job.id}:${job.updated_at}`, delaySeconds: Math.max(0, Math.ceil((job.available_at - Date.now()) / 1000)) });
      await run(env, 'UPDATE upload_queue SET published_key=?,published_at=? WHERE id=? AND updated_at=?', job.updated_at, Date.now(), job.id, job.updated_at);
    }
  };
  env.QUEUE = {
    idFromName: (name) => name,
    get: () => ({ async fetch(url, init = {}) {
      if (url.endsWith('/login-limit')) {
        const key = String(init.body).slice(0, 100);
        const result = await run(env, `INSERT INTO login_limits (key,count,until) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until<? THEN 1 ELSE count+1 END,until=CASE WHEN until<? THEN excluded.until ELSE until END`, key, Date.now() + 900000, Date.now(), Date.now());
        const limit = await first(env, 'SELECT count FROM login_limits WHERE key=?', key);
        return new Response(null, { status: limit.count > 30 ? 429 : 204 });
      }
      if (url.endsWith('/cancel')) return new Response(null, { status: 204 });
      await env.wake();
      return new Response(null, { status: 204 });
    } }),
  };
  return env;
}
export function environment() { return singleton ||= createEnvironment(); }
