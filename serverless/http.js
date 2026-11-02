import JSZip from 'jszip';
import { encryptKey, decryptKey, maskKey } from '../shared/key-crypto.js';
import { authRoute, requireUser } from '../cloudflare/auth.js';
import { first, rows, run, stmt, now, id, fail, json, publicNote, publicCourse, titleOf, basename, attachment, downloadName, coordinator, kick } from '../cloudflare/common.js';
import { parserForExtension, unsupportedFormatMessage } from '../shared/file-formats.js';
import { noteMarkdownForDownload } from '../server/utils.js';
const courseStats = `SELECT c.*,
  (SELECT COUNT(*) FROM notes WHERE course_id=c.id) note_count,
  (SELECT COUNT(*) FROM notes WHERE course_id=c.id AND status='done') done_count,
  (SELECT COUNT(*) FROM notes WHERE course_id=c.id AND status='processing') processing_count,
  (SELECT COUNT(*) FROM notes WHERE course_id=c.id AND status='failed') failed_count FROM courses c`;
async function ownedCourse(env, courseId, userId) {
  const course = await first(env, 'SELECT * FROM courses WHERE id=? AND user_id=?', courseId, userId);
  if (!course) fail(404, 'COURSE_NOT_FOUND', '课程不存在');
  return course;
}
async function ownedNote(env, noteId, userId) {
  const note = await first(env, 'SELECT n.*,c.name course_name FROM notes n JOIN courses c ON c.id=n.course_id WHERE n.id=? AND c.user_id=?', noteId, userId);
  if (!note) fail(404, 'NOTE_NOT_FOUND', '笔记不存在');
  return note;
}
async function removeNotes(env, notes) {
  const ids = notes.map((n) => n.id);
  if (!ids.length) return;
  const queues = [];
  for (const noteId of ids) {
    const queue = await first(env, 'SELECT file_path FROM upload_queue WHERE note_id=?', noteId);
    if (queue?.file_path) queues.push(queue.file_path);
  }
  await env.DB.batch(ids.map((noteId) => stmt(env, 'DELETE FROM notes WHERE id=?', noteId)));
  await coordinator(env).fetch('https://queue/cancel', { method: 'POST', body: JSON.stringify({ ids }) });
  if (queues.length) await env.UPLOADS.delete(queues);
}
export async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health') return json({ ok: true, deployment: env.DEPLOYMENT || 'cloudflare', ai: { configured: Boolean(env.AI_API_KEY || env.DEEPSEEK_API_KEY), mode: env.AI_API_KEY || env.DEEPSEEK_API_KEY ? 'ai' : 'local-fallback', model: env.AI_MODEL || 'deepseek-chat' }, queue: { concurrency: 2 }, now: now() });
  if (path.startsWith('/api/auth/')) return authRoute(request, env, (p, init) => env.PARSER_FETCH(p, init));
  const user = await requireUser(request, env);
  if (path === '/api/settings/ai-key') {
    let settings = await first(env, 'SELECT ai_key_cipher,ai_key_iv,ai_base_url,ai_model FROM users WHERE id=?', user.id);
    let plaintext = null;
    if (method === 'PUT') {
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_AI_KEY', '请求体需为对象');
      if (body.apiKey != null && typeof body.apiKey !== 'string') fail(400, 'INVALID_AI_KEY', '密钥需为字符串');
      plaintext = body.apiKey?.trim() || null;
      if (plaintext && (plaintext.length < 8 || plaintext.length > 200)) fail(400, 'INVALID_AI_KEY', '密钥长度需为 8–200 个字符');
      let baseUrl = settings.ai_base_url, model = settings.ai_model;
      if (body.baseUrl !== undefined) {
        if (body.baseUrl !== null && (typeof body.baseUrl !== 'string' || !/^https?:\/\//.test(body.baseUrl.trim()))) fail(400, 'INVALID_BASE_URL', '地址必须以 http:// 或 https:// 开头');
        baseUrl = body.baseUrl?.trim() || null;
      }
      if (body.model !== undefined) {
        if (body.model !== null && (typeof body.model !== 'string' || body.model.trim().length > 64)) fail(400, 'INVALID_MODEL', '模型名长度不得超过 64 个字符');
        model = body.model?.trim() || null;
      }
      const encrypted = plaintext ? await encryptKey(plaintext, env) : null;
      await run(env, 'UPDATE users SET ai_key_cipher=?,ai_key_iv=?,ai_base_url=?,ai_model=? WHERE id=?', encrypted?.cipherB64 || null, encrypted?.ivB64 || null, baseUrl, model, user.id);
      settings = { ai_key_cipher: encrypted?.cipherB64, ai_base_url: baseUrl, ai_model: model };
    } else if (method === 'GET') {
      if (settings.ai_key_cipher) {
        try { plaintext = await decryptKey(settings.ai_key_cipher, settings.ai_key_iv, env); } catch { /* 损坏密钥按未配置处理。 */ }
      }
    } else fail(405, 'METHOD_NOT_ALLOWED', '请使用 GET 或 PUT');
    return json({ configured: Boolean(plaintext), masked: maskKey(plaintext), baseUrl: settings.ai_base_url, model: settings.ai_model });
  }
  if (path === '/api/courses') {
    if (method === 'GET') return json({ courses: (await rows(env, `${courseStats} WHERE c.user_id=? ORDER BY c.updated_at DESC`, user.id)).map(publicCourse) });
    if (method === 'POST') {
      const name = String((await request.json()).name || '').trim();
      if (!name || [...name].length > 40) fail(400, 'INVALID_COURSE_NAME', '课程名需为 1–40 字符');
      const courseId = id(), at = now();
      const result = await run(env, 'INSERT OR IGNORE INTO courses (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', courseId, user.id, name, at, at);
      if (!result.meta.changes) fail(409, 'DUPLICATE_COURSE', '已经有同名课程了');
      return json({ course: publicCourse({ id: courseId, name, created_at: at, updated_at: at }) }, 201);
    }
  }
  const courseMatch = path.match(/^\/api\/courses\/([^/]+)(?:\/(files|queue|search|export))?$/);
  if (courseMatch) {
    const [, courseId, action] = courseMatch;
    const course = await ownedCourse(env, courseId, user.id);
    if (!action && method === 'GET') return json({ course: publicCourse(course), notes: (await rows(env, 'SELECT * FROM notes WHERE course_id=? ORDER BY created_at,id', courseId)).map(publicNote) });
    if (!action && method === 'DELETE') {
      await removeNotes(env, await rows(env, 'SELECT id FROM notes WHERE course_id=?', courseId));
      await run(env, 'DELETE FROM courses WHERE id=? AND user_id=?', courseId, user.id);
      return new Response(null, { status: 204 });
    }
    if (!action && method === 'PATCH') {
      const name = String((await request.json()).name || '').trim();
      if (!name || [...name].length > 40) fail(400, 'INVALID_COURSE_NAME', '课程名需为 1–40 字符');
      const other = await first(env, 'SELECT id FROM courses WHERE user_id=? AND name=? AND id<>?', user.id, name, courseId);
      if (other) fail(409, 'DUPLICATE_COURSE', '已经有同名课程了');
      await run(env, 'UPDATE courses SET name=?,updated_at=? WHERE id=?', name, now(), courseId);
      return json({ course: publicCourse(await ownedCourse(env, courseId, user.id)) });
    }
    if (action === 'files' && method === 'POST') {
      const filename = basename(url.searchParams.get('filename') || '').slice(0, 255);
      const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
      if (!parserForExtension(extension) && extension !== '.zip') fail(400, 'UNSUPPORTED', unsupportedFormatMessage(filename));
      const size = Number(request.headers.get('content-length'));
      if (!request.body || !Number.isFinite(size) || size <= 0 || size > 100 * 1024 * 1024) fail(413, 'FILE_SIZE', '单个文件需在 0–100MB 之间');
      const pending = await first(env, "SELECT COUNT(*) count FROM notes n JOIN courses c ON c.id=n.course_id WHERE c.user_id=? AND n.status='processing'", user.id);
      if (pending.count >= 120) fail(429, 'QUEUE_LIMIT', '待处理文件较多，请等待部分完成后再上传');
      const noteId = id(), at = now(), key = `pending/${user.id}/${noteId}`;
      // 直接流入 R2，不将大文件及整个批次缓冲进 Worker 内存。
      await env.UPLOADS.put(key, request.body, { customMetadata: { filename, noteId } });
      try {
        await env.DB.batch([
          stmt(env, "INSERT INTO notes (id,course_id,title,source_filename,status,created_at,updated_at) VALUES (?,?,?,?,'processing',?,?)", noteId, courseId, titleOf(filename), filename, at, at),
          stmt(env, 'INSERT INTO upload_queue (id,note_id,file_path,created_at,updated_at) VALUES (?,?,?,?,?)', id(), noteId, key, at, at),
          stmt(env, 'UPDATE courses SET updated_at=? WHERE id=?', at, courseId),
        ]);
      } catch (error) { await env.UPLOADS.delete(key); throw error; }
      // 上传记录已经持久化，即使唤醒失败，五分钟恢复任务也会继续处理。
      ctx.waitUntil(kick(env).catch((error) => console.error('队列唤醒失败，将由定时恢复', error.message)));
      return json({ accepted: 1, notes: [{ id: noteId, noteId, title: titleOf(filename), sourceFilename: filename, status: 'processing' }], skipped: [], message: '已加入队列，共 1 个文件' }, 202);
    }
    if (action === 'queue' && method === 'GET') {
      const notes = await rows(env, 'SELECT n.*,q.status queue_status,q.retry_count FROM notes n LEFT JOIN upload_queue q ON q.note_id=n.id WHERE n.course_id=? ORDER BY n.created_at,n.id', courseId);
      const summary = { total: notes.length, done: 0, failed: 0, processing: 0, queued: 0 };
      for (const note of notes) summary[note.status === 'processing' ? note.queue_status === 'queued' ? 'queued' : 'processing' : note.status]++;
      if (summary.processing + summary.queued > 0) ctx.waitUntil(kick(env));
      return json({ active: summary.processing + summary.queued > 0, summary, items: notes.map((n) => ({ ...publicNote(n), noteId: n.id, queueStatus: n.queue_status, attempts: n.attempts, retryCount: n.retry_count || 0 })) });
    }
    if (action === 'search' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim().slice(0, 50);
      if (!query) fail(400, 'INVALID_QUERY', '请输入关键词');
      const needle = query.toLowerCase(), results = [];
      let matchedNotes = 0;
      for (const note of await rows(env, "SELECT id,title,markdown_content FROM notes WHERE course_id=? AND status='done' ORDER BY created_at,id", courseId)) {
        const body = note.markdown_content, lower = body.toLowerCase();
        if (!`${note.title}\n${body}`.toLowerCase().includes(needle)) continue;
        matchedNotes++;
        let cursor = 0, count = 0, occurrence = 0;
        while (count < 3 && results.length < 40) {
          const position = lower.indexOf(needle, cursor);
          if (position < 0) break;
          const headings = body.slice(0, position).match(/^#{1,6}\s+.+$/gm);
          results.push({ noteId: note.id, title: note.title, heading: headings?.at(-1)?.replace(/^#+\s*/, '') || '', snippet: body.slice(Math.max(0, position - 60), position + needle.length + 80).replace(/[*#`]/g, ''), matchCount: lower.split(needle).length - 1, occurrence });
          cursor = position + needle.length; occurrence++; count++;
        }
        if (!count) results.push({ noteId: note.id, title: note.title, heading: '', snippet: `标题匹配：${note.title}`, matchCount: 1, occurrence: 0 });
        if (results.length >= 40) break;
      }
      return json({ query, total: results.length, matchedNotes, results });
    }
    if (action === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') || 'md';
      if (!['md', 'zip'].includes(format)) fail(400, 'INVALID_FORMAT', '仅支持 md 或 zip');
      const notes = await rows(env, "SELECT * FROM notes WHERE course_id=? AND status='done' ORDER BY created_at,id", courseId);
      if (!notes.length) fail(409, 'NO_NOTES', '还没有可导出的笔记');
      const merged = `# ${course.name}\n\n${notes.map(noteMarkdownForDownload).join('\n\n---\n\n')}`;
      if (new TextEncoder().encode(merged).length > 20 * 1024 * 1024) fail(413, 'EXPORT_TOO_LARGE', '课程较大，请分篇下载笔记');
      if (format === 'md') return attachment(merged, `${downloadName(course.name)}-复习笔记.md`);
      const zip = new JSZip();
      notes.forEach((note, index) => zip.file(`${index + 1}-${downloadName(note.title)}.md`, noteMarkdownForDownload(note)));
      zip.file('全部笔记.md', merged);
      return attachment(await zip.generateAsync({ type: 'uint8array' }), `${downloadName(course.name)}-复习笔记.zip`, 'application/zip');
    }
  }
  const noteMatch = path.match(/^\/api\/notes\/([^/]+)(?:\/(download|retry))?$/);
  if (noteMatch) {
    const [, noteId, action] = noteMatch;
    const note = await ownedNote(env, noteId, user.id);
    if (!action && method === 'GET') return json({ note: publicNote(note), course: { id: note.course_id, name: note.course_name }, siblings: await rows(env, 'SELECT id,title,status FROM notes WHERE course_id=? ORDER BY created_at,id', note.course_id) });
    if (!action && method === 'DELETE') {
      await removeNotes(env, [note]);
      await run(env, 'UPDATE courses SET updated_at=? WHERE id=?', now(), note.course_id);
      return new Response(null, { status: 204 });
    }
    if (action === 'download' && method === 'GET') {
      if (note.status !== 'done') fail(409, 'NOTE_NOT_READY', '笔记尚未完成');
      return attachment(noteMarkdownForDownload(note), `${downloadName(note.title)}.md`);
    }
    if (action === 'retry' && method === 'POST') {
      if (note.status !== 'failed') fail(409, 'NOTE_NOT_FAILED', '只有失败笔记可以重试');
      if (!note.raw_text) fail(409, 'FILE_EXPIRED', '没有提取文本，请重新上传');
      const at = now();
      await env.DB.batch([
        stmt(env, "UPDATE notes SET status='processing',error_message=NULL,attempts=0,updated_at=? WHERE id=?", at, noteId),
        stmt(env, "INSERT INTO upload_queue (id,note_id,file_path,status,created_at,updated_at) VALUES (?,?,'','queued',?,?) ON CONFLICT(note_id) DO UPDATE SET status='queued',retry_count=0,error_message=NULL,generation_state='{}',available_at=0,updated_at=excluded.updated_at", id(), noteId, at, at),
      ]);
      ctx.waitUntil(kick(env));
      return json({ note: { id: noteId, title: note.title, status: 'processing' } }, 202);
    }
  }
  fail(404, 'NOT_FOUND', '接口不存在');
}
