import { api } from '../serverless/http.js';
import { requireUser } from '../cloudflare/auth.js';
import { first, json, fail } from '../cloudflare/common.js';
import { prepareUpload, completeUpload, uploadToken } from './uploads.js';

export async function handleRequest(request, env, ctx = { waitUntil: () => {} }) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/blob-upload' && request.method === 'POST') return await uploadToken(request, env);
    if (url.pathname === '/api/health') return json({ ok: true, deployment: 'vercel', ai: { configured: Boolean(env.AI_API_KEY || env.DEEPSEEK_API_KEY), mode: env.AI_API_KEY || env.DEEPSEEK_API_KEY ? 'ai' : 'local-fallback', model: env.AI_MODEL || 'deepseek-chat' }, queue: { concurrency: 2 } });
    if (url.pathname === '/api/maintenance') {
      if (!env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) fail(401, 'UNAUTHORIZED', '未授权');
      await env.wake();
      // 私有桶中没有任务引用的旧文件作兜底清理。
      let cursor;
      do {
        const page = await env.BLOB.list({ prefix: 'pending/', cursor, limit: 100 });
        for (const object of page.blobs) {
          if (Date.now() - new Date(object.uploadedAt).getTime() < 3600000) continue;
          if (!(await first(env, 'SELECT id FROM upload_queue WHERE file_path=?', object.pathname))) await env.BLOB.del(object.pathname);
        }
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
      return json({ ok: true });
    }
    const prepare = url.pathname.match(/^\/api\/courses\/([^/]+)\/upload-ticket$/);
    const complete = url.pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
    if (prepare || complete) {
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '请使用 POST');
      const user = await requireUser(request, env);
      if (complete) return await completeUpload(env, complete[1], user.id);
      const course = await first(env, 'SELECT * FROM courses WHERE id=? AND user_id=?', prepare[1], user.id);
      if (!course) fail(404, 'COURSE_NOT_FOUND', '课程不存在');
      return await prepareUpload(request, env, course, user);
    }
    if (/^\/api\/courses\/[^/]+\/files$/.test(url.pathname)) fail(400, 'DIRECT_UPLOAD_REQUIRED', '请通过新版网页直接上传到私有文件存储');
    return await api(request, env, ctx);
  } catch (error) {
    console.error(JSON.stringify({ event: 'Vercel 接口错误', path: url.pathname, code: error.code || 'INTERNAL_ERROR', status: error.status || 500 }));
    return json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务器暂时不可用，请检查部署配置' } }, error.status || 500);
  }
}
