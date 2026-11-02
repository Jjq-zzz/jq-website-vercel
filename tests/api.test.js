/**
 * 自包含 API 集成测试：启动隔离的后端（独立端口 + 临时数据目录），
 * 覆盖登录、课程、批量上传、失败隔离、结构化笔记、搜索、下载、导出。
 *
 * 运行前先生成示例课件：npm run fixtures
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeFormatFixtures } from './format-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const PORT = 41000 + (process.pid % 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `course-notes-test-${process.pid}-${Date.now()}`);
const LOG_FILE = path.join(DATA_DIR, 'server.log');

let child;
let logFd;
let userId;
const tokens = new Map();
let courseId;

async function api(pathname, { method = 'GET', body, userId: asUser, form } = {}) {
  const headers = {};
  if (asUser) headers.Authorization = `Bearer ${tokens.get(asUser) || asUser}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  if (payload?.user?.token) tokens.set(payload.user.id, payload.user.token);
  return { res, payload };
}

async function upload(files) {
  const form = new FormData();
  for (const filename of files) {
    const buffer = await fsp.readFile(path.join(FIXTURES, filename));
    form.append('files', new Blob([buffer]), filename);
  }
  return api(`/api/courses/${courseId}/files`, { method: 'POST', userId, form });
}

async function waitQueue(timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    const { payload } = await api(`/api/courses/${courseId}/queue`, { userId });
    last = payload;
    if (!payload.active) return payload;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`队列等待超时：${JSON.stringify(last)}`);
}

test.before(async () => {
  assert.ok(
    fs.existsSync(path.join(FIXTURES, '01-流行病学概述.pptx')),
    '缺少示例课件，请先运行 npm run fixtures',
  );
  await fsp.mkdir(DATA_DIR, { recursive: true });
  logFd = fs.openSync(LOG_FILE, 'w');
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      DB_PATH: path.join(DATA_DIR, 'course-notes.db'),
      AI_API_KEY: '',
      AI_MODEL: '',
      OPENAI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      OPENAI_MODEL: '',
      LOCAL_ENGINE_DELAY_MS: '0',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', logFd, logFd],
  });

  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // 等待服务启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`测试服务启动失败，日志：\n${fs.readFileSync(LOG_FILE, 'utf8').slice(-3000)}`);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  try {
    if (logFd) fs.closeSync(logFd);
  } catch {
    // 日志句柄已关闭时无需处理。
  }
  await fsp.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

test('健康检查与本地引擎状态', async () => {
  const { res, payload } = await api('/api/health');
  assert.equal(res.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.ai.mode, 'local-fallback');
});

test('昵称登录、登录态校验、未授权拦截', async () => {
  const nickname = `测试同学${Date.now().toString().slice(-5)}`;
  const login = await api('/api/auth/login', { method: 'POST', body: { nickname, password: '测试密码12345', register: true } });
  assert.equal(login.res.status, 200);
  assert.ok(login.payload.user.id);
  userId = login.payload.user.id;

  const me = await api('/api/auth/me', { userId });
  assert.equal(me.payload.user.nickname, nickname);

  // 同一昵称再次登录必须复用同一账号，课程与笔记才能留住。
  const relogin = await api('/api/auth/login', { method: 'POST', body: { nickname, password: '测试密码12345' } });
  assert.equal(relogin.payload.user.id, userId);

  const anonymous = await api('/api/courses');
  assert.equal(anonymous.res.status, 401);
});

test('新建课程与重名保护', async () => {
  const created = await api('/api/courses', { method: 'POST', userId, body: { name: '预防医学' } });
  assert.equal(created.res.status, 201);
  assert.equal(created.payload.course.name, '预防医学');
  courseId = created.payload.course.id;

  const duplicate = await api('/api/courses', { method: 'POST', userId, body: { name: '预防医学' } });
  assert.equal(duplicate.res.status, 409);
});

test('批量上传立即入队，单文件失败不影响其他文件', async () => {
  const uploadRes = await upload([
    '01-流行病学概述.pptx',
    '02-传染病预防.pptx',
    '损坏的课件.pptx',
  ]);
  assert.equal(uploadRes.res.status, 202, JSON.stringify(uploadRes.payload));
  assert.equal(uploadRes.payload.accepted, 3);

  const queue = await waitQueue();
  assert.equal(queue.active, false);
  assert.equal(queue.summary.done, 2);
  assert.equal(queue.summary.failed, 1);

  const detail = await api(`/api/courses/${courseId}`, { userId });
  assert.equal(detail.payload.notes.length, 3);
  const failed = detail.payload.notes.find((note) => note.status === 'failed');
  assert.ok(failed.errorMessage);
});

test('笔记为结构化 Markdown，且不泄露原始文本', async () => {
  const detail = await api(`/api/courses/${courseId}`, { userId });
  const done = detail.payload.notes.filter((note) => note.status === 'done');
  const note = await api(`/api/notes/${done[0].id}`, { userId });
  const markdown = note.payload.note.markdownContent;
  assert.match(markdown, /## /);
  assert.match(markdown, /🎯 本章速记/);
  assert.match(markdown, /📌 必背|⚠️ 考点/);
  assert.ok(note.payload.note.summary.length > 0);
  assert.ok(!note.payload.note.summary.startsWith('一、'), '摘要不应以 Markdown 标题开头');
  assert.match(note.payload.note.summary, /流行病学/);
  assert.equal(note.payload.note.rawText, undefined);
  assert.equal(note.payload.note.raw_text, undefined);
});

test('课程内全文搜索命中并可跳转', async () => {
  const search = await api(`/api/courses/${courseId}/search?q=${encodeURIComponent('流行病学')}`, {
    userId,
  });
  assert.equal(search.res.status, 200);
  assert.ok(search.payload.total > 0);
  assert.ok(search.payload.results[0].noteId);
  assert.ok(search.payload.results[0].snippet);
  assert.match(search.payload.results[0].heading, /流行病学/);
  assert.ok(!search.payload.results[0].snippet.includes(' - '), '搜索片段应清理列表符号');
});

test('单篇 Markdown 下载与整课导出', async () => {
  const detail = await api(`/api/courses/${courseId}`, { userId });
  const done = detail.payload.notes.find((note) => note.status === 'done');

  const download = await fetch(`${BASE}/api/notes/${done.id}/download`, {
    headers: { Authorization: `Bearer ${tokens.get(userId)}` },
  });
  assert.equal(download.status, 200);
  assert.match(await download.text(), /^# /);

  const merged = await fetch(`${BASE}/api/courses/${courseId}/export?format=md`, {
    headers: { Authorization: `Bearer ${tokens.get(userId)}` },
  });
  assert.equal(merged.status, 200);
  assert.match(await merged.text(), /# 预防医学/);

  const zipped = await fetch(`${BASE}/api/courses/${courseId}/export?format=zip`, {
    headers: { Authorization: `Bearer ${tokens.get(userId)}` },
  });
  assert.equal(zipped.status, 200);
  const entries = new AdmZip(Buffer.from(await zipped.arrayBuffer())).getEntries();
  assert.ok(entries.length >= 4);
});

test('他人课程与笔记不可访问', async () => {
  const other = await api('/api/auth/login', { method: 'POST', body: { nickname: '另一个同学', password: '测试密码12345', register: true } });
  const otherId = other.payload.user.id;
  const inaccessible = await api(`/api/courses/${courseId}`, { userId: otherId });
  assert.equal(inaccessible.res.status, 404);

  const detail = await api(`/api/courses/${courseId}`, { userId });
  const noteId = detail.payload.notes[0].id;
  const note = await api(`/api/notes/${noteId}`, { userId: otherId });
  assert.equal(note.res.status, 404);
});

test('ZIP 解压与 PDF 解析', async () => {
  const zipUpload = await upload(['课堂资料包.zip']);
  assert.equal(zipUpload.res.status, 202);
  assert.equal(zipUpload.payload.accepted, 3, 'ZIP 内的说明 TXT 现在也应作为文档处理');

  const pdfUpload = await upload(['英文示例-流行病学.pdf']);
  assert.equal(pdfUpload.res.status, 202);
  assert.equal(pdfUpload.payload.accepted, 1);

  const queue = await waitQueue(30000);
  assert.equal(queue.summary.done, 6);
  assert.equal(queue.summary.failed, 1);
});

test('损坏课件已清理且提示重新上传，不创建重复笔记', async () => {
  const detail = await api(`/api/courses/${courseId}`, { userId });
  const failed = detail.payload.notes.find((note) => note.status === 'failed');
  const retry = await api(`/api/notes/${failed.id}/retry`, { method: 'POST', userId });
  assert.equal(failed.canRetry, false);
  assert.equal(retry.res.status, 409);
  assert.equal(retry.payload.error.code, 'FILE_EXPIRED');
  const queue = await waitQueue(15000);
  assert.equal(queue.summary.failed, 1);
  assert.equal(queue.summary.done, 6);

  const after = await api(`/api/courses/${courseId}`, { userId });
  assert.equal(after.payload.notes.length, 7, '重试不应创建暗重复笔记');
});

test('隐私：成功与最终失败课件、ZIP 及上传临时文件均已删除', async () => {
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  const files = await fsp.readdir(uploadsDir).catch(() => []);
  assert.equal(files.length, 0, `上传目录残留：${files.join(', ')}`);
  assert.deepEqual(await fsp.readdir(path.join(DATA_DIR, 'tmp')), []);
});

test('Word、表格、旧版 PPT、文本及 EPUB 可混合上传生成笔记，ZIP 使用相同格式规则', async () => {
  const fixtures = await makeFormatFixtures();
  const form = new FormData();
  const filenames = ['课程讲义.docx', '课程表格.xls', '旧版课程.ppt', '中文讲义.txt', '课程电子书.epub', '富文本讲义.rtf', '课程表格.csv'];
  for (const filename of filenames) form.append('files', new Blob([fixtures.get(filename)]), filename);
  form.append('files', new Blob(['损坏的 Word']), '损坏讲义.docx');
  form.append('files', new Blob(['专有文档']), '讲义.wps');
  const result = await api(`/api/courses/${courseId}/files`, { method: 'POST', userId, form });
  assert.equal(result.res.status, 202);
  assert.equal(result.payload.accepted, 8);
  assert.equal(result.payload.skipped.length, 1);
  assert.match(result.payload.skipped[0].reason, /另存/);
  let queue = await waitQueue();
  assert.equal(queue.summary.done, 13);
  assert.equal(queue.summary.failed, 2);

  const zip = new AdmZip();
  for (const filename of ['课程讲义.docx', '课程表格.xlsx', '复习提纲.md']) zip.addFile(`资料/${filename}`, fixtures.get(filename));
  const zipForm = new FormData();
  zipForm.append('files', new Blob([zip.toBuffer()]), '混合文档资料.zip');
  const zipped = await api(`/api/courses/${courseId}/files`, { method: 'POST', userId, form: zipForm });
  assert.equal(zipped.res.status, 202);
  assert.equal(zipped.payload.accepted, 3);
  queue = await waitQueue();
  assert.equal(queue.summary.done, 16);
  assert.equal(queue.summary.failed, 2);

  const generated = await api(`/api/notes/${result.payload.notes[0].id}`, { userId });
  assert.match(generated.payload.note.markdownContent, /## /);
  assert.match(generated.payload.note.markdownContent, /🎯 本章速记/);
  assert.equal(generated.payload.note.rawText, undefined);
  assert.deepEqual(await fsp.readdir(path.join(DATA_DIR, 'uploads')), []);
  assert.deepEqual(await fsp.readdir(path.join(DATA_DIR, 'tmp')), []);
});

test('删除笔记检查归属并更新数量，删除课程级联清理且不影响其他课程', async () => {
  const detail = await api(`/api/courses/${courseId}`, { userId });
  const note = detail.payload.notes.find((item) => item.status === 'done');
  const other = await api('/api/auth/login', { method: 'POST', body: { nickname: '删除权限测试同学', password: '测试密码12345', register: true } });
  const denied = await api(`/api/notes/${note.id}`, { method: 'DELETE', userId: other.payload.user.id });
  assert.equal(denied.res.status, 404);
  assert.equal((await api(`/api/notes/${note.id}`, { userId })).res.status, 200);
  const deleted = await api(`/api/notes/${note.id}`, { method: 'DELETE', userId });
  assert.equal(deleted.res.status, 204);
  assert.equal((await api(`/api/notes/${note.id}`, { userId })).res.status, 404);
  const after = await api(`/api/courses/${courseId}`, { userId });
  assert.equal(after.payload.notes.length, detail.payload.notes.length - 1);

  const temporary = await api('/api/courses', { method: 'POST', userId, body: { name: '待删除课程' } });
  const targetId = temporary.payload.course.id;
  const form = new FormData();
  form.append('files', new Blob(['课件定义：测试删除过程中清理文件。']), '待删除讲义.txt');
  const uploaded = await api(`/api/courses/${targetId}/files`, { method: 'POST', userId, form });
  const removeCourse = await api(`/api/courses/${targetId}`, { method: 'DELETE', userId });
  assert.equal(removeCourse.res.status, 204);
  assert.equal((await api(`/api/courses/${targetId}`, { userId })).res.status, 404);
  assert.equal((await api(`/api/notes/${uploaded.payload.notes[0].id}`, { userId })).res.status, 404);
  assert.equal((await api(`/api/courses/${courseId}`, { userId })).res.status, 200);
});


test('密码校验、昵称保护、伪造身份与退出会话', async () => {
  const nickname = '安全验证同学';
  const created = await api('/api/auth/login', { method: 'POST', body: { nickname, password: '安全测试密码123', register: true } });
  assert.equal(created.res.status, 200);
  assert.equal(created.payload.user.password_hash, undefined);
  const token = created.payload.user.token;
  const wrong = await api('/api/auth/login', { method: 'POST', body: { nickname, password: '这是错误密码123' } });
  assert.equal(wrong.res.status, 401);
  const duplicate = await api('/api/auth/login', { method: 'POST', body: { nickname, password: '其他密码12345', register: true } });
  assert.equal(duplicate.res.status, 409);
  const weak = await api('/api/auth/login', { method: 'POST', body: { nickname: '弱密码用户', password: '123', register: true } });
  assert.equal(weak.res.status, 400);
  const forged = await fetch(`${BASE}/api/courses`, { headers: { 'x-user-id': created.payload.user.id } });
  assert.equal(forged.status, 401);
  const session = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(session.status, 200);
  const loggedOut = await api('/api/auth/logout', { method: 'POST', userId: created.payload.user.id });
  assert.equal(loggedOut.res.status, 204);
  const expired = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(expired.status, 401);
});

test('旧版账号不能通过公开登录或注册设置密码', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'course-notes.db'));
  try {
    db.prepare('INSERT INTO users (id, nickname, nickname_key, created_at) VALUES (?, ?, ?, ?)')
      .run('legacy-test-user', '旧版同学', '旧版同学', new Date().toISOString());
    const login = await api('/api/auth/login', { method: 'POST', body: { nickname: '旧版同学', password: '试图认领密码123' } });
    assert.equal(login.res.status, 403);
    const signup = await api('/api/auth/login', { method: 'POST', body: { nickname: '旧版同学', password: '试图认领密码123', register: true } });
    assert.equal(signup.res.status, 409);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get('legacy-test-user').password_hash, null);
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    assert.match(user.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash.length, 64);
  } finally { db.close(); }
});
