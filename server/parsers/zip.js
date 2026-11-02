import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { extensionOf, basenameOf, supportedKind } from '../utils.js';
import { unsupportedFormatMessage } from '../../shared/file-formats.js';

function isUnsafeEntry(entryName) {
  const name = String(entryName || '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some((segment) => segment === '..');
}

/**
 * 解压 ZIP 到服务器临时目录，只落地格式清单中的文档，随后逐个入队。
 * 不做真正的目录还原，改用随机文件名，避免 Zip Slip / 同名覆盖。
 */
export async function extractZip(zipPath, destDir, { maxFiles = 120, maxBytes = 400 * 1024 * 1024 } = {}) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    const err = new Error('ZIP 文件已损坏或无法解压');
    err.code = 'CORRUPT_ZIP';
    throw err;
  }

  const entries = zip.getEntries();
  if (!entries.length) {
    const err = new Error('ZIP 是空压缩包');
    err.code = 'EMPTY_ZIP';
    throw err;
  }

  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let unsupportedOmitted = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = String(entry.entryName || '').replace(/\\/g, '/');
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(entryName)) continue;
    if (entryName.split('/').some((segment) => segment.startsWith('.'))) continue;

    if (isUnsafeEntry(entryName)) {
      skipped.push({ name: entryName, reason: '压缩包内路径不安全，已跳过' });
      continue;
    }

    const kind = supportedKind(entryName);
    if (!kind || kind === 'zip') {
      if (skipped.length < 20) {
        skipped.push({
          name: basenameOf(entryName),
          reason: kind === 'zip' ? '不支持嵌套 ZIP，请展开后重新打包' : unsupportedFormatMessage(entryName),
        });
      } else {
        unsupportedOmitted += 1;
      }
      continue;
    }

    if (files.length >= maxFiles) {
      skipped.push({ name: basenameOf(entryName), reason: `单次最多处理 ${maxFiles} 个课件` });
      break;
    }

    // 在解压分配内存前检查声明体积，避免超大成员先被完整展开。
    if (totalBytes + entry.header.size > maxBytes) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      const err = new Error('ZIP 解压后体积超过上限，请拆分后再上传');
      err.code = 'ZIP_TOO_LARGE';
      throw err;
    }

    let data;
    try {
      data = entry.getData();
    } catch (err) {
      skipped.push({ name: basenameOf(entryName), reason: `解压失败：${err.message}` });
      continue;
    }
    totalBytes += data.length;
    if (totalBytes > maxBytes) {
      const err = new Error('ZIP 解压后体积超过上限，请拆分后再上传');
      err.code = 'ZIP_TOO_LARGE';
      // 清理已写入的文件，避免无主临时文件。
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      throw err;
    }

    const ext = extensionOf(entryName);
    const storedPath = path.join(destDir, `zip-${crypto.randomUUID()}${ext}`);
    try {
      await fs.writeFile(storedPath, data);
    } catch (err) {
      await Promise.all([...files.map((file) => file.path), storedPath].map((file) => fs.unlink(file).catch(() => {})));
      throw err;
    }
    files.push({
      path: storedPath,
      originalName: basenameOf(entryName),
      kind,
      size: data.length,
    });
  }

  if (unsupportedOmitted > 0) {
    skipped.push({ name: '其他文件', reason: `另有 ${unsupportedOmitted} 个不支持的文件已跳过` });
  }

  return { files, skipped, totalEntries: entries.length };
}
