import JSZip from 'jszip';
import path from 'node:path';

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeXmlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (full, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    return XML_ENTITIES[entity] ?? full;
  });
}

function collectParagraphs(xml) {
  const lines = [];
  const paragraphRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
  let paragraph;
  while ((paragraph = paragraphRe.exec(xml))) {
    const inner = paragraph[1];
    const runRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g;
    let run;
    const runs = [];
    while ((run = runRe.exec(inner))) runs.push(run[1] === undefined ? '\n' : decodeXmlEntities(run[1]));
    const text = runs.join('').replace(/\u000B/g, '\n').trim();
    if (text) lines.push(text);
  }
  if (lines.length) return lines;

  // 极端情况下 <a:p> 结构缺失，退化为收集所有文本节点。
  const fallback = [];
  const runRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let run;
  while ((run = runRe.exec(xml))) {
    const text = decodeXmlEntities(run[1]).trim();
    if (text) fallback.push(text);
  }
  return fallback;
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`));
  return match ? decodeXmlEntities(match[2]) : '';
}

async function orderedSlides(zip) {
  const presentation = zip.file('ppt/presentation.xml');
  const relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && relationships) {
    const [xml, rels] = await Promise.all([presentation.async('string'), relationships.async('string')]);
    const targets = new Map();
    for (const match of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
      if (!attribute(match[0], 'Type').endsWith('/slide')) continue;
      if (attribute(match[0], 'TargetMode') === 'External') continue;
      const target = attribute(match[0], 'Target');
      const name = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `ppt/${target}`);
      if (/^ppt\/slides\/[^/]+\.xml$/i.test(name)) targets.set(attribute(match[0], 'Id'), name);
    }
    const ordered = [...xml.matchAll(/<p:sldId\b[^>]*\/?\s*>/g)].map((match, index) => ({
      name: targets.get(attribute(match[0], 'r:id')),
      number: index + 1,
    }));
    if (ordered.some((slide) => !slide.name || !zip.file(slide.name))) {
      const err = new Error('PPTX 幻灯片关系缺失，文件可能已损坏');
      err.code = 'CORRUPT_PPTX';
      throw err;
    }
    return ordered;
  }
  // 兼容简化课件；标准 PPTX 必须优先使用演示文稿中的真实页序。
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]))
    .map((name, index) => ({ name, number: index + 1 }));
}

/**
 * 仅提取 PPTX 每页文字（不提取图片/备注），输出 [Page N] 分页文本。
 * 纯图片页会被跳过，符合固定 Prompt 的第 6 条要求。
 */
export async function parsePptx(buffer, { maxChars = 2_000_000 } = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    const err = new Error('文件已损坏或不是有效的 PPTX（ZIP 结构无法读取）');
    err.code = 'CORRUPT_PPTX';
    throw err;
  }

  const slideFiles = await orderedSlides(zip);

  if (!slideFiles.length) {
    const err = new Error('PPTX 中未找到幻灯片，文件可能已损坏');
    err.code = 'CORRUPT_PPTX';
    throw err;
  }

  const pages = [];
  let textLength = 0;
  for (const slide of slideFiles) {
    const xml = await zip.files[slide.name].async('string');
    const lines = collectParagraphs(xml);
    const text = lines.join('\n').trim();
    if (!text) continue;
    textLength += text.length;
    if (textLength > maxChars) {
      const err = new Error('课件文字超过可处理上限，请拆分后再上传');
      err.code = 'TOO_LONG';
      throw err;
    }
    pages.push({ number: slide.number, text });
  }

  if (!pages.length) {
    const err = new Error('这份课件没有可提取的文字（可能是纯图片/扫描版），暂不支持 OCR');
    err.code = 'NO_TEXT';
    throw err;
  }

  const rawText = pages
    .map((page) => `[Page ${page.number}]\n${page.text}`)
    .join('\n\n');

  return {
    rawText,
    pageCount: pages.length,
    totalSlides: slideFiles.length,
    textLength,
    type: 'pptx',
  };
}
