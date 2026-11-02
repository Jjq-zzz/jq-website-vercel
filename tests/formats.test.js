import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCourseware } from '../server/parsers/index.js';
import { extractZip } from '../server/parsers/zip.js';
import { ACCEPTED_EXTENSIONS, parserForExtension, unsupportedFormatMessage } from '../shared/file-formats.js';
import { makeFormatFixtures } from './format-fixtures.mjs';
import JSZip from 'jszip';

let directory;
let fixtures;
test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'course-format-test-'));
  fixtures = await makeFormatFixtures();
  for (const [filename, bytes] of fixtures) await fs.writeFile(path.join(directory, filename), bytes);
});
test.after(async () => {
  if (!directory) return;
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('course-format-test-'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('格式清单统一覆盖常见文档，别名与大小写均可识别', () => {
  assert.equal(new Set(ACCEPTED_EXTENSIONS).size, ACCEPTED_EXTENSIONS.length);
  assert.equal(parserForExtension('.DOCX'), 'docx');
  assert.equal(parserForExtension('.pptm'), 'pptx');
  assert.equal(parserForExtension('.xls'), 'spreadsheet');
  assert.match(unsupportedFormatMessage('讲义.wps'), /另存/);
  assert.match(unsupportedFormatMessage('资料.rar'), /解压/);
  assert.match(unsupportedFormatMessage('图片.png'), /不支持 OCR/);
});

test('常见办公、文本、电子书及旧版 PPT 均能提取中文内容', async (t) => {
  for (const filename of fixtures.keys()) {
    await t.test(filename, async () => {
      const parsed = await parseCourseware(path.join(directory, filename));
      assert.match(parsed.rawText, /^\[Page 1\]/);
      assert.match(parsed.rawText, filename.startsWith('GBK') ? /中文/ : /课程定义/);
      assert.ok(parsed.textLength > 0);
      if (filename.endsWith('.xlsx') || filename.endsWith('.xls') || filename.endsWith('.ods')) {
        assert.equal(parsed.pageCount, 2);
        assert.match(parsed.rawText, /老师举例/);
      }
      if (filename.endsWith('.ppt')) {
        assert.equal(parsed.pageCount, 2);
        assert.match(parsed.rawText, /\[Page 2\]\n第二页考点/);
      }
      if (filename.endsWith('.odp')) assert.equal(parsed.pageCount, 2);
      if (filename.endsWith('.html')) assert.ok(!parsed.rawText.includes('不应提取的脚本内容'));
      if (filename.endsWith('.md')) assert.match(parsed.rawText, /\{\{variable_name\}\}/);
    });
  }
});

test('真实旧版 DOC 二进制样例可读取，非仅按后缀放行', async () => {
  const file = new URL('./fixtures/legacy-word-sample.doc', import.meta.url);
  const buffer = await fs.readFile(file);
  assert.equal(buffer.subarray(0, 4).toString('hex'), 'd0cf11e0');
  const parsed = await parseCourseware(fileURLToPath(file));
  assert.equal(parsed.type, 'doc');
  assert.ok(parsed.textLength > 10);
  assert.match(parsed.rawText, /^\[Page 1\]/);
});

test('ZIP 内混装 Word、Excel、文本和 EPUB 均可展开，专有和嵌套格式给出明确提示', async () => {
  const zip = new JSZip();
  for (const name of ['课程讲义.docx', '课程表格.xls', '中文讲义.txt', '课程电子书.epub']) {
    zip.file(`课程资料/${name}`, fixtures.get(name));
  }
  zip.file('课程资料/旧讲义.wps', '专有格式');
  zip.file('嵌套.zip', '无效 ZIP');
  const file = path.join(directory, '混合资料.zip');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await extractZip(file, directory);
  assert.equal(result.files.length, 4);
  assert.equal(result.skipped.length, 2);
  for (const entry of result.files) assert.ok((await parseCourseware(entry.path)).textLength > 0);
});

test('损坏的新格式文档和空文本独立报错，不会生成伪笔记', async () => {
  for (const name of ['坏文档.docx', '坏文档.doc', '坏课件.ppt', '坏电子书.epub', '坏表格.xlsx', '坏表格.xls']) {
    const full = path.join(directory, name);
    await fs.writeFile(full, '损坏的二进制内容');
    await assert.rejects(parseCourseware(full), { code: 'CORRUPT_DOCUMENT' });
  }
  const empty = path.join(directory, '空文本.txt');
  await fs.writeFile(empty, '   ');
  await assert.rejects(parseCourseware(empty), { code: 'NO_TEXT' });
});
