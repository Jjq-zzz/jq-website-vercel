const authTokens = new Map();
/** 使用真实 SDK 和本机模拟接口，验证固定提示词、限流、重试及文件清理。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = await fs.mkdtemp(path.join(os.tmpdir(), 'course-notes-ai-'));
// 由系统分配可用端口，避免 Windows 保留端口导致启动失败。
const probe = http.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const PORT = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = new Map();
const prompts = [];
let active = 0;
let peak = 0;
let allowRecovery = false;
const rawRequests = [];
let child;
let logs = '';
let userId;
let courseId;

const expectedPrompt = `你是一个资深大学生学习助手，擅长把老师的课件整理成考试复习笔记。
下面是我从一份 PPT/PDF 中提取的原始文本（按页分隔，第 N 页用 [Page N] 标记）：
---
{原始文本}
---
请你输出一份结构化的 Markdown 复习笔记，严格按以下要求：
1. 章节结构：按知识点分小节，用 ## / ### 标题层级
2. 必背定义：概念、定义、公式加粗，末尾标注「📌 必背」
3. 易考点：适合选择/简答考点，行内标注「⚠️ 考点：xxx」
4. 举例：单独小节「📖 老师举例」存放课件案例
5. 结尾增加「🎯 本章速记」，5-8条要点总结
6. 无多余寒暄，直接输出markdown；纯图片无文字页面直接跳过`;

const markdown = `## 核心知识

**测试定义** 📌 必背

⚠️ 考点：测试知识点

### 📖 老师举例

课件案例。

## 🎯 本章速记

- 理解定义
- 掌握公式
- 比较概念
- 复习案例
- 归纳考点`;

const mock = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const prompt = payload.messages[0].content;
  const raw = prompt.split('\n---\n')[1];
  rawRequests.push({ label: prompt.match(/测试场景：([^\n]+)/)?.[1], raw, maxTokens: payload.max_tokens });
  prompts.push(prompt);
  const label = prompt.match(/测试场景：([^\n]+)/)?.[1] || '未知';
  const count = (calls.get(label) || 0) + 1;
  calls.set(label, count);
  active += 1;
  peak = Math.max(peak, active);
  await sleep(180);
  active -= 1;
  res.setHeader('content-type', 'application/json');
  if (label === '余额不足') {
    res.writeHead(402).end(JSON.stringify({ error: { message: '模拟账户余额不足' } }));
    return;
  }
  if ((label === '自动恢复' && count <= 2) || (label === '持续失败' && !allowRecovery) || (label === '第二块暂时失败' && count === 1)) {
    res.writeHead(500).end(JSON.stringify({ error: { message: '模拟服务临时错误' } }));
    return;
  }
  res.end(JSON.stringify({
    id: `mock-${prompts.length}`, object: 'chat.completion', model: payload.model,
    choices: [{ index: 0, message: { role: 'assistant', content: label === '格式错误' ? '仅回显原始课件文字' : markdown }, finish_reason: label === '输出截断' || (raw.includes('模拟长段落') && raw.length > 1800) ? 'length' : 'stop' }],
    usage: { total_tokens: 100 },
  }));
});

async function api(route, { method = 'GET', body, form } = {}) {
  const headers = userId ? { Authorization: `Bearer ${authTokens.get(userId)}` } : {};
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api${route}`, {
    method, headers, body: form || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json() };
}

async function upload(labels) {
  const form = new FormData();
  for (const label of labels) {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>测试场景：${label}</a:t></a:r></a:p><a:p><a:r><a:t>模板变量 {{variable_name}}</a:t></a:r></a:p></p:sld>`);
    form.append('files', new Blob([await zip.generateAsync({ type: 'nodebuffer' })]), `${label}.pptx`);
  }
  const result = await api(`/courses/${courseId}/files`, { method: 'POST', form });
  assert.equal(result.status, 202, JSON.stringify(result.data));
  return result.data;
}

async function uploadText(title, raw) {
  const form = new FormData();
  form.append('files', new Blob([raw]), `${title}.txt`);
  const result = await api(`/courses/${courseId}/files`, { method: 'POST', form });
  assert.equal(result.status, 202);
  return result.data.notes[0];
}

async function settled() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await api(`/courses/${courseId}/queue`);
    if (!result.data.active) return result.data;
    await sleep(80);
  }
  throw new Error(`AI 队列超时：${logs.slice(-2000)}`);
}

test.before(async () => {
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: DATA,
      DB_PATH: path.join(DATA, 'course-notes.db'), NODE_ENV: 'test',
      AI_API_KEY: 'mock-test-key', AI_MODEL: 'mock-model',
      AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
      AI_CONCURRENCY: '99', AI_RETRIES: '99',
      AI_CHUNK_CHARS: '4000', AI_MAX_TOKENS: '8192',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  for (let i = 0; i < 75; i += 1) {
    try {
      const health = await api('/health');
      if (health.status === 200) {
        const login = await api('/auth/login', { method: 'POST', body: { nickname: 'AI 验收同学', password: '测试密码12345', register: true } });
        userId = login.data.user.id;
        authTokens.set(userId, login.data.user.token);
        const course = await api('/courses', { method: 'POST', body: { name: 'AI 链路验收' } });
        courseId = course.data.course.id;
        return;
      }
    } catch { /* 等待独立服务启动。 */ }
    await sleep(200);
  }
  throw new Error(`AI 测试服务启动失败：${logs}`);
});

