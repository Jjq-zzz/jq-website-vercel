import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let pdfjsPromise;
let resourcePaths;

async function getPdfjs() {
  if (!pdfjsPromise) {
    // pdfjs-dist 4.x 依赖 Promise.withResolvers（Node 22+ 才有），低版本运行时先补齐
    if (typeof Promise.withResolvers !== 'function') {
      Promise.withResolvers = function withResolvers() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      };
    }
    // PDF.js 通过变量路径加载 worker，显式导入使 Vercel 能追踪这个依赖。
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]).then(([pdfjs]) => pdfjs);
    try {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve('pdfjs-dist/package.json');
      const pdfjsRoot = path.dirname(pkgPath);
      resourcePaths = {
        standardFontDataUrl: `${pathToFileURL(path.join(pdfjsRoot, 'standard_fonts')).href}/`,
        cMapUrl: `${pathToFileURL(path.join(pdfjsRoot, 'cmaps')).href}/`,
      };
    } catch {
      resourcePaths = {};
    }
  }
  return pdfjsPromise;
}

function pageItemsToText(items) {
  let out = '';
  let lastY = null;
  for (const item of items) {
    if (typeof item?.str !== 'string' || !item.str) {
      if (item?.hasEOL && out && !out.endsWith('\n')) out += '\n';
      continue;
    }
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    const brokeLine = lastY !== null && y !== null && Math.abs(y - lastY) > 2.5;
    if (brokeLine && out && !out.endsWith('\n')) out += '\n';
    const lastChar = out.slice(-1);
    const firstChar = item.str[0];
    const needsSpace =
      out &&
      !out.endsWith('\n') &&
      /[A-Za-z0-9,.;:!?)]/.test(lastChar) &&
      /[A-Za-z0-9([]/.test(firstChar);
    if (needsSpace) out += ' ';
    out += item.str;
    lastY = y;
    if (item.hasEOL && !out.endsWith('\n')) out += '\n';
  }
  return out
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 逐页提取 PDF 文本，输出 [Page N] 分页文本。扫描件无文本层时明确报错。 */
export async function parsePdf(filePath, { maxChars = 2_000_000, recognize } = {}) {
  const pdfjs = await getPdfjs();
  let doc;
  try {
    const data = new Uint8Array(await fs.readFile(filePath));
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0,
      ...resourcePaths,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    const detail = String(err?.message || err?.name || '未知错误').slice(0, 160);
    const wrapped = new Error(
      /password/i.test(String(err?.name || err?.message))
        ? `PDF 已加密，无法提取文字（${detail}）`
        : `PDF 文件已损坏或无法读取（${detail}）`,
    );
    wrapped.code = 'CORRUPT_PDF';
    wrapped.cause = err;
    throw wrapped;
  }

  try {
    const pages = [];
    let textLength = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = pageItemsToText(content.items);
      if (recognize && (!text || (await page.getOperatorList()).fnArray.some((operation) => [
        pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject,
      ].includes(operation)))) {
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(size.width, size.height)) });
        const surface = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvasContext: surface.context, viewport }).promise;
          const recognized = await recognize(surface.canvas.toBuffer('image/png'));
          if (recognized && recognized !== text) text = [text, recognized].filter(Boolean).join('\n');
        } finally { doc.canvasFactory.destroy(surface); }
      }
      page.cleanup();
      if (!text) continue;
      textLength += text.length;
      if (textLength > maxChars) {
        const err = new Error('课件文字超过可处理上限，请拆分后再上传');
        err.code = 'TOO_LONG';
        throw err;
      }
      pages.push({ number: pageNumber, text });
    }

    if (!pages.length) {
      const err = new Error('这份 PDF 没有文本层（可能是扫描件），请检查扫描件清晰度或启用 OCR');
      err.code = 'NO_TEXT';
      throw err;
    }

    return {
      rawText: pages.map((page) => `[Page ${page.number}]\n${page.text}`).join('\n\n'),
      pageCount: pages.length,
      totalSlides: doc.numPages,
      textLength,
      type: 'pdf',
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
