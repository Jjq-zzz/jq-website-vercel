/**
 * 对已启动服务做端到端 API 冒烟测试。
 * 用法：先 npm start，再 node tests/smoke-live.mjs
 * 默认 BASE_URL=http://127.0.0.1:3000
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  if (condition) {
    results.push(`✅ ${name}`);
  } else {
    failures += 1;
    results.push(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(pathname, { method = 'GET', userId, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { res, payload };
}

async function uploadFiles(courseId, userId, filenames) {
  const form = new FormData();
  for (const filename of filenames) {
    const buffer = await fs.readFile(path.join(FIXTURES, filename));
    form.append('files', new Blob([buffer]), filename);
  }
  return request(`/api/courses/${courseId}/files`, { method: 'POST', userId, body: form });
}

async function waitQueue(courseId, userId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { payload } = await request(`/api/courses/${courseId}/queue`, { userId });
    if (!payload.active) return payload;
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error('等待队列超时');
}

const health = await request('/api/health');
check('健康检查', health.res.status === 200 && health.payload.ok === true);
check(
  '未配置 AI 时有明确模式标识',
  ['ai', 'local-fallback'].includes(health.payload.ai.mode),
  JSON.stringify(health.payload.ai),
);

const nickname = `验收同学${Date.now().toString().slice(-5)}`;
const login = await request('/api/auth/login', { method: 'POST', body: { nickname } });
check('昵称登录', login.res.status === 200 && login.payload.user?.id);
const userId = login.payload.user.id;

const me = await request('/api/auth/me', { userId });
check('登录态校验', me.res.status === 200 && me.payload.user.nickname === nickname);

const noAuth = await request('/api/courses');
check('未登录拦截', noAuth.res.status === 401, String(noAuth.res.status));

const course = await request('/api/courses', { method: 'POST', userId, body: { name: '预防医学' } });
check('新建课程', course.res.status === 201 && course.payload.course.name === '预防医学');
const courseId = course.payload.course.id;

const dup = await request('/api/courses', { method: 'POST', userId, body: { name: '预防医学' } });
check('课程重名拦截', dup.res.status === 409, String(dup.res.status));

const upload = await uploadFiles(courseId, userId, [
  '01-流行病学概述.pptx',
  '02-传染病预防.pptx',
  '03-环境卫生.pptx',
  '04-营养与食品卫生.pptx',
  '05-职业卫生.pptx',
  '损坏的课件.pptx',
]);
check('批量上传返回 202', upload.res.status === 202, `${upload.res.status} ${JSON.stringify(upload.payload).slice(0, 300)}`);
check('一次接收 6 个文件', upload.payload.accepted === 6, String(upload.payload.accepted));

const queue = await waitQueue(courseId, userId);
check('队列最终归零', queue.active === false, JSON.stringify(queue.summary));
check('5 篇完成 1 篇失败', queue.summary.done === 5 && queue.summary.failed === 1, JSON.stringify(queue.summary));

const detail = await request(`/api/courses/${courseId}`, { userId });
check('课程详情含 6 条记录', detail.payload.notes.length === 6, String(detail.payload.notes.length));
const doneNotes = detail.payload.notes.filter((note) => note.status === 'done');
const failedNote = detail.payload.notes.find((note) => note.status === 'failed');
check('失败文件单独标记', Boolean(failedNote?.errorMessage), failedNote?.errorMessage);

const first = await request(`/api/notes/${doneNotes[0].id}`, { userId });
const md = first.payload.note.markdownContent;
check('笔记为结构化 Markdown', md.includes('## ') && md.includes('🎯 本章速记'), md.slice(0, 100));
check('笔记含必背标记', md.includes('📌 必背') || md.includes('⚠️ 考点'));
check('不返回原始 PPT 文本', !('rawText' in first.payload.note) && !('raw_text' in first.payload.note));

const search = await request(`/api/courses/${courseId}/search?q=${encodeURIComponent('流行病学')}`, { userId });
check('课程内搜索命中', search.payload.total > 0, JSON.stringify(search.payload).slice(0, 300));
check('搜索返回高亮片段与跳转信息', Boolean(search.payload.results[0]?.snippet && search.payload.results[0]?.noteId));

const download = await fetch(`${BASE}/api/notes/${doneNotes[0].id}/download`, { headers: { 'x-user-id': userId } });
const downloadText = await download.text();
check('单篇 Markdown 下载', download.status === 200 && downloadText.startsWith('# '), download.status.toString());

const exportMd = await fetch(`${BASE}/api/courses/${courseId}/export?format=md`, { headers: { 'x-user-id': userId } });
const merged = await exportMd.text();
check('课程合并导出', exportMd.status === 200 && merged.includes('# 预防医学') && merged.includes('🎯 本章速记'));

const exportZip = await fetch(`${BASE}/api/courses/${courseId}/export?format=zip`, { headers: { 'x-user-id': userId } });
const zipBuffer = Buffer.from(await exportZip.arrayBuffer());
let zipEntries = [];
try {
  zipEntries = new AdmZip(zipBuffer).getEntries().map((entry) => entry.entryName);
} catch {
  // 服务关闭时无需额外清理。
}
check('课程 ZIP 导出', exportZip.status === 200 && zipEntries.length >= 6, zipEntries.join(','));

const retry = await request(`/api/notes/${failedNote.id}/retry`, { method: 'POST', userId });
check('失败笔记允许重试', retry.res.status === 202, `${retry.res.status} ${JSON.stringify(retry.payload).slice(0, 200)}`);
const retryQueue = await waitQueue(courseId, userId, 45000);
check('重试后仍失败但服务存活', retryQueue.summary.failed >= 1, JSON.stringify(retryQueue.summary));

// ZIP 上传（两个有效课件 + 1 个 txt）
const zipUpload = await uploadFiles(courseId, userId, ['课堂资料包.zip']);
check('ZIP 上传接收', zipUpload.res.status === 202 && zipUpload.payload.accepted === 2, JSON.stringify(zipUpload.payload).slice(0, 300));
check('ZIP 内不支持文件被跳过', zipUpload.payload.skipped?.some((item) => item.name === '说明.txt'), JSON.stringify(zipUpload.payload.skipped));

// PDF 上传
const pdfUpload = await uploadFiles(courseId, userId, ['英文示例-流行病学.pdf']);
check('PDF 上传接收', pdfUpload.res.status === 202 && pdfUpload.payload.accepted === 1, JSON.stringify(pdfUpload.payload).slice(0, 300));

const finalQueue = await waitQueue(courseId, userId, 45000);
check(
  'ZIP 与 PDF 均处理成功',
  finalQueue.summary.done === 8,
  JSON.stringify(finalQueue.summary),
);

const finalDetail = await request(`/api/courses/${courseId}`, { userId });
const pdfNote = finalDetail.payload.notes.find((note) => note.sourceFilename.endsWith('.pdf'));
check('PDF 解析出笔记', pdfNote?.status === 'done', JSON.stringify(pdfNote));
const pdfNoteDetail = pdfNote ? await request(`/api/notes/${pdfNote.id}`, { userId }) : null;
check('PDF 笔记内容非空', Boolean(pdfNoteDetail?.payload.note.markdownContent.length > 50));

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} 项通过`);
process.exit(failures ? 1 : 0);
