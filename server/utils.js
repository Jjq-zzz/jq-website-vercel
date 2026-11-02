import path from 'node:path';
import { parserForExtension } from '../shared/file-formats.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 修复 multipart 中文文件名：busboy 默认按 latin1 解码文件名。 */
export function decodeUploadName(name = '') {
  if ([...name].some((ch) => ch.codePointAt(0) > 255)) return name;
  if (![...name].some((ch) => ch.codePointAt(0) > 127)) return name;
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD') && /[\u3400-\u9fff]/.test(decoded)) return decoded;
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

export function basenameOf(name = '') {
  return String(name).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

export function titleFromFilename(filename) {
  const base = basenameOf(filename);
  const noExt = base.replace(/\.[^.]+$/, '');
  return (noExt || base || '未命名笔记').trim().slice(0, 120);
}

export function extensionOf(filename) {
  return path.extname(basenameOf(filename)).toLowerCase();
}

/** 所有入口使用同一格式清单，大小写不敏感。 */
export function supportedKind(filename) {
  return parserForExtension(extensionOf(filename));
}

export function safeExportName(name, fallback = '未命名') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 100);
}

export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 从 Markdown 生成列表页摘要，只保留正文语义，最多 100 字。 */
export function summarizeMarkdown(markdown, maxLength = 100) {
  const raw = String(markdown || '');
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    // 摘要不展示章节标题，避免「一、xxx 核心要点」这类目录噪音。
    .replace(/^#{1,6}[^\n]*$/gm, ' ')
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/📌\s*必背/g, ' ')
    .replace(/⚠️?\s*考点[：:]\s*/g, '考点：')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

export function normalizeTitle(raw, max = 40) {
  return String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, max);
}

export function noteMarkdownForDownload(note) {
  const body = String(note.markdown_content || '').trim();
  const title = String(note.title || '未命名笔记').trim();
  return `# ${title}\n\n${body}\n`;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function truncateForLog(value, max = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
