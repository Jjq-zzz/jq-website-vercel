import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parsePptx } from '../server/parsers/pptx.js';
import { splitIntoChunks } from '../server/ai/prompt.js';

test('PPTX 按实际演示页序提取，跳过图片页并保留页码、换行及特殊字符', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId3"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Type="schema/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="schema/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="schema/slide" Target="slides/slide3.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<a:p><a:r><a:t>最后一页</a:t></a:r></a:p>');
  zip.file('ppt/slides/slide2.xml', '<a:p><a:r><a:t>第一页 A&amp;B</a:t></a:r><a:br/><a:r><a:t>公式 {{variable_name}}</a:t></a:r></a:p>');
  zip.file('ppt/slides/slide3.xml', '<p:pic/>');
  const parsed = await parsePptx(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(parsed.rawText, '[Page 1]\n第一页 A&B\n公式 {{variable_name}}\n\n[Page 3]\n最后一页');
  assert.equal(parsed.pageCount, 2);
  assert.equal(parsed.totalSlides, 3);
});

test('损坏 PPTX 与纯图片 PPTX 给出独立明确的错误', async () => {
  await assert.rejects(parsePptx(Buffer.from('损坏的课件')), { code: 'CORRUPT_PPTX' });
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:pic/>');
  await assert.rejects(parsePptx(await zip.generateAsync({ type: 'nodebuffer' })), { code: 'NO_TEXT' });
});

test('单页长文本拆块保留页码与完整正文，二次缩块也不会丢失内容', () => {
  const body = '知识点 {{variable_name}} 公式 F = ma。'.repeat(400);
  const chunks = splitIntoChunks(`[Page 7]\n${body}`, 3000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.startsWith('[Page 7]\n') && chunk.length <= 3000));
  assert.equal(chunks.map((chunk) => chunk.replace(/^\[Page 7\]\n/, '')).join('').replace(/\s/g, ''), body.replace(/\s/g, ''));
  const smaller = chunks.flatMap((chunk) => splitIntoChunks(chunk, 1500));
  assert.ok(smaller.every((chunk) => chunk.startsWith('[Page 7]\n') && chunk.length <= 1500));
  assert.equal(smaller.map((chunk) => chunk.replace(/^\[Page 7\]\n/, '')).join('').replace(/\s/g, ''), body.replace(/\s/g, ''));
});
