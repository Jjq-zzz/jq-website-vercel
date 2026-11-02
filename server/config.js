import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, 'data');

// 兼容通用配置和 DeepSeek 系统环境变量，密钥无需写进 .env。
const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const model = process.env.AI_MODEL || process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || '';
const baseURL =
  process.env.AI_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.DEEPSEEK_BASE_URL ||
  'https://api.openai.com/v1';

export const config = {
  rootDir,
  port: num(process.env.PORT, 3000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir,
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'course-notes.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  tmpDir: path.join(dataDir, 'tmp'),
  clientDist: path.join(rootDir, 'dist', 'client'),
  maxFileSize: num(process.env.MAX_FILE_SIZE_MB, 100, 1, 1024) * 1024 * 1024,
  maxFilesPerUpload: num(process.env.MAX_FILES_PER_UPLOAD, 60, 1, 200),
  maxFilesFromZip: num(process.env.MAX_FILES_FROM_ZIP, 120, 1, 500),
  maxZipExtractBytes: num(process.env.MAX_ZIP_EXTRACT_MB, 400, 1, 2048) * 1024 * 1024,
  ai: {
    apiKey,
    model,
    baseURL,
    configured: Boolean(apiKey && model),
    mode: apiKey && model ? 'ai' : 'local-fallback',
    concurrency: Math.floor(num(process.env.AI_CONCURRENCY, 2, 2, 3)),
    chunkChars: num(process.env.AI_CHUNK_CHARS, 4000, 1000, 120000),
    maxChars: num(process.env.AI_MAX_CHARS, 240000, 10000, 2000000),
    maxTokens: num(process.env.AI_MAX_TOKENS, 8192, 256, 32000),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 120000, 5000, 600000),
    maxRetries: 2,
    temperature: Number.isFinite(Number(process.env.AI_TEMPERATURE))
      ? Number(process.env.AI_TEMPERATURE)
      : 0.2,
    // 本地引擎仅用于演示完整流程；留一点处理时间，让用户能看到队列状态。
    localDelayMs: num(process.env.LOCAL_ENGINE_DELAY_MS, 600, 0, 10000),
  },
};

export function ensureConfig() {
  const warnings = [];
  if (!apiKey) {
    warnings.push('未设置 AI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY，笔记将使用「本地结构化」引擎（非 AI）。');
  } else if (!model) {
    warnings.push('已设置 API Key 但未设置 AI_MODEL，笔记将使用「本地结构化」引擎。');
  }
  return warnings;
}
