import fs from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import AdmZip from 'adm-zip';

const MAX_CHARS = 2_000_000;

export function documentError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/** 文档、电子书按逻辑分段；表格按工作表，演示文稿按幻灯片提供分页标记。 */
export function parsedPages(pages, type, maxChars = MAX_CHARS) {
  let textLength = 0;
  const sections = [];
  for (const [index, page] of pages.entries()) {
    const text = String(page.text ?? page).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    textLength += text.length;
    if (textLength > maxChars) throw documentError('TOO_LONG', '文档文字超过可处理上限，请拆分后上传');
    sections.push(`[Page ${page.number ?? index + 1}]\n${text}`);
  }
  if (!sections.length) throw documentError('NO_TEXT', '文件没有可提取的文字，请检查是否为空文档、图片或扫描件');
  return { rawText: sections.join('\n\n'), pageCount: sections.length, totalSlides: pages.length, textLength, type };
}

export function logicalPages(text, size = 6000) {
  const pages = [];
  for (let section of String(text).replace(/\r\n?/g, '\n').split('\f')) {
    while (section.length > size) {
      const newline = section.lastIndexOf('\n', size);
      const cut = newline > size / 2 ? newline + 1 : size;
      pages.push(section.slice(0, cut));
      section = section.slice(cut);
    }
    pages.push(section);
  }
  return pages;
}

/** 支持 UTF-8、UTF-16 和常见中文 GB18030 编码。 */
export function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  if (buffer.length > 8) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 512));
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] === 0) i % 2 ? oddZeros++ : evenZeros++;
    }
    if (oddZeros > sample.length / 5) return new TextDecoder('utf-16le').decode(buffer);
    if (evenZeros > sample.length / 5) return new TextDecoder('utf-16be').decode(buffer);
  }
  if (buffer.includes(0)) throw documentError('CORRUPT_DOCUMENT', '文件包含二进制内容，无法作为文本读取，请检查文件格式');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(buffer);
    } catch (err) {
      throw documentError('CORRUPT_DOCUMENT', '文本编码无法识别，请另存为 UTF-8 编码后上传', err);
    }
  }
}

export async function parseTextDocument(filePath) {
  return parsedPages(logicalPages(decodeText(await fs.readFile(filePath))), 'text');
}

export async function readOfficeAst(filePath, type, extractAttachments = false) {
  const { OfficeParser } = await import('officeparser');
  const input = ['html', 'tex'].includes(type)
    ? Buffer.from(decodeText(await fs.readFile(filePath)), 'utf8')
    : await fs.readFile(filePath);
  return OfficeParser.parseOffice(input, {
    fileType: type,
    ocr: false,
    extractAttachments,
    allowRemoteAssets: false,
    ignoreNotes: true,
    ignoreComments: true,
    ignoreHeadersAndFooters: true,
    ignoreSlideMasters: true,
    decompressionLimits: { maxUncompressedBytes: 128 * 1024 * 1024, maxZipEntries: 10000, maxTableCells: 200000 },
  });
}

export async function parseOfficeDocument(filePath, type) {
  try {
    const { OfficeGenerator } = await import('officeparser');
    const ast = await readOfficeAst(filePath, type);
    if (ast.warnings?.some((warning) => ['TABLE_CELL_LIMIT_EXCEEDED', 'REPEATED_CONTENT_LIMIT_EXCEEDED', 'CONTENT_PART_NOT_READ'].includes(warning.code ?? warning.type))) {
      throw documentError('CORRUPT_DOCUMENT', '文档部分内容无法完整读取或超过大小限制，请拆分或另存为通用格式后上传');
    }
    if (type === 'odp' && ast.content.some((node) => node.type === 'slide')) {
      const pages = [];
      for (const [index, slide] of ast.content.filter((node) => node.type === 'slide').entries()) {
        const output = await OfficeGenerator.generate({ ...ast, content: [slide] }, 'text');
        pages.push({ number: slide.metadata?.slideNumber ?? index + 1, text: output.value });
      }
      return parsedPages(pages, type);
    }
    const text = (await ast.to('text')).value;
    return parsedPages(logicalPages(text), type);
  } catch (err) {
    if (['NO_TEXT', 'TOO_LONG', 'CORRUPT_DOCUMENT'].includes(err.code)) throw err;
    if (/password|encrypt/i.test(`${err.code} ${err.message}`)) {
      throw documentError('ENCRYPTED_DOCUMENT', '文档已加密，请移除打开密码后重新上传', err);
    }
    throw documentError('CORRUPT_DOCUMENT', '文档损坏、内部结构不完整或版本暂不兼容，请另存为通用格式后重试', err);
  }
}

