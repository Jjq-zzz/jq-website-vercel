import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { waitUntil } from '@vercel/functions';
import { environment } from '../vercel/environment.js';
import { handleRequest } from '../vercel/handler.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://app.local');
    const route = url.searchParams.get('route');
    if (route !== null) { url.pathname = `/api/${route}`; url.searchParams.delete('route'); }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    if (req.headers['x-forwarded-for']) headers.set('cf-connecting-ip', String(req.headers['x-forwarded-for']).split(',')[0]);
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.body !== undefined) body = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? JSON.stringify(req.body) : req.body;
      else {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
    }
    const response = await handleRequest(new Request(url, { method: req.method, headers, body }), environment(), { waitUntil });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    console.error('请求处理失败', error.code || error.name);
    if (!res.headersSent) { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { code: 'DEPLOYMENT_NOT_CONFIGURED', message: '数据库或文件存储尚未配置，请检查 Vercel 环境变量' } })); }
    else res.end();
  }
}
