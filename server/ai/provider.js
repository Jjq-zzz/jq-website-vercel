import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildPrompt, splitIntoChunks } from './prompt.js';
import { mergeAiChunks, validateAiMarkdown } from './markdown.js';
import { generateLocalNotes } from './local-fallback.js';
import { sleep } from '../utils.js';

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL: config.ai.baseURL,
      timeout: config.ai.timeoutMs,
      // 重试由处理队列统一控制，便于记录每一次尝试到日志与数据库。
      maxRetries: 0,
    });
  }
  return client;
}

function readContent(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

function safeError(err) {
  let message = String(err?.message || err);
  if (config.ai.apiKey) message = message.replaceAll(config.ai.apiKey, '[密钥已隐藏]');
  return {
    name: err?.name || 'Error',
    status: err?.status || err?.statusCode || null,
    code: err?.code || err?.error?.code || null,
    message: message.slice(0, 500),
    requestId: err?.request_id || err?.headers?.['x-request-id'] || null,
  };
}

async function callModel(prompt, { chunkIndex, chunkCount, noteTitle, signal }) {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID().slice(0, 8);
  const started = Date.now();
  logger.ai(
    'ai',
    `调用 ${config.ai.model} | request=${requestId} | 分块 ${chunkIndex}/${chunkCount} | 《${noteTitle}》`,
  );
  try {
    const response = await getClient().chat.completions.create({
      model: config.ai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxTokens,
      stream: false,
    }, { signal });
    const content = readContent(response);
    if (response?.choices?.[0]?.finish_reason === 'length') {
      const err = new Error('AI 输出被截断，请提高 AI_MAX_TOKENS 或降低 AI_CHUNK_CHARS 后重试');
      err.code = 'AI_TRUNCATED_RESPONSE';
      throw err;
    }
    const usage = response?.usage;
    logger.ai(
      'ai',
      `完成 request=${requestId} in ${Date.now() - started}ms | tokens=${usage?.total_tokens ?? '?'} | finish=${response?.choices?.[0]?.finish_reason}`,
    );
    if (!content) {
      const err = new Error('大模型返回了空内容');
      err.code = 'AI_EMPTY_RESPONSE';
      throw err;
    }
    validateAiMarkdown(content);
    return content;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    const info = safeError(err);
    logger.error(
      'ai',
      `调用失败 request=${requestId} in ${Date.now() - started}ms | ${info.name} status=${info.status ?? '-'} code=${info.code ?? '-'} | ${info.message}`,
    );
    const wrapped = new Error(`AI 调用失败：${info.message}`);
    // 保留本地校验的具体原因，避免把输出截断和格式问题误报成接口配置错误。
    wrapped.code = ['AI_TRUNCATED_RESPONSE', 'AI_EMPTY_RESPONSE', 'AI_INVALID_MARKDOWN'].includes(err.code)
      ? err.code
      : /Timeout/i.test(err.name || '') ? 'AI_TIMEOUT' : 'AI_CALL_FAILED';
    wrapped.aiStatus = info.status;
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * 生成结构化笔记。
 * - 未配置 AI：使用确定性本地结构化引擎（engine='local-fallback'）。
 * - 已配置 AI：按页边界分块调用，合并为一份 Markdown（engine='ai'）。
 * 失败重试由 queue.js 统一执行（默认初次 + 2 次重试）。
 */
export async function generateNotes({ rawText, title, noteId, state = {}, signal }) {
  signal?.throwIfAborted();
  const text = String(rawText || '').trim();
  if (!text) {
    const err = new Error('没有可整理的文字内容');
    err.code = 'NO_TEXT';
    throw err;
  }

  if (!config.ai.configured) {
    if (config.ai.localDelayMs > 0) await sleep(config.ai.localDelayMs, signal);
    const local = generateLocalNotes({ rawText: text, title });
    logger.info('engine', `本地结构化完成 | note=${noteId || '-'} | 《${title}》`);
    return { ...local, mode: 'local-fallback' };
  }

  if (text.length > config.ai.maxChars) {
    const err = new Error('课件文字过多，超出单篇笔记处理上限，请拆分文件后重试');
    err.code = 'TOO_LONG';
    throw err;
  }

  // 预先限制每块正文；队列重试时保留成功块，避免重复生成与计费。
  const chunkLimit = Math.min(config.ai.chunkChars, Math.max(1000, Math.floor(config.ai.maxTokens / 2)));
  state.parts ||= splitIntoChunks(text, chunkLimit).map((part) => ({ text: part, markdown: null }));
  for (let i = 0; i < state.parts.length; i += 1) {
    signal?.throwIfAborted();
    const part = state.parts[i];
    if (part.markdown) continue;
    try {
      part.markdown = await callModel(buildPrompt(part.text), {
        chunkIndex: i + 1,
        chunkCount: state.parts.length,
        noteTitle: title,
        signal,
      });
    } catch (err) {
      if (err.code === 'AI_TRUNCATED_RESPONSE' && part.text.length > 1000) {
        const prefixLength = part.text.match(/^\[Page \d+\]\n/)?.[0].length || 0;
        const smaller = splitIntoChunks(part.text, Math.max(500, Math.ceil((part.text.length - prefixLength) / 2) + prefixLength));
        if (smaller.length > 1) {
          state.parts.splice(i, 1, ...smaller.map((text) => ({ text, markdown: null })));
          logger.warn('ai', `输出截断，已将失败块缩小为 ${smaller.length} 块，下次重试复用已完成部分 | note=${noteId || '-'}`);
        }
      }
      throw err;
    }
  }

  const markdown = mergeAiChunks(state.parts.map((part) => part.markdown), title);
  return { markdown, engine: 'ai', chunks: state.parts.length, mode: 'ai' };
}

export function aiStatus() {
  return {
    configured: config.ai.configured,
    mode: config.ai.configured ? 'ai' : 'local-fallback',
    model: config.ai.configured ? config.ai.model : null,
  };
}
