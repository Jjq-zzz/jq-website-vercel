import { Container, getContainer } from '@cloudflare/containers';
import { api } from '../serverless/http.js';
import { NoteCoordinator as Coordinator } from './queue.js';
import { authRoute, requireUser } from './auth.js';
import { first, rows, run, stmt, now, id, fail, json, publicNote, publicCourse, titleOf, basename, attachment, downloadName, coordinator, kick } from './common.js';
import { parserForExtension, unsupportedFormatMessage } from '../shared/file-formats.js';
import { noteMarkdownForDownload } from '../server/utils.js';

export class ParserContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
}
export async function parserFetch(env, path, init, lane = 0) {
  // 仅本地验收使用回环地址，生产不配置此变量。
  if (env.PARSER_DEV_URL) {
    const url = new URL(env.PARSER_DEV_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('开发解析器必须使用回环地址');
    return fetch(`${url.origin}${path}`, init);
  }
  return getContainer(env.PARSER, `parser-${lane}`).fetch(new Request(`http://parser${path}`, init));
}
export class NoteCoordinator extends Coordinator {
  constructor(ctx, env) { super(ctx, { ...env, PARSER_FETCH: (path, init, lane) => parserFetch(env, path, init, lane) }); }
}
export default {
  async fetch(request, env, ctx) {
    try {
      const result = new URL(request.url).pathname.startsWith('/api/') ? await api(request, { ...env, PARSER_FETCH: (p, init) => parserFetch(env, p, init) }, ctx) : await env.ASSETS.fetch(request);
      const response = new Response(result.body, result);
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.headers.set('X-Frame-Options', 'DENY');
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: '接口错误', path: new URL(request.url).pathname, code: error.code || 'INTERNAL_ERROR', status: error.status || 500 }));
      return json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务器暂时不可用，请稍后重试' } }, error.status || 500);
    }
  },
  async scheduled(event, env) {
    await kick(env);
    // 清理没有队列引用的上传对象，兜底上传成功但记录创建中断的情况。
    const listed = await env.UPLOADS.list({ prefix: 'pending/', limit: 1000 });
    for (const object of listed.objects) {
      if (Date.now() - object.uploaded.getTime() < 3600000) continue;
      if (!(await first(env, 'SELECT id FROM upload_queue WHERE file_path=?', object.key))) await env.UPLOADS.delete(object.key);
    }
    await run(env, 'DELETE FROM sessions WHERE expires_at<=?', now());
  },
};
