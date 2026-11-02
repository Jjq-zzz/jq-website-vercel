/**
 * 浏览器端到端验收（Playwright Core + 本机 Chrome）。
 * 前置：npm run build && npm start（或已有服务在 BASE_URL）
 * 运行：node tests/e2e-browser.mjs
 *
 * 覆盖：登录 → 新建课程 → 批量上传/队列 → 失败隔离 → 搜索跳转高亮
 *       → Markdown 下载/复制 → 整课导出 → 刷新保持登录。
 */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { makeFormatFixtures } from './format-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const DOWNLOADS = path.join(ROOT, 'tests', '.downloads');
const courseName = process.env.E2E_COURSE || `预防医学 UI验收 ${Date.now().toString().slice(-4)}`;
const nickname = process.env.E2E_NICKNAME || `UI同学${Date.now().toString().slice(-5)}`;
const consoleErrors = [];
const pageErrors = [];

await fs.mkdir(SHOTS, { recursive: true });
await fs.mkdir(DOWNLOADS, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  ignoreHTTPSErrors: Boolean(process.env.VERCEL_BLOB_MOCK_URL),
  locale: 'zh-CN',
  // 系统偏好深色时，应用仍须保持用户要求的浅色界面。
  colorScheme: 'dark',
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
if (process.env.VERCEL_BLOB_MOCK_URL) {
  // 只在 Vercel 离线验收中将官方 SDK 的存储请求重定向到本机模拟服务。
  await context.route('**/assets/client-*.js', async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    // 仅替换 SDK 的端点配置；上传仍由浏览器和官方 SDK 原生发送二进制流。
    const pattern = /return [\w$]+\.VERCEL_BLOB_API_URL\|\|[\w$]+\.NEXT_PUBLIC_VERCEL_BLOB_API_URL\|\|null/;
    const body = original.replace(pattern, `return ${JSON.stringify(process.env.VERCEL_BLOB_MOCK_URL)}`);
    assert.notEqual(body, original, '应找到 SDK 测试端点配置');
    await route.fulfill({ response, body, contentType: 'application/javascript' });
  });
}
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
if (process.env.VERCEL_BLOB_MOCK_URL) page.on('requestfailed', (request) => {
  console.error('离线验收请求失败：', request.url().split('?')[0], request.failure()?.errorText);
});

async function shot(name, options = {}) {
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
    background: getComputedStyle(document.body).backgroundColor,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));
  assert.ok(layout.contentWidth <= layout.width + 1, `${name} 不应出现横向溢出：${JSON.stringify(layout)}`);
  assert.equal(layout.colorScheme, 'light', `${name} 应固定使用浅色界面`);
  assert.equal(layout.background, 'rgb(246, 245, 241)', `${name} 应使用统一的纸张底色`);
  await page.screenshot({ path: path.join(SHOTS, name), ...options });
  console.log(`📸 ${name}`);
}

