/** 上传、ZIP 识别及服务端解析共用的格式清单。 */
export const FORMAT_GROUPS = [
  { label: '演示文稿', extensions: ['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm'], parser: 'pptx' },
  { label: '旧版演示文稿', extensions: ['.ppt', '.pps', '.pot'], parser: 'ppt' },
  { label: 'Word 文档', extensions: ['.docx', '.docm', '.dotx', '.dotm'], parser: 'docx' },
  { label: '旧版 Word', extensions: ['.doc', '.dot'], parser: 'doc' },
  { label: '表格', extensions: ['.xlsx', '.xls', '.xlsm', '.xlsb', '.xltx', '.xltm', '.xlt', '.ods', '.ots', '.csv', '.tsv'], parser: 'spreadsheet' },
  { label: '开放文档', extensions: ['.odt', '.ott'], parser: 'odt' },
  { label: '开放演示文稿', extensions: ['.odp', '.otp'], parser: 'odp' },
  { label: '图片', extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'], parser: 'image' },
  { label: 'PDF', extensions: ['.pdf'], parser: 'pdf' },
  { label: '富文本', extensions: ['.rtf'], parser: 'rtf' },
  { label: '电子书', extensions: ['.epub'], parser: 'epub' },
  { label: '纯文本', extensions: ['.txt', '.md', '.markdown'], parser: 'text' },
  { label: '网页', extensions: ['.html', '.htm', '.xhtml'], parser: 'html' },
  { label: 'LaTeX', extensions: ['.tex', '.latex'], parser: 'tex' },
  { label: '压缩包', extensions: ['.zip'], parser: 'zip' },
];

export const ACCEPTED_EXTENSIONS = FORMAT_GROUPS.flatMap((group) => group.extensions);
export const FORMAT_SUMMARY = 'PPT、Word、Excel、PDF、TXT、Markdown、HTML、RTF、EPUB、OpenDocument、图片和 ZIP';

export function parserForExtension(extension) {
  return FORMAT_GROUPS.find((group) => group.extensions.includes(String(extension).toLowerCase()))?.parser || null;
}

export function unsupportedFormatMessage(filename) {
  const extension = String(filename).toLowerCase().match(/\.[^.\\/]+$/)?.[0] || '';
  if (['.wps', '.wpt', '.dps', '.dpt', '.et', '.ett'].includes(extension)) {
    return 'WPS 专有格式请先另存为 DOCX、PPTX 或 XLSX 后上传';
  }
  if (['.rar', '.7z'].includes(extension)) return '请将压缩包解压后上传文档，或重新打包为 ZIP';
  if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'].includes(extension)) return '请将图片转换为 PNG、JPEG、WebP 或 BMP 后上传';
  return `暂不支持该格式；可上传 ${FORMAT_SUMMARY}`;
}
