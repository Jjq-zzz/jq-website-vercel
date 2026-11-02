/** 使用真实本地 workerd、D1、R2 与闹钟，解析器以同一 Node 容器入口替代 Docker。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { makeFormatFixtures } from '../tests/format-fixtures.mjs';
import http from 'node:http';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(root, '.tmp-build', 'cf-test-'));
const port = 47000 + process.pid % 1000;
const base = `http://127.0.0.1:${port}`;
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const processes = [];
let logs = '';
let mockServer;
let active = 0, peak = 0, userKeyCalls = 0;
const attempts = new Map();
const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory, CI: 'true', WRANGLER_SEND_METRICS: 'false', AI_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' };
function start(file, args, extra = {}) {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  processes.push(child);
  return child;
}
async function command(args) {
  const child = start(cli, args);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, logs.slice(-5000));
}
async function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') await new Promise((resolve) => { const command = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); command.on('exit', resolve); command.on('error', resolve); });
  else { const ended = once(child, 'exit'); child.kill(); await ended; }
}
let token;
async function api(route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}
async function settled(courseId) {
  for (let i = 0; i < 200; i++) {
    const result = await api(`/courses/${courseId}/queue`);
    if (!result.data.active) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`云端队列超时：${logs.slice(-5000)}`);
}
try {
  const config = JSON.parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  config.main = path.join(root, config.main);
  config.assets.directory = path.join(root, 'dist/client');
  config.d1_databases[0].migrations_dir = path.join(root, 'cloudflare/migrations');
  delete config.containers;
  delete config.triggers;
  config.vars = { ...config.vars, AI_API_KEY: '', BYOK_SECRET: 'ab'.repeat(32), PARSER_DEV_URL: `http://127.0.0.1:${port + 1}` };
  const configPath = path.join(directory, 'wrangler.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  start(path.join(root, 'cloudflare/parser/server.mjs'), [], { PARSER_HOST: '127.0.0.1', PARSER_PORT: String(port + 1) });
  await command(['d1', 'migrations', 'apply', 'course-notes', '--local', '--config', configPath, '--persist-to', path.join(directory, 'state')]);
  const devArgs = ['dev', '--config', configPath, '--persist-to', path.join(directory, 'state'), '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'error'];
  let worker = start(cli, devArgs);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* 等待本地运行时启动。 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs.slice(-6000));
  let result = await api('/auth/login', { method: 'POST', body: { nickname: '云端测试同学', password: '云端密码123456', register: true } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  token = result.data.user.token;
  const firstToken = token;
  assert.equal((await api('/settings/ai-key')).data.configured, false);
  result = await api('/settings/ai-key', { method: 'PUT', body: { apiKey: 'sk-云端测试-abcd' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.masked, '••••abcd');
  assert.equal((await api('/auth/me')).data.user.aiKeyConfigured, true);
  result = await api('/auth/login', { method: 'POST', body: { nickname: '隔离测试用户', password: '隔离测试密码123', register: true } });
  token = result.data.user.token;
  assert.equal((await api('/settings/ai-key')).data.configured, false);
  token = undefined;
  assert.equal((await api('/settings/ai-key')).response.status, 401);
  assert.equal((await api('/settings/ai-key', { method: 'PUT', body: {} })).response.status, 401);
  token = firstToken;
  assert.equal((await api('/settings/ai-key', { method: 'PUT', body: { apiKey: '' } })).data.configured, false);

  result = await api('/auth/login', { method: 'POST', body: { nickname: '云端测试同学', password: '错误的密码123' } });
  assert.equal(result.response.status, 401);
  result = await api('/courses', { method: 'POST', body: { name: '云端格式验收' } });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  const courseId = result.data.course.id;
  const fixtures = await makeFormatFixtures();
  const files = ['课程讲义.docx', '课程表格.xls', '旧版课程.ppt', '中文讲义.txt', '课程电子书.epub'];
  for (const filename of files) {
    result = await api(`/courses/${courseId}/files?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: fixtures.get(filename), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(result.response.status, 202, JSON.stringify(result.data));
  }
  result = await api(`/courses/${courseId}/files?filename=broken.pptx`, { method: 'POST', body: Buffer.from('损坏内容'), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(result.response.status, 202);
  const queue = await settled(courseId);
  assert.equal(queue.summary.done, 5, JSON.stringify(queue));
  assert.equal(queue.summary.failed, 1, JSON.stringify(queue));
  const { default: JSZip } = await import('jszip');
  const archive = new JSZip();
  archive.file('讲义.docx', fixtures.get('课程讲义.docx'));
  archive.file('损坏.pptx', Buffer.from('损坏内容'));
  result = await api(`/courses/${courseId}/files?filename=mixed.zip`, { method: 'POST', body: await archive.generateAsync({ type: 'nodebuffer' }), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(result.response.status, 202);
  const zipQueue = await settled(courseId);
  assert.equal(zipQueue.summary.done, 6, JSON.stringify(zipQueue));
  assert.equal(zipQueue.summary.failed, 2, JSON.stringify(zipQueue));
  const course = (await api(`/courses/${courseId}`)).data;
  const note = course.notes.find((n) => n.status === 'done');
  const reading = await api(`/notes/${note.id}`);
  assert.match(reading.data.note.markdownContent, /## /);
  assert.equal(reading.data.note.engine, 'local-fallback');
  const search = await api(`/courses/${courseId}/search?q=${encodeURIComponent('课程')}`);
  assert.ok(search.data.total > 0);
  assert.equal((await api(`/notes/${note.id}/download`)).response.status, 200);
  assert.equal((await api(`/courses/${courseId}/export?format=zip`)).response.status, 200);
  assert.equal((await api('/auth/me')).response.status, 200);
  assert.equal((await api(`/notes/${note.id}`, { method: 'DELETE' })).response.status, 204);
  assert.equal((await api(`/notes/${note.id}`)).response.status, 404);
  assert.equal((await api(`/courses/${courseId}`, { method: 'DELETE' })).response.status, 204);
  assert.equal((await api('/auth/logout', { method: 'POST' })).response.status, 204);
  assert.equal((await api('/auth/me')).response.status, 401);
  // 第二阶段使用本机模拟 AI，验证实际 SDK、并发、自动重试和闹钟恢复。
  mockServer = http.createServer(async (request, response) => {
    let source = '';
    for await (const chunk of request) source += chunk;
    if (request.headers.authorization === 'Bearer mock-user-test-key') userKeyCalls += 1;
    const prompt = JSON.parse(source).messages[0].content;
    const label = prompt.includes('持续失败场景') ? '持续失败' : prompt.includes('重试场景') ? '重试' : prompt.includes('截断场景') ? '截断' : '正常';
    attempts.set(label, (attempts.get(label) || 0) + 1);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 500));
    active--;
    response.setHeader('content-type', 'application/json');
    if (label === '持续失败' || label === '重试' && attempts.get(label) <= 2) {
      response.writeHead(500); response.end(JSON.stringify({ error: { message: '模拟接口暂时异常' } })); return;
    }
    const markdown = '## 流行病学课程要点\n\n**定义** 📌 必背\n\n⚠️ 考点：课程定义。\n\n### 📖 老师举例\n\n课堂案例。\n\n## 🎯 本章速记\n\n- 定义\n- 原理\n- 方法\n- 应用\n- 案例';
    const raw = prompt.split('---')[1];
    response.end(JSON.stringify({ choices: [{ message: { content: markdown }, finish_reason: label === '截断' && raw.length > 1800 ? 'length' : 'stop' }] }));
  });
  mockServer.listen(port + 2, '127.0.0.1');
  await once(mockServer, 'listening');
  await stop(worker);
  config.vars.AI_API_KEY = 'local-mock-test-key';
  config.vars.AI_BASE_URL = `http://127.0.0.1:${port + 2}/v1`;
  await fs.writeFile(configPath, JSON.stringify(config));
  worker = start(cli, devArgs);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 等待重启。 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  result = await api('/auth/login', { method: 'POST', body: { nickname: '云端测试同学', password: '云端密码123456' } });
  assert.equal(result.response.status, 200);
  token = result.data.user.token;
  await api('/settings/ai-key', { method: 'PUT', body: { apiKey: 'mock-user-test-key' } });
  const aiCourse = (await api('/courses', { method: 'POST', body: { name: 'AI 持久化队列验收' } })).data.course.id;
  for (const [filename, text] of [['重试.txt', '重试场景：课程要点'], ['失败.txt', '持续失败场景：课程要点'], ['正常.txt', '正常课程'], ['截断.txt', '截断场景' + '长段落'.repeat(900)]]) {
    const uploaded = await api(`/courses/${aiCourse}/files?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: Buffer.from(text), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(uploaded.response.status, 202);
  }
  const aiQueue = await settled(aiCourse);
  assert.equal(aiQueue.summary.done, 3, JSON.stringify(aiQueue));
  assert.equal(aiQueue.summary.failed, 1, JSON.stringify(aiQueue));
  assert.equal(attempts.get('重试'), 3);
  assert.equal(attempts.get('持续失败'), 3);
  assert.ok(userKeyCalls > 0, '队列必须使用用户密钥调用模拟模型');
  assert.ok(peak <= 2, `AI 并发不能超过 2，实际 ${peak}`);
  // 重启本地运行时后，D1 数据及登录凭证仍可使用。
  await stop(worker);
  worker = start(cli, devArgs);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 等待恢复。 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal((await api('/auth/me')).response.status, 200);
  assert.equal((await api(`/courses/${aiCourse}/queue`)).data.summary.done, 3);
  result = await api(`/courses/${aiCourse}/files?filename=recovery.txt`, { method: 'POST', body: Buffer.from('重启恢复课程内容'), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(result.response.status, 202);
  await stop(worker);
  worker = start(cli, devArgs);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 等待队列恢复。 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal((await settled(aiCourse)).summary.done, 4, '未完成任务应在重启后恢复');
  const browser = start(path.join(root, 'tests/e2e-browser.mjs'), [], { BASE_URL: base, BYOK_E2E: '1' });
  const [browserCode] = await once(browser, 'exit');
  assert.equal(browserCode, 0, logs.slice(-6000));
  console.log('Cloudflare AI 与浏览器验收通过：并发最多 2、失败重试两次、截断缩块、重启后数据持久化、流式上传和完整网页操作。');
  console.log('Cloudflare 本地集成验收通过：D1、R2、持久化队列、密码登录、多格式解析、损坏隔离、搜索、导出与删除。');
} catch (error) { console.error(logs.slice(-9000)); throw error; }
finally {
  for (const child of processes.reverse()) await stop(child);
  mockServer?.closeAllConnections();
  mockServer?.close();
  assert.equal(path.dirname(directory), path.join(root, '.tmp-build'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
