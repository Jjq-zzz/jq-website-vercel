import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePptx } from './pptx.js';
import { parsePdf } from './pdf.js';
import { supportedKind } from '../utils.js';
import { unsupportedFormatMessage } from '../../shared/file-formats.js';
import { parseTextDocument, parseOfficeDocument, parseLegacyWord, parseLegacyPowerPoint, parseSpreadsheet } from './document.js';

/** 根据扩展名解析课件，返回 { rawText, pageCount, totalSlides, textLength, type }。 */
export async function parseCourseware(filePath) {
  const kind = supportedKind(filePath);
  if (kind === 'pptx') {
    const buffer = await fs.readFile(filePath);
    return parsePptx(buffer);
  }
  if (kind === 'pdf') {
    return parsePdf(filePath);
  }
  if (kind === 'text') return parseTextDocument(filePath);
  if (kind === 'doc') return parseLegacyWord(filePath);
  if (kind === 'ppt') return parseLegacyPowerPoint(filePath);
  if (kind === 'spreadsheet') return parseSpreadsheet(filePath);
  if (['docx', 'odt', 'odp', 'rtf', 'epub', 'html', 'tex'].includes(kind)) return parseOfficeDocument(filePath, kind);
  const err = new Error(unsupportedFormatMessage(filePath));
  err.code = 'UNSUPPORTED';
  throw err;
}

export function parseErrorUserMessage(err) {
  if (!err) return '处理失败，请稍后重试';
  if (err.code === 'NO_TEXT') return err.message;
  if (err.code === 'CORRUPT_PPTX' || err.code === 'CORRUPT_PDF' || err.code === 'CORRUPT_ZIP') return err.message;
  if (err.code === 'TOO_LONG' || err.code === 'ZIP_TOO_LARGE') return err.message;
  if (err.code === 'ENOENT') return '临时文件已过期，请重新上传该课件';
  return String(err.message || '处理失败，请稍后重试').slice(0, 300);
}

export function isPermanentParseError(err) {
  return ['CORRUPT_PPTX', 'CORRUPT_PDF', 'CORRUPT_DOCUMENT', 'ENCRYPTED_DOCUMENT', 'NO_TEXT', 'UNSUPPORTED', 'TOO_LONG', 'ENOENT'].includes(err?.code);
}

export function storedExt(filePath) {
  return path.extname(filePath).toLowerCase();
}
