import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseCourseware, parseErrorUserMessage } from '../server/parsers/index.js';
import { extractZip } from '../server/parsers/zip.js';
import { verifyPassword } from '../server/password.js';

/** 单次函数内解析，完成或失败均清理 /tmp；不启动常驻解析服务。 */
export async function parserFetch(route, init) {
  if (route === '/verify-legacy') {
    const { password, hash } = JSON.parse(init.body);
    return Response.json({ valid: await verifyPassword(password, hash) });
  }
  let directory;
  try {
    const url = new URL(route, 'http://parser');
    const name = path.basename(url.searchParams.get('filename') || 'file.txt');
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vercel-course-'));
    const filename = path.join(directory, `source${path.extname(name)}`);
    let length = 0;
    const limiter = new Transform({ transform(chunk, encoding, done) {
      length += chunk.length;
      done(length > 100 * 1024 * 1024 ? new Error('文件超过 100MB') : null, chunk);
    } });
    const body = init.body instanceof ReadableStream ? Readable.fromWeb(init.body) : Readable.from(init.body);
    await pipeline(body, limiter, createWriteStream(filename), { signal: init.signal });
    const expanded = path.extname(name).toLowerCase() === '.zip' ? await extractZip(filename, directory) : { files: [{ path: filename, originalName: name }], skipped: [] };
    const items = [];
    for (const file of expanded.files) {
      init.signal?.throwIfAborted();
      try {
        const parsed = await parseCourseware(file.path);
        if (parsed.rawText.length > 240000) throw new Error('课件文字超过 24 万字，请拆分上传');
        items.push({ filename: file.originalName, rawText: parsed.rawText });
      } catch (error) { items.push({ filename: file.originalName, error: parseErrorUserMessage(error) }); }
      finally { await fs.rm(file.path, { force: true }); }
    }
    return Response.json({ items, skipped: expanded.skipped });
  } catch (error) { return Response.json({ error: String(error.message).slice(0, 300) }, { status: 422 }); }
  finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
}
