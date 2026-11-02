import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { coursesRouter } from './routes/courses.js';
import { notesRouter } from './routes/notes.js';
import { aiStatus } from './ai/provider.js';
import { noteQueue } from './queue.js';
import { getDb, deleteFileQuiet } from './db.js';
import { logger } from './logger.js';
import { HttpError, asyncHandler } from './utils.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    // 队列轮询不写日志，避免刷屏；写操作和错误保留可观测性。
    if (req.method === 'GET' && res.statusCode < 400) return;
    logger.info('http', `${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai: aiStatus(),
    queue: noteQueue.stats(),
    uptime: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/notes', notesRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在' } });
});

// 生产构建产物由后端同源托管；开发环境由 Vite dev server 提供页面。
const indexHtml = path.join(config.clientDist, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h', etag: true }));
  app.get(
    '*',
    asyncHandler(async (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在' } });
        return;
      }
      res.sendFile(indexHtml);
    }),
  );
} else {
  app.get('/', (req, res) => {
    res
      .status(200)
      .type('text/plain; charset=utf-8')
      .send('「课研」API 已启动。前端尚未构建：开发请运行 npm run dev（Vite: 5173），或先 npm run build 再 npm start。');
  });
}

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '页面不存在' } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (Array.isArray(req.files)) {
    for (const file of req.files) deleteFileQuiet(file.path);
  }

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `单个文件不能超过 ${Math.round(config.maxFileSize / 1024 / 1024)}MB`,
      LIMIT_FILE_COUNT: `一次最多上传 ${config.maxFilesPerUpload} 个文件`,
      LIMIT_UNEXPECTED_FILE: '上传字段不正确，请使用 files 字段',
      LIMIT_FIELD_COUNT: '表单字段过多',
    };
    return res.status(400).json({
      error: { code: err.code, message: messages[err.code] || `上传失败：${err.message}` },
    });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求内容不是合法 JSON' } });
  }

  const status = err instanceof HttpError ? err.status : Number(err.status) || 500;
  const code = err instanceof HttpError ? err.code : 'INTERNAL_ERROR';
  const message =
    status >= 500 ? '服务器开小差了，请稍后重试' : String(err.message || '请求失败').slice(0, 500);

  if (status >= 500) logger.error('http', `${req.method} ${req.originalUrl} 未处理异常：${err.stack || err.message}`);
  const body = { error: { code, message } };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
});
