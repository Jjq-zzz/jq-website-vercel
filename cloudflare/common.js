export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const first = (env, sql, ...args) => stmt(env, sql, ...args).first();
export const rows = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results;
export const run = (env, sql, ...args) => stmt(env, sql, ...args).run();
export function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
export const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export const keyOf = (value) => String(value).normalize('NFKC').toLowerCase();
export const basename = (name) => String(name).replaceAll('\\', '/').split('/').pop();
export const titleOf = (name) => basename(name).replace(/\.[^.]+$/, '').slice(0, 100) || '未命名笔记';
export const downloadName = (value) => String(value).replace(/[\\/:*?"<>|\r\n]/g, '-').slice(0, 80) || '笔记';
export function attachment(content, name, type = 'text/markdown; charset=utf-8') {
  return new Response(content, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
export const publicNote = (n) => ({ id: n.id, title: n.title, sourceFilename: n.source_filename, summary: n.summary, markdownContent: n.markdown_content, status: n.status, engine: n.engine, errorMessage: n.error_message, canRetry: n.status === 'failed' && Boolean(n.raw_text), createdAt: n.created_at, updatedAt: n.updated_at });
export const publicCourse = (c) => ({ id: c.id, name: c.name, createdAt: c.created_at, updatedAt: c.updated_at, noteCount: c.note_count || 0, doneCount: c.done_count || 0, processingCount: c.processing_count || 0, failedCount: c.failed_count || 0 });
export const coordinator = (env) => env.QUEUE.get(env.QUEUE.idFromName('global-ai-queue-v1'));
export async function kick(env) {
  const response = await coordinator(env).fetch('https://queue/wake', { method: 'POST' });
  if (!response.ok) throw new Error('队列唤醒失败');
}