try {
  // 1. 登录
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForURL(/\/login/);
  await page.waitForTimeout(300);
  await shot('00-login.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('16-mobile-login.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '第一次使用？创建账号' }).click();
  await page.getByLabel('昵称或学号').fill(nickname);
  await page.getByLabel('密码', { exact: true }).fill('浏览器测试密码12345');
  await page.getByLabel('确认密码', { exact: true }).fill('浏览器测试密码12345');
  await page.getByRole('button', { name: '创建账号并进入' }).click();
  await page.getByRole('heading', { name: '我的课程' }).waitFor();
  assert.match(page.url(), /\/$/);
  await shot('01-courses-empty.png');

  if (process.env.BYOK_E2E) {
    // 仅隔离 Vercel 测试启用，保存后立即清除，避免模拟密钥进入后续上传任务。
    await page.getByRole('button', { name: '用户菜单' }).click();
    await page.getByRole('menuitem', { name: 'AI Key 设置' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI Key 设置' });
    await dialog.getByText('当前为本地模式，不调用外部模型').waitFor();
    const fakeKey = 'sk-浏览器测试专用-abcd';
    await dialog.getByLabel('API Key', { exact: true }).fill(fakeKey);
    await dialog.getByRole('button', { name: /保\s*存/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(fakeKey));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '用户菜单' }).getAttribute('title'), 'AI Key 已配置');
    await page.getByRole('button', { name: '用户菜单' }).click();
    await page.getByRole('menuitem', { name: 'AI Key 设置' }).click();
    await dialog.getByText(/已配置：••••abcd/).waitFor();
    assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '清除密钥' }).click();
    await page.getByRole('button', { name: /^清\s*除$/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '用户菜单' }).getAttribute('title'), '未配置 AI Key');
  }

  // 2. 新建课程
  await page.getByRole('button', { name: '新建第一门课程' }).click();
  await page.locator('.ant-modal-title').filter({ hasText: '新建课程' }).waitFor();
  await page.waitForTimeout(350);
  await shot('17-new-course.png');
  await page.getByPlaceholder('课程名').fill(courseName);
  await page.getByRole('button', { name: /创\s*建/ }).click();
  await page.waitForURL(/\/courses\/[0-9a-f-]+/);
  await page.getByRole('heading', { name: courseName }).waitFor();
  await shot('02-course-empty.png');

  // 3. 打开批量上传，选择 6 个文件（5 份正常课件 + 1 份损坏文件）
  await page.locator('.course-heading-actions').getByRole('button', { name: /批量上传/ }).click();
  await page.locator('.ant-modal-title').filter({ hasText: '批量上传课件' }).waitFor();
  await page.waitForTimeout(400);
  const allFiles = [
    '01-流行病学概述.pptx',
    '02-传染病预防.pptx',
    '03-环境卫生.pptx',
    '04-营养与食品卫生.pptx',
    '05-职业卫生.pptx',
    '损坏的课件.pptx',
  ].map((name) => path.join(FIXTURES, name));
  await page.locator('input[type="file"]').setInputFiles(allFiles);
  await page.getByText(/已选择 6 个文件/).waitFor();
  await page.waitForTimeout(400);
  await shot('03-upload-selected.png');
  await page.getByRole('button', { name: /上传 6 个文件/ }).click();
  await page.getByText('已加入队列，共 6 个文件').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await shot('04-upload-queued.png');

  // 上传成功弹窗 -> 完成，观察底部队列
  await page.getByRole('button', { name: /完\s*成/ }).click();
  await page.locator('.ant-modal-wrap').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  let sawQueue = true;
  try {
    await page.locator('.queue-bar').waitFor({ state: 'visible', timeout: 4000 });
    await page.getByText(/已处理/).first().waitFor();
    await page.waitForTimeout(250);
    await shot('05-processing-queue.png');
  } catch {
    sawQueue = false;
  }
  assert.equal(sawQueue, true, '上传后应能看到底部处理队列浮条');

  // 等队列结束后，笔记列表应有 6 篇，其中 1 篇失败
  await page.locator('.queue-bar').waitFor({ state: 'detached', timeout: 40000 }).catch(() => {});
  await page.locator('.note-item').first().waitFor({ timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll('.note-item').length >= 6, null, {
    timeout: 40000,
  });
  const noteCount = await page.locator('.note-item').count();
  assert.equal(noteCount, 6, `应有 6 篇笔记，实际 ${noteCount}`);
  const failedCount = await page.locator('.note-item-summary.failed').count();
  assert.equal(failedCount, 1, `应有 1 篇失败，实际 ${failedCount}`);
  const failedText = await page.locator('.note-item-summary.failed').innerText();
  assert.match(failedText, /处理失败/);
  await page.waitForTimeout(500);
  await shot('06-course-notes.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('18-mobile-course.png');
  await page.locator('.course-heading-actions').getByRole('button', { name: /批量上传/ }).click();
  await page.locator('.ant-modal-title').filter({ hasText: '批量上传课件' }).waitFor();
  await page.waitForTimeout(350);
  await shot('19-mobile-upload.png');
  await page.getByRole('button', { name: /取\s*消/ }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 4. 课程内全文搜索 -> 打开结果 -> 高亮命中
  const search = page.locator('input[placeholder*="在本课程中搜索"]');
  await search.fill('流行病学');
  await search.press('Enter');
  await page.locator('.search-result-block').waitFor({ timeout: 10000 });
  const resultCount = await page.locator('.search-item').count();
  assert.ok(resultCount > 0, '搜索应至少返回一条结果');
  await shot('07-search-results.png');
  const firstResultTitle = await page.locator('.search-item-title').first().innerText();
  await page.locator('.search-item').first().click();
  await page.locator('.markdown-body').waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelectorAll('mark.search-hit').length > 0,
    null,
    { timeout: 10000 },
  );
  const markCount = await page.locator('mark.search-hit').count();
  const activeCount = await page.locator('mark.search-hit-active').count();
  assert.ok(markCount > 0, '正文应高亮搜索词');
  assert.equal(activeCount, 1, '应有一个主动定位高亮');
  await page.waitForTimeout(500);
  await shot('08-reader-highlight.png');

  // 5. 复制 Markdown 与下载 .md
  await page.getByRole('button', { name: '复制 Markdown' }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipboard, /^# /, '剪贴板应包含 Markdown 标题');
  assert.match(clipboard, /## /, '剪贴板应包含 Markdown 正文');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .md' }).click();
  const download = await downloadPromise;
  const mdPath = path.join(DOWNLOADS, '单篇笔记.md');
  await download.saveAs(mdPath);
  const mdContent = await fs.readFile(mdPath, 'utf8');
  assert.match(mdContent, /^# /, '.md 文件应以标题开头');
  assert.match(mdContent, /🎯 本章速记/, '.md 应包含结构化笔记');

  // 6. 刷新保持登录态
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.note-topbar').waitFor();
  assert.ok(await page.getByRole('button', { name: '下载 .md' }).isVisible());

  // 阅读页在不同宽度下保持完整操作栏、正文和可访问的目录。
  await page.goto(new URL(page.url()).origin + new URL(page.url()).pathname, { waitUntil: 'networkidle' });
  await page.locator('.markdown-body').waitFor();
  await shot('20-reader.png');
  for (const width of [390, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    await shot(`21-reader-${width}.png`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /目\s*录/ }).click();
  await page.locator('.ant-drawer-content').waitFor();
  await page.waitForTimeout(350);
  await shot('22-mobile-directory.png');
  await page.locator('.ant-drawer-close').click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 7. 返回课程，导出整课 .md 与 .zip
  await page.getByRole('button', { name: new RegExp(courseName) }).click();
  await page.getByRole('heading', { name: courseName }).waitFor();

  await page.getByRole('button', { name: /课程导出/ }).click();
  const exportMdPromise = page.waitForEvent('download');
  await page.getByText('合并为一个 .md 文件').click();
  const exportMd = await exportMdPromise;
  const mergedPath = path.join(DOWNLOADS, '整课笔记.md');
  await exportMd.saveAs(mergedPath);
  const merged = await fs.readFile(mergedPath, 'utf8');
  assert.match(merged, new RegExp(`# ${courseName}`));
  assert.match(merged, /本章速记/);

  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /课程导出/ }).click();
  const exportZipPromise = page.waitForEvent('download');
  await page.getByText(/打包为 \.zip/).click();
  const exportZip = await exportZipPromise;
  const zipPath = path.join(DOWNLOADS, '整课笔记.zip');
  await exportZip.saveAs(zipPath);
  const zipEntries = new AdmZip(await fs.readFile(zipPath)).getEntries().map((entry) => entry.entryName);
  assert.ok(zipEntries.some((name) => name.endsWith('.md')), 'zip 内应有 md 文件');

  // 8. 首页回访与移动端布局
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '我的课程' }).waitFor();
  assert.ok(await page.getByText(courseName).isVisible());
  await shot('09-courses-with-data.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '我的课程' }).waitFor();
  await shot('10-mobile-courses.png');

  // 9. 新格式从文件选择、上传到笔记完成的整条网页链路。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.fab').click();
  await page.getByPlaceholder('课程名').fill('多格式兼容验收');
  await page.getByRole('button', { name: /创\s*建/ }).click();
  await page.getByRole('heading', { name: '多格式兼容验收' }).waitFor();
  await page.locator('.course-heading-actions').getByRole('button', { name: /批量上传/ }).click();
  await page.getByText('查看支持的文件格式').click();
  const accept = await page.locator('input[type="file"]').getAttribute('accept');
  for (const extension of ['.docx', '.doc', '.xls', '.xlsx', '.ppt', '.txt', '.epub']) {
    assert.ok(accept.split(',').includes(extension), `文件选择器应允许 ${extension}`);
  }
  const newFixtures = await makeFormatFixtures();
  const formatNames = ['课程讲义.docx', '课程表格.xls', '旧版课程.ppt', '中文讲义.txt', '课程电子书.epub'];
  const formatPaths = [];
  for (const name of formatNames) {
    const target = path.join(DOWNLOADS, name);
    await fs.writeFile(target, newFixtures.get(name));
    formatPaths.push(target);
  }
  await page.locator('input[type="file"]').setInputFiles(formatPaths);
  await page.getByText(/已选择 5 个文件/).waitFor();
  await page.waitForTimeout(400);
  await shot('11-multiformat-upload.png');
  await page.getByRole('button', { name: /上传 5 个文件/ }).click();
  await page.getByText('已加入队列，共 5 个文件').first().waitFor();
  await page.getByRole('button', { name: /完\s*成/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.note-item.clickable').length === 5, null, { timeout: 40000 });
  assert.equal(await page.locator('.note-item-summary.failed').count(), 0);
  await shot('12-multiformat-notes.png');

  // 10. 删除确认可取消；列表、阅读页及课程卡片均可删除。
  const firstDelete = page.getByRole('button', { name: '删除笔记 课程讲义', exact: true });
  await firstDelete.click();
  await page.locator('.ant-popconfirm:visible').waitFor();
  await page.waitForTimeout(350);
  await shot('13-note-delete-confirm.png');
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: /取\s*消/ }).click();
  assert.equal(await page.locator('.note-item').count(), 5);
  await firstDelete.click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: '确认删除' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.note-item').length === 4);
  await page.locator('.note-item.clickable').first().click();
  await page.locator('.markdown-body').waitFor();
  await page.getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: '确认删除' }).click();
  await page.getByRole('heading', { name: '多格式兼容验收' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.note-item').length === 3);
  await shot('14-notes-after-delete.png');
  await page.getByRole('button', { name: '删除课程', exact: true }).click();
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: '确认删除' }).click();
  await page.getByRole('heading', { name: '我的课程' }).waitFor();
  assert.equal(await page.locator('.course-card-title').filter({ hasText: '多格式兼容验收' }).count(), 0);
  await page.getByRole('button', { name: `删除课程 ${courseName}`, exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/', '卡片删除按钮不应打开课程');
  await page.locator('.ant-popconfirm:visible').waitFor();
  await page.waitForTimeout(350);
  await shot('15-course-delete-confirm.png');
  await page.locator('.ant-popconfirm:visible').getByRole('button', { name: '确认删除' }).click();
  await page.getByText('还没有课程', { exact: true }).waitFor();

  // 11. 基础健康检查：无页面崩溃。
  assert.deepEqual(pageErrors, [], `页面运行错误：${pageErrors.join(' | ')}`);
  const seriousConsoleErrors = consoleErrors.filter(
    (text) => !/favicon|ResizeObserver loop|Download the React DevTools/i.test(text),
  );
  assert.deepEqual(seriousConsoleErrors, [], `控制台错误：${seriousConsoleErrors.join(' | ')}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        nickname,
        courseName,
        noteCount,
        failedCount,
        searchResults: resultCount,
        firstResultTitle,
        markCount,
        sawQueue,
        downloads: { mdPath, mergedPath, zipPath },
        zipEntries,
        screenshots: SHOTS,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: path.join(SHOTS, '99-failure.png'), fullPage: true }).catch(() => {});
  console.error('浏览器验收失败：', error);
  if (pageErrors.length) console.error('页面异常：', pageErrors);
  if (consoleErrors.length) console.error('控制台异常：', consoleErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
