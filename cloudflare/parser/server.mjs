/** 私有容器只负责解析，数据在响应前清理，不持有数据库或 AI 密钥。 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { parseCourseware, parseErrorUserMessage } from '../../server/parsers/index.js';
import { extractZip } from '../../server/parsers/zip.js';
import { verifyPassword } from '../../server/password.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://parser');
  if (req.method === 'GET' && url.pathname === '/health') { res.end('正常'); return; }
  let directory;
  try {
    if (req.method !== 'POST') throw new Error('不支持的请求');
    if (url.pathname === '/verify-legacy') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2048) throw new Error('请求过大'); }
      const data = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ valid: await verifyPassword(data.password, data.hash) }));
      return;
    }
    if (url.pathname !== '/parse') throw new Error('接口不存在');
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'course-parser-'));
    const name = path.basename(url.searchParams.get('filename') || 'file.txt');
    const file = path.join(directory, `source${path.extname(name).toLowerCase()}`);
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      done(bytes > 100 * 1024 * 1024 ? new Error('文件超过 100MB') : null, chunk);
    } });
    await pipeline(req, limiter, createWriteStream(file));
    const archive = path.extname(name).toLowerCase() === '.zip';
    const expanded = archive ? await extractZip(file, directory) : { files: [{ path: file, originalName: name }], skipped: [] };
    const items = [];
    for (const item of expanded.files) {
      try {
        const parsed = await parseCourseware(item.path);
        if (parsed.rawText.length > 240000) throw new Error('课件文字超过 24 万字，请拆分文件');
        items.push({ filename: item.originalName, rawText: parsed.rawText });
      } catch (error) { items.push({ filename: item.originalName, error: parseErrorUserMessage(error) }); }
      finally { await fs.rm(item.path, { force: true }); }
    }
    // 限制 ZIP 返回文本总量，避免边缘运行时一次接收过多文本。
    if (JSON.stringify(items).length > 4000000) throw new Error('压缩包文本总量过大，请拆分上传');
    const result = { items, skipped: expanded.skipped };
    await fs.rm(directory, { recursive: true, force: true });
    directory = null;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    res.writeHead(422, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(error.message).slice(0, 300) }));
  }
});
server.requestTimeout = 240000;
server.listen(Number(process.env.PARSER_PORT || 8080), process.env.PARSER_HOST || '0.0.0.0');
