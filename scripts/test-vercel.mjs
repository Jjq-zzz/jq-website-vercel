/** 使用隔离 libSQL、模拟 Blob 与队列验证 Vercel 适配，不连接真实账号。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import http2 from 'node:http2';
import selfsigned from 'selfsigned';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createDatabase } from '../vercel/database.js';
import { createEnvironment } from '../vercel/environment.js';
import { consumeNote } from '../vercel/consumer.js';
import { handleRequest } from '../vercel/handler.js';
import { makeFormatFixtures } from '../tests/format-fixtures.mjs';
import { upload } from '@vercel/blob/client';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, '.tmp-build'), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, '.tmp-build/vercel-test-'));
const database = createDatabase('file::memory:');
await database.migrate();
const objects = new Map(), messages = new Map(), uploads = new Map();
let timer, server, aiServer, browser, token, peak = 0, active = 0, running = false;
const background = new Set();
let logs = '';
const attempts = new Map();
const sockets = new Set();
const blob = {
  async get(key) { const value = objects.get(key); return value ? { stream: new Blob([value.data]).stream() } : null; },
  async head(key) { const value = objects.get(key); if (!value) throw new Error('文件不存在'); return { size: value.data.length, pathname: key }; },
  async del(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  async list() { return { hasMore: false, blobs: [...objects].map(([pathname, value]) => ({ pathname, uploadedAt: value.at })) }; },
};
const env = createEnvironment({ database, blob, variables: { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_localstore_localtesttoken', CRON_SECRET: 'local-maintenance-test', BYOK_SECRET: 'ab'.repeat(32) },
  async publish(message, options = {}) {
    if (!messages.has(options.idempotencyKey)) messages.set(options.idempotencyKey, { message, due: Date.now() + (options.delaySeconds || 0) * 1000, done: false });
  },
});
async function readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }
async function api(route, options = {}) {
  const response = await fetch(`${base}/api${route}`, { method: options.method || 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}
async function settle(courseId) {
  for (let i = 0; i < 300; i++) {
    const result = await api(`/courses/${courseId}/queue`);
    if (!result.data.active) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`任务未结束：${logs}`);
}
async function pushFile(courseId, filename, bytes) {
  const ticket = await api(`/courses/${courseId}/upload-ticket`, { method: 'POST', body: { filename, size: bytes.length } });
  assert.equal(ticket.response.status, 200, JSON.stringify(ticket.data));
  const uploaded = await upload(ticket.data.pathname, bytes, { access: 'private', multipart: bytes.length > 8 * 1024 * 1024,
    handleUploadUrl: `${base}/api/blob-upload`, clientPayload: JSON.stringify({ ticketId: ticket.data.id, token }) });
  assert.equal(uploaded.pathname, ticket.data.pathname);
  const completed = await api(`/uploads/${ticket.data.id}/complete`, { method: 'POST', body: {} });
  assert.equal(completed.response.status, 202, JSON.stringify(completed.data));
  return ticket.data;
}
let base;
try {
  const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
  // 仅此独立测试进程接受本机自签名证书，不修改系统或生产配置。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  server = http2.createSecureServer({ key: certificate.private, cert: certificate.cert, allowHTTP1: true }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/test/blob')) {
        const pathname = url.searchParams.get('pathname');
        const action = request.headers['x-mpu-action'];
        let result;
        const bytes = await readBody(request);
        if (!action && request.headers['x-content-length'] && bytes.length !== Number(request.headers['x-content-length'])) {
          console.error('浏览器模拟上传体积不一致', { received: bytes.length, expected: request.headers['x-content-length'], contentType: request.headers['content-type'] });
        }
        if (action === 'create') {
          const key = crypto.randomUUID(); uploads.set(key, new Map()); result = { key, uploadId: key };
        } else if (action === 'upload') {
          uploads.get(request.headers['x-mpu-upload-id']).set(Number(request.headers['x-mpu-part-number']), bytes);
          result = { etag: crypto.randomUUID() };
        } else {
          const data = action === 'complete' ? Buffer.concat([...uploads.get(request.headers['x-mpu-upload-id'])].sort((a, b) => a[0] - b[0]).map((p) => p[1])) : bytes;
          objects.set(pathname, { data, at: new Date() });
          result = { pathname, url: `${base}/private/${pathname}`, downloadUrl: `${base}/private/${pathname}`, contentType: 'application/octet-stream', contentDisposition: 'attachment' };
        }
        response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); response.end(JSON.stringify(result)); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const target = path.join(root, 'dist/client', url.pathname === '/' ? 'index.html' : url.pathname);
        let bytes;
        try { bytes = await fs.readFile(target); } catch { bytes = await fs.readFile(path.join(root, 'dist/client/index.html')); }
        response.setHeader('content-type', url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html'); response.end(bytes); return;
      }
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readBody(request);
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !key.startsWith(':')));
      const result = await handleRequest(new Request(`${base}${request.url}`, { method: request.method, headers, body }), env, { waitUntil: (promise) => {
        background.add(promise); promise.catch((error) => { logs += error.message; }).finally(() => background.delete(promise));
      } });
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      if (result.body) await pipeline(Readable.fromWeb(result.body), response); else response.end();
    } catch (error) { logs += `${error.stack}\n`; response.writeHead(500); response.end('测试服务异常'); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `https://127.0.0.1:${server.address().port}`;
  process.env.VERCEL_BLOB_API_URL = `${base}/test/blob`;
  process.env.VERCEL_BLOB_CALLBACK_URL = base;
  timer = setInterval(async () => {
    if (running) return; running = true;
    try {
      const due = [...messages.values()].filter((message) => !message.done && message.due <= Date.now()).slice(0, 4);
      await Promise.all(due.map(async (item) => {
        item.done = true;
        try { await consumeNote(env, item.message); }
        catch { item.done = false; item.due = Date.now() + 500; }
      }));
    } catch (error) { logs += error.stack; }
    finally { running = false; }
  }, 600);
  let result = await api('/auth/login', { method: 'POST', body: { nickname: 'Vercel测试同学', password: '测试密码123456', register: true } });
  assert.equal(result.response.status, 200); token = result.data.user.token;
  assert.equal((await api('/auth/login', { method: 'POST', body: { nickname: 'Vercel测试同学', password: '错误的密码123' } })).response.status, 401);
  const courseId = (await api('/courses', { method: 'POST', body: { name: 'Vercel格式验收' } })).data.course.id;
  const fixtures = await makeFormatFixtures();
  for (const name of ['课程讲义.docx', '课程表格.xls', '旧版课程.ppt', '中文讲义.txt', '课程电子书.epub']) await pushFile(courseId, name, fixtures.get(name));
  await pushFile(courseId, '损坏.pptx', Buffer.from('损坏内容'));
  let queue = await settle(courseId);
  assert.equal(queue.summary.done, 5, JSON.stringify(queue)); assert.equal(queue.summary.failed, 1, JSON.stringify(queue));
  assert.equal(objects.size, 0, '完成及损坏文件均应从私有存储删除');
  await pushFile(courseId, '大课件.txt', Buffer.alloc(9 * 1024 * 1024, 'a'));
  queue = await settle(courseId); assert.equal(queue.summary.failed, 2);
  assert.equal(objects.size, 0, '大文件解析失败后也应清理');
  const { default: JSZip } = await import('jszip');
  const archive = new JSZip(); archive.file('讲义.docx', fixtures.get('课程讲义.docx')); archive.file('损坏.pptx', Buffer.from('损坏'));
  await pushFile(courseId, '混合.zip', await archive.generateAsync({ type: 'nodebuffer' }));
  queue = await settle(courseId); assert.equal(queue.summary.done, 6); assert.equal(queue.summary.failed, 3);
  const note = (await api(`/courses/${courseId}`)).data.notes.find((item) => item.status === 'done');
  assert.equal((await api(`/notes/${note.id}`)).data.note.engine, 'local-fallback', '无用户或全局密钥时使用本地模式');
  assert.equal((await api(`/notes/${note.id}/download`)).response.status, 200);
  assert.equal((await api(`/courses/${courseId}/export?format=zip`)).response.status, 200);
  aiServer = http.createServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString());
    const text = body.messages[0].content;
    const label = text.includes('持续失败场景') ? '持续失败' : text.includes('重试场景') ? '重试' : '正常';
    attempts.set(label, (attempts.get(label) || 0) + 1); active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1200)); active--;
    response.setHeader('content-type', 'application/json');
    if (label === '持续失败' || label === '重试' && attempts.get(label) < 3) { response.writeHead(500); response.end(JSON.stringify({ error: { message: '模拟失败' } })); return; }
    const content = '## 流行病学\n\n**定义** 📌 必背\n\n⚠️ 考点：定义。\n\n### 📖 老师举例\n\n课程案例。\n\n## 🎯 本章速记\n\n- 定义\n- 原理\n- 方法\n- 应用\n- 案例';
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  aiServer.listen(0, '127.0.0.1'); await once(aiServer, 'listening');
  env.AI_API_KEY = 'mock-local-key'; env.AI_BASE_URL = `http://127.0.0.1:${aiServer.address().port}/v1`;
  const aiCourse = (await api('/courses', { method: 'POST', body: { name: 'Vercel AI验收' } })).data.course.id;
  for (const [name, text] of [['重试.txt', '重试场景'], ['失败.txt', '持续失败场景'], ['正常.txt', '正常课程内容'], ['正常2.txt', '其他课程内容']]) await pushFile(aiCourse, name, Buffer.from(text));
  queue = await settle(aiCourse);
  assert.equal(queue.summary.done, 3, JSON.stringify(queue)); assert.equal(queue.summary.failed, 1, JSON.stringify(queue));
  assert.equal(attempts.get('重试'), 3); assert.equal(attempts.get('持续失败'), 3); assert.ok(peak <= 2);
  assert.equal(objects.size, 0);
  browser = spawn(process.execPath, ['tests/e2e-browser.mjs'], { cwd: root, env: { ...process.env, BASE_URL: base, BYOK_E2E: '1', VERCEL_BLOB_MOCK_URL: `${base}/test/blob` }, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout.on('data', (chunk) => { logs += chunk; }); browser.stderr.on('data', (chunk) => { logs += chunk; });
  const [code] = await once(browser, 'exit'); assert.equal(code, 0, logs.slice(-6000));
  assert.equal((await api('/auth/logout', { method: 'POST' })).response.status, 204);
  assert.equal((await api('/auth/me')).response.status, 401);
  console.log(`Vercel 本地验收通过：密码、真实 Blob SDK 授权及直传、9MB 分片上传、libSQL、ZIP、文件清理、两次重试、全局并发 ${peak} 和完整浏览器操作。`);
} catch (error) { console.error(logs.slice(-7000)); throw error; }
finally {
  clearInterval(timer);
  for (let i = 0; running && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.allSettled([...background]);
  browser?.kill();
  for (const socket of sockets) socket.destroy();
  server?.close(); aiServer?.closeAllConnections(); aiServer?.close();
  database.client.close();
  assert.equal(path.dirname(directory), path.join(root, '.tmp-build'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
