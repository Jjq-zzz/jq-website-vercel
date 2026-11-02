import { config, ensureConfig } from './config.js';
import { initDb, closeDb } from './db.js';
import { logger } from './logger.js';
import { noteQueue } from './queue.js';
import { app } from './app.js';

const warnings = ensureConfig();

initDb();
for (const warning of warnings) logger.warn('config', warning);

await noteQueue.recover();

// 隐私兜底：清理终态任务遗留文件与孤儿上传文件。
const cleanupTimer = setInterval(
  () => {
    noteQueue.cleanupFinishedFiles().catch((err) => logger.warn('queue', `定时清理失败：${err.message}`));
    noteQueue.cleanupOrphanUploads().catch((err) => logger.warn('queue', `孤儿文件清理失败：${err.message}`));
  },
  6 * 60 * 60 * 1000,
);
cleanupTimer.unref();

const server = app.listen(config.port, config.host, () => {
  logger.info('server', '────────────────────────────────────────────');
  logger.info('server', `「课研」已启动  http://localhost:${config.port}`);
  logger.info(
    'server',
    config.ai.configured
      ? `AI 模式：${config.ai.model} @ ${config.ai.baseURL} | 并发 ${config.ai.concurrency}`
      : 'AI 模式：未配置，使用本地结构化引擎（设置 AI_API_KEY / AI_MODEL 后启用）',
  );
  logger.info('server', `数据目录：${config.dataDir}`);
  logger.info('server', '────────────────────────────────────────────');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('server', `端口 ${config.port} 已被占用，请设置 PORT 环境变量或关闭占用进程`);
  } else {
    logger.error('server', `服务启动失败：${err.message}`);
  }
  closeDb();
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server', `收到 ${signal}，正在关闭服务…`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error('process', `未处理的 Promise 拒绝：${err?.stack || err}`);
});
process.on('uncaughtException', (err) => {
  logger.error('process', `未捕获异常：${err?.stack || err}`);
});