test.after(async () => {
  if (child?.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await new Promise((resolve) => mock.close(resolve));
  // 只清理本测试由 mkdtemp 创建的绝对路径。
  const target = path.resolve(DATA);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('course-notes-ai-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('固定 Prompt 逐字一致，双花括号原文保持不变，AI 失败后重试两次成功', async () => {
  await upload(['自动恢复']);
  const queue = await settled();
  assert.equal(calls.get('自动恢复'), 3);
  assert.equal(queue.summary.done, 1);
  assert.equal(queue.items[0].attempts, 3);
  assert.equal(queue.items[0].retryCount, 2);
  const raw = '[Page 1]\n测试场景：自动恢复\n模板变量 {{variable_name}}';
  assert.equal(prompts[0], expectedPrompt.replace('{原始文本}', raw));
  const note = await api(`/notes/${queue.items[0].noteId}`);
  assert.equal(note.data.note.engine, 'ai');
  assert.match(note.data.note.markdownContent, /🎯 本章速记/);
  assert.equal(note.data.note.raw_text, undefined);
  assert.match(logs, /自动重试/);
  assert.match(logs, /调用失败/);
});

test('持续失败仅尝试三次，单文件异常不阻断其他笔记，原文件全部删除', async () => {
  await upload(['持续失败', '正常任务']);
  const queue = await settled();
  assert.equal(calls.get('持续失败'), 3);
  assert.equal(queue.summary.failed, 1);
  assert.equal(queue.summary.done, 2);
  assert.equal(queue.items.find((item) => item.title === '持续失败').canRetry, true);
  assert.deepEqual(await fs.readdir(path.join(DATA, 'uploads')), []);
  assert.deepEqual(await fs.readdir(path.join(DATA, 'tmp')), []);
});

test('原始文件删除后，AI 失败笔记仍能用已提取文本手动重试', async () => {
  const detail = await api(`/courses/${courseId}`);
  const failed = detail.data.notes.find((note) => note.status === 'failed');
  allowRecovery = true;
  const retry = await api(`/notes/${failed.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 202);
  const queue = await settled();
  assert.equal(queue.summary.failed, 0);
  assert.equal(queue.summary.done, 3);
  assert.equal(calls.get('持续失败'), 4);
  assert.deepEqual(await fs.readdir(path.join(DATA, 'uploads')), []);
});

test('并发配置越界时上限仍为三，上传接口在 AI 完成前返回', async () => {
  const health = await api('/health');
  assert.equal(health.data.queue.concurrency, 3);
  const before = prompts.length;
  const uploaded = await upload(Array.from({ length: 7 }, (_, i) => `并发任务${i}`));
  assert.equal(uploaded.accepted, 7);
  const pending = await api(`/courses/${courseId}/queue`);
  assert.equal(pending.data.active, true);
  const queue = await settled();
  assert.equal(queue.summary.done, 10);
  assert.equal(prompts.length - before, 7);
  assert.equal(peak, 3);
  assert.deepEqual(await fs.readdir(path.join(DATA, 'uploads')), []);
});

test('AI 原文回显不会被误标为已完成，错误输出共尝试三次后独立失败', async () => {
  await upload(['格式错误']);
  const queue = await settled();
  const failed = queue.items.find((item) => item.title === '格式错误');
  assert.equal(failed.status, 'failed');
  assert.match(failed.errorMessage, /格式不符合要求/);
  assert.equal(calls.get('格式错误'), 3);
  assert.equal(queue.summary.done, 10);
  assert.deepEqual(await fs.readdir(path.join(DATA, 'uploads')), []);
});

test('输出截断和账户余额不足分别展示真实原因，不再统一误报为配置错误', async () => {
  await upload(['输出截断', '余额不足']);
  const queue = await settled();
  assert.match(queue.items.find((item) => item.title === '输出截断').errorMessage, /输出达到长度上限而被截断/);
  assert.match(queue.items.find((item) => item.title === '余额不足').errorMessage, /余额不足/);
  assert.equal(calls.get('输出截断'), 3);
  assert.equal(calls.get('余额不足'), 3);
  assert.equal(queue.summary.done, 10);
});

test('长段落截断后自动缩块，复用固定提示词并只合并一个速记章节', async () => {
  const start = rawRequests.length;
  const raw = '[Page 1]\n测试场景：长段落恢复\n' + '模拟长段落知识点。'.repeat(320);
  const created = await uploadText('长段落恢复', raw);
  const queue = await settled();
  const item = queue.items.find((entry) => entry.noteId === created.id);
  assert.equal(item.status, 'done');
  assert.equal(item.attempts, 2);
  const requests = rawRequests.slice(start);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].raw.length < requests[0].raw.length);
  assert.ok(requests.every((request) => request.maxTokens === 8192));
  assert.ok(requests.every((request) => request.raw.startsWith('[Page 1]')));
  const result = await api(`/notes/${created.id}`);
  assert.equal((result.data.note.markdownContent.match(/## 🎯 本章速记/g) || []).length, 1);
  assert.match(logs, /已将失败块缩小/);
});

test('多块课件重试时不重复请求已经成功的分块', async () => {
  const firstBefore = calls.get('第一块已完成') || 0;
  const raw = '[Page 1]\n测试场景：第一块已完成\n' + '第一部分知识。'.repeat(350)
    + '\n\n[Page 2]\n测试场景：第二块暂时失败\n' + '第二部分知识。'.repeat(350);
  const created = await uploadText('分块缓存', raw);
  const queue = await settled();
  assert.equal(queue.items.find((entry) => entry.noteId === created.id).status, 'done');
  assert.equal(calls.get('第一块已完成') - firstBefore, 1);
  assert.equal(calls.get('第二块暂时失败'), 2);
});

test('删除处理中的笔记后不会继续请求其余分块，其他任务仍然完成', async () => {
  const before = rawRequests.length;
  const raw = '[Page 1]\n测试场景：删除中止\n' + '第一部分知识。'.repeat(350)
    + '\n\n[Page 2]\n测试场景：不应调用的后续块\n' + '第二部分知识。'.repeat(350);
  const created = await uploadText('删除处理中', raw);
  for (let i = 0; i < 100 && rawRequests.length === before; i += 1) await sleep(10);
  assert.ok(rawRequests.length > before, '应已开始第一个分块请求');
  const deleted = await fetch(`${BASE}/api/notes/${created.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authTokens.get(userId)}` } });
  assert.equal(deleted.status, 204);
  await settled();
  await sleep(300);
  assert.equal(calls.get('不应调用的后续块') || 0, 0);
  assert.equal((await api(`/notes/${created.id}`)).status, 404);
  await upload(['删除后的正常任务']);
  const queue = await settled();
  assert.equal(queue.items.find((entry) => entry.title === '删除后的正常任务').status, 'done');
});
