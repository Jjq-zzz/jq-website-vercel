/** 只读查找一篇失败笔记并复现生成，不改变原笔记状态，也不输出密钥或课件原文。 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { generateNotes } from '../server/ai/provider.js';

const db = new DatabaseSync(config.dbPath, { readOnly: true });
const note = process.argv[2]
  ? db.prepare('SELECT id, title, raw_text FROM notes WHERE id = ?').get(process.argv[2])
  : db.prepare("SELECT id, title, raw_text FROM notes WHERE status = 'failed' AND raw_text <> '' ORDER BY updated_at DESC LIMIT 1").get();
db.close();

if (!note?.raw_text) throw new Error('未找到可诊断的课件文本');
if (!config.ai.configured) throw new Error('当前终端未读取到完整 AI 配置');

const report = { noteId: note.id, title: note.title, textLength: note.raw_text.length, maxTokens: config.ai.maxTokens };
console.log('开始复现失败任务：', JSON.stringify(report));
const started = Date.now();
try {
  const generated = await generateNotes({ rawText: note.raw_text, title: note.title, noteId: note.id });
  Object.assign(report, { success: true, engine: generated.engine, chunks: generated.chunks, markdownLength: generated.markdown.length });
  await fs.mkdir(path.join(config.rootDir, '.tmp-build'), { recursive: true });
  await fs.writeFile(path.join(config.rootDir, '.tmp-build', 'ai-diagnosis.md'), generated.markdown, 'utf8');
} catch (err) {
  Object.assign(report, { success: false, code: err.code, status: err.aiStatus ?? null,
    error: String(err.message).replaceAll(config.ai.apiKey, '[密钥已隐藏]') });
  process.exitCode = 1;
}
report.elapsedMs = Date.now() - started;
await fs.mkdir(path.join(config.rootDir, '.tmp-build'), { recursive: true });
await fs.writeFile(path.join(config.rootDir, '.tmp-build', 'ai-diagnosis.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('诊断结果：', JSON.stringify(report, null, 2));
