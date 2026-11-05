import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorker } from 'tesseract.js';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

export async function withImageRecognition(operation) {
  const directory = process.env.OCR_LANG_PATH;
  if (!directory) return operation(null);
  const languages = (process.env.OCR_LANGUAGES || 'eng').split('+');
  if (languages.some((language) => !/^[a-z0-9_]+$/.test(language))) throw new Error('OCR 语言配置无效');
  let worker;
  let imageCount = 0;
  async function recognize(bytes) {
    if (bytes.length > 5 * 1024 * 1024 || ++imageCount > 12) throw new Error('图片识别限制为每份文件 12 张、每张 5 MB，请拆分或压缩');
    if (!worker) {
      const langPath = path.resolve(directory);
      for (const language of languages) await fs.access(path.join(langPath, language + '.traineddata.gz'))
        .catch(() => { throw new Error('缺少本地 OCR 语言文件：' + language + '.traineddata.gz'); });
      worker = await createWorker(languages, 1, { langPath, cacheMethod: 'none' });
    }
    const result = await worker.recognize(bytes);
    return result.data.text.trim();
  }
  try { return await operation(recognize); }
  finally { await worker?.terminate(); }
}
