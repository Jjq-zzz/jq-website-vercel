import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { withImageRecognition, IMAGE_EXTENSIONS } from './ocr.js';
import { parsedPages, readOfficeAst } from './document.js';
import { parsePptx } from './pptx.js';
import { parsePdf } from './pdf.js';
import { supportedKind } from '../utils.js';
import { unsupportedFormatMessage } from '../../shared/file-formats.js';
import { parseTextDocument, parseOfficeDocument, parseLegacyWord, parseLegacyPowerPoint, parseSpreadsheet } from './document.js';

/** 根据扩展名解析课件，返回 { rawText, pageCount, totalSlides, textLength, type }。 */
export async function parseCourseware(filePath) {
  return withImageRecognition(async (recognize) => {
    const kind = supportedKind(filePath);
    if (kind === 'pdf') return parsePdf(filePath, { recognize });
    if (kind === 'image') {
      if (!recognize) throw new Error('图片识别尚未启用，请管理员配置本地 OCR 语言文件');
      if ((await fs.stat(filePath)).size > 5 * 1024 * 1024) throw new Error('图片超过 5 MB，请压缩后重试');
      return parsedPages([await recognize(await fs.readFile(filePath))], 'image');
    }
    let result;
    let noText;
    try { result = await parseDocumentText(filePath, kind); }
    catch (error) {
      if (error.code !== 'NO_TEXT' || (!recognize && kind !== 'pptx')) throw error;
      noText = error;
    }

    const additions = [];
    const archive = kind === 'pptx' || (recognize && ['docx', 'spreadsheet', 'odp', 'odt', 'epub'].includes(kind))
      ? await readArchive(filePath) : [];
    if (kind === 'pptx' && archive.some((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName) &&
      entry.header.size < 4 * 1024 * 1024 && /<(?:[\w.-]+:)?oMath(?:Para)?[ >]/.test(entry.getData().toString('utf8')))) {
      const ast = await readOfficeAst(filePath, kind);
      const collect = (nodes) => {
        for (const node of nodes) {
          if (node.metadata?.math && node.text) additions.push('公式：$$' + node.text + '$$');
          if (node.children) collect(node.children);
        }
      };
      collect(ast.content);
    }
    if (recognize) {
      for (const entry of archive.filter((entry) => !entry.isDirectory && IMAGE_EXTENSIONS.includes(storedExt(entry.entryName)))) {
        if (entry.header.size > 5 * 1024 * 1024) throw new Error('内嵌图片超过 5 MB，请压缩后重试');
        const text = await recognize(entry.getData());
        if (text) additions.push('【图片文字】\n' + text);
      }
      if (['rtf', 'html'].includes(kind)) {
        const ast = await readOfficeAst(filePath, kind, true);
        for (const item of ast.attachments.filter((item) => item.type === 'image' && item.data)) {
          if (!IMAGE_EXTENSIONS.includes(storedExt(item.name))) continue;
          const text = await recognize(Buffer.from(item.data, 'base64'));
          if (text) additions.push('【图片文字】\n' + text);
        }
      }
    }
    if (!additions.length && result) return result;
    if (!additions.length) throw noText;
    if (!result) return parsedPages(additions, kind);
    const extra = additions.join('\n\n');
    if (result.textLength + extra.length > 2_000_000) throw new Error('识别内容超过文字处理上限，请拆分文件');
    return { ...result, rawText: result.rawText + '\n\n' + extra, textLength: result.textLength + extra.length };
  });
}

async function readArchive(filePath) {
  const input = await fs.readFile(filePath);
  if (input[0] !== 0x50 || input[1] !== 0x4b) return [];
  const entries = new AdmZip(input).getEntries();
  if (entries.length > 10000 || entries.reduce((total, entry) => total + entry.header.size, 0) > 128 * 1024 * 1024) {
    throw new Error('文档解压体积超过识别上限，请拆分文件');
  }
  return entries;
}

async function parseDocumentText(filePath, kind) {
  if (kind === 'pptx') {
    const buffer = await fs.readFile(filePath);
    return parsePptx(buffer);
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