export async function parseLegacyWord(filePath) {
  try {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(await fs.readFile(filePath));
    const text = [doc.getBody(), doc.getTextboxes({ includeHeadersAndFooters: false })].filter(Boolean).join('\n');
    return parsedPages(logicalPages(text), 'doc');
  } catch (err) {
    if (['NO_TEXT', 'TOO_LONG'].includes(err.code)) throw err;
    throw documentError('CORRUPT_DOCUMENT', '旧版 Word 无法读取，请确认文件未加密，或另存为 DOCX 后上传', err);
  }
}

export async function parseLegacyPowerPoint(filePath) {
  try {
    const { parsePpt } = await import('@christophervr/ole2');
    const document = parsePpt(await fs.readFile(filePath));
    return parsedPages(document.slides.map((slide, index) => ({
      number: index + 1,
      text: slide.texts.map((item) => item.text).join('\n'),
    })), 'ppt');
  } catch (err) {
    if (['NO_TEXT', 'TOO_LONG'].includes(err.code)) throw err;
    throw documentError('CORRUPT_DOCUMENT', '旧版 PPT 无法读取，请确认文件未加密，或另存为 PPTX 后上传', err);
  }
}

export async function parseSpreadsheet(filePath) {
  try {
    const XLSX = await import('xlsx');
    const input = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const isTextTable = ['.csv', '.tsv'].includes(extension);
    if (!isTextTable) {
      const zipped = input[0] === 0x50 && input[1] === 0x4b;
      const compound = input.subarray(0, 4).toString('hex') === 'd0cf11e0';
      const legacyMarkup = ['.xls', '.xlt'].includes(extension) && /^\s*(?:<\?xml|<!doctype\s+html|<html|<table)/i.test(input.subarray(0, 200).toString('utf8'));
      if (!zipped && !compound && !legacyMarkup) throw documentError('CORRUPT_DOCUMENT', '表格内容与文件格式不匹配，请确认文件未损坏');
      if (zipped) {
        const entries = new AdmZip(input).getEntries();
        if (entries.length > 10000 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > 128 * 1024 * 1024) {
          throw documentError('TOO_LONG', '表格解压体积超过读取上限，请拆分后上传');
        }
      }
    }
    const workbook = XLSX.read(isTextTable ? decodeText(input) : input, {
      type: isTextTable ? 'string' : 'buffer', dense: true, cellFormula: true,
      ...(extension === '.tsv' ? { FS: '\t' } : {}),
    });
    const pages = [];
    let cells = 0;
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      cells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
      if (cells > 200000) throw documentError('TOO_LONG', '表格范围超过 20 万个单元格，请保留课程相关区域后上传');
      const rows = [];
      for (let row = range.s.r; row <= range.e.r; row += 1) {
        const values = [];
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const cell = sheet['!data']?.[row]?.[column] ?? sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          const value = !cell ? '' : cell.f ? `=${cell.f}${cell.v != null ? `（结果：${XLSX.utils.format_cell(cell)}）` : ''}` : XLSX.utils.format_cell(cell);
          values.push(String(value).replace(/[\t\r\n]+/g, ' '));
        }
        if (values.some((value) => value.trim())) rows.push(values.join('\t'));
      }
      const text = rows.join('\n');
      if (text.trim()) pages.push({ text: `工作表：${name}\n${text}` });
    }
    return parsedPages(pages, 'spreadsheet');
  } catch (err) {
    if (['NO_TEXT', 'TOO_LONG', 'CORRUPT_DOCUMENT'].includes(err.code)) throw err;
    throw documentError('CORRUPT_DOCUMENT', '表格无法读取，请确认文件未损坏或加密，或另存为 XLSX／CSV 后上传', err);
  }
}
