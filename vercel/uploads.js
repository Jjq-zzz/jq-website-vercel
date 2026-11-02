import { handleUpload } from '@vercel/blob/client';
import { requireUser } from '../cloudflare/auth.js';
import { first, run, stmt, id, now, fail, json, basename, titleOf } from '../cloudflare/common.js';
import { parserForExtension, unsupportedFormatMessage } from '../shared/file-formats.js';

export async function prepareUpload(request, env, course, user) {
  const body = await request.json();
  const filename = basename(body.filename || '').slice(0, 255);
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!parserForExtension(extension) && extension !== '.zip') fail(400, 'UNSUPPORTED', unsupportedFormatMessage(filename));
  if (!Number.isInteger(body.size) || body.size <= 0 || body.size > 100 * 1024 * 1024) fail(400, 'FILE_SIZE', '文件需在 0–100MB 之间');
  const pending = await first(env, `SELECT COUNT(*) count FROM upload_tickets WHERE user_id=? AND created_at>?`, user.id, new Date(Date.now() - 3600000).toISOString());
  if (pending.count >= 120) fail(429, 'UPLOAD_LIMIT', '每小时最多准备 120 个文件，请稍后再试');
  const ticketId = id();
  const pathname = `pending/${user.id}/${ticketId}${extension}`;
  await run(env, `INSERT INTO upload_tickets (id,user_id,course_id,filename,pathname,size,created_at) VALUES (?,?,?,?,?,?,?)`, ticketId, user.id, course.id, filename, pathname, body.size, now());
  return json({ id: ticketId, pathname });
}
export async function completeUpload(env, ticketId, userId) {
  const ticket = await first(env, 'SELECT * FROM upload_tickets WHERE id=?', ticketId);
  if (!ticket || userId && ticket.user_id !== userId) fail(404, 'UPLOAD_NOT_FOUND', '上传记录不存在');
  const existing = await first(env, 'SELECT id FROM notes WHERE id=?', ticketId);
  if (!existing) {
    const course = await first(env, 'SELECT id FROM courses WHERE id=? AND user_id=?', ticket.course_id, ticket.user_id);
    if (!course) { await env.BLOB.del(ticket.pathname); fail(404, 'COURSE_NOT_FOUND', '课程不存在'); }
    const object = await env.BLOB.head(ticket.pathname);
    if (object.size !== ticket.size) { await env.BLOB.del(ticket.pathname); fail(400, 'FILE_SIZE', '上传文件大小与登记不一致，请重新上传'); }
    const at = now();
    await env.DB.batch([
      stmt(env, `INSERT OR IGNORE INTO notes (id,course_id,title,source_filename,status,created_at,updated_at) VALUES (?,?,?,?,'processing',?,?)`, ticketId, ticket.course_id, titleOf(ticket.filename), ticket.filename, at, at),
      stmt(env, `INSERT OR IGNORE INTO upload_queue (id,note_id,file_path,created_at,updated_at) VALUES (?,?,?,?,?)`, id(), ticketId, ticket.pathname, at, at),
      stmt(env, 'UPDATE courses SET updated_at=? WHERE id=?', at, ticket.course_id),
      stmt(env, 'UPDATE upload_tickets SET completed=1 WHERE id=?', ticketId),
    ]);
  }
  await env.wake();
  return json({ accepted: 1, notes: [{ id: ticketId, noteId: ticketId, title: titleOf(ticket.filename), sourceFilename: ticket.filename, status: 'processing' }], skipped: [] }, 202);
}
export async function uploadToken(request, env) {
  const body = await request.json();
  const result = await handleUpload({ body, request, token: env.BLOB_READ_WRITE_TOKEN,
    async onBeforeGenerateToken(pathname, clientPayload) {
      const { ticketId, token } = JSON.parse(clientPayload || '{}');
      const auth = new Request(request.url, { headers: { Authorization: `Bearer ${token}` } });
      const user = await requireUser(auth, env);
      const ticket = await first(env, 'SELECT * FROM upload_tickets WHERE id=? AND user_id=?', ticketId, user.id);
      if (!ticket || ticket.completed || ticket.pathname !== pathname || Date.now() - Date.parse(ticket.created_at) > 3600000) fail(403, 'INVALID_UPLOAD', '上传授权无效或已过期');
      return { maximumSizeInBytes: ticket.size, validUntil: Date.now() + 3600000, addRandomSuffix: false, allowOverwrite: false, tokenPayload: JSON.stringify({ ticketId }) };
    },
    async onUploadCompleted({ blob, tokenPayload }) {
      const { ticketId } = JSON.parse(tokenPayload);
      const ticket = await first(env, 'SELECT pathname FROM upload_tickets WHERE id=?', ticketId);
      if (!ticket || ticket.pathname !== blob.pathname) throw new Error('上传完成回调路径不匹配');
      await completeUpload(env, ticketId);
    },
  });
  return json(result);
}
