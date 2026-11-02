/** 生成公开的合成课程资料，不使用用户课件或真实 AI 服务。 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { buildPptFile } from '@christophervr/ole2';

const wordText = '课程定义：遗传学研究基因及变异。公式 F = ma。';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';

export async function makeFormatFixtures() {
  const files = new Map();
  files.set('中文讲义.txt', Buffer.from(wordText));
  files.set('UTF16讲义.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wordText, 'utf16le')]));
  files.set('GBK讲义.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  files.set('复习提纲.md', Buffer.from(`# 课程定义\n\n${wordText}\n\n模板变量 {{variable_name}}`));
  files.set('网页讲义.html', Buffer.from(`<html><head><title>网页课程</title><script>不应提取的脚本内容</script></head><body><h1>课程定义</h1><p>${wordText}</p><img src="https://example.invalid/never-fetch.png"/></body></html>`));
  files.set('富文本讲义.rtf', Buffer.from('{\\rtf1\\ansi\\ansicpg1252\\uc1 ' + [...wordText].map((character) => {
    const code = character.charCodeAt(0);
    return code > 127 ? `\\u${code > 32767 ? code - 65536 : code}?` : character;
  }).join('') + '}'));
  files.set('公式讲义.tex', Buffer.from(`\\documentclass{article}\n\\begin{document}\n\\section{课程定义}\n${wordText}\n\\[E=mc^2\\]\n\\end{document}`));

  const word = new JSZip();
  word.file('[Content_Types].xml', `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  word.file('_rels/.rels', `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  word.file('word/document.xml', `${xmlHeader}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${wordText}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格考点</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  files.set('课程讲义.docx', await word.generateAsync({ type: 'nodebuffer' }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['课程定义', '公式'], ['遗传学', 'F = ma']]), '基础知识');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['第二工作表', '考点'], ['例题', '基因变异']]), '老师举例');
  for (const format of ['xlsx', 'xls', 'xlsb', 'ods']) {
    files.set(`课程表格.${format}`, XLSX.write(book, { type: 'buffer', bookType: format }));
  }
  files.set('课程表格.csv', Buffer.from('课程定义,公式\n遗传学,F = ma\n"含逗号,内容",基因变异'));
  files.set('课程表格.tsv', Buffer.from('课程定义\t公式\n遗传学\tF = ma'));

  for (const [extension, content, mime] of [
    ['odt', `<office:text><text:h text:outline-level="1">课程定义</text:h><text:p>${wordText}</text:p></office:text>`, 'text'],
    ['odp', `<office:presentation><draw:page draw:name="第一页"><draw:frame><draw:text-box><text:p>${wordText}</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="第二页"><draw:frame><draw:text-box><text:p>第二页考点</text:p></draw:text-box></draw:frame></draw:page></office:presentation>`, 'presentation'],
  ]) {
    const zip = new JSZip();
    zip.file('mimetype', `application/vnd.oasis.opendocument.${mime}`);
    zip.file('content.xml', `${xmlHeader}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${content}</office:body></office:document-content>`);
    files.set(`开放课程.${extension}`, await zip.generateAsync({ type: 'nodebuffer' }));
  }

  const epub = new JSZip();
  epub.file('mimetype', 'application/epub+zip');
  epub.file('META-INF/container.xml', `${xmlHeader}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  epub.file('OEBPS/content.opf', `${xmlHeader}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-course</dc:identifier><dc:title>课程电子书</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`);
  epub.file('OEBPS/chapter.xhtml', `${xmlHeader}<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>课程定义</h1><p>${wordText}</p></body></html>`);
  files.set('课程电子书.epub', await epub.generateAsync({ type: 'nodebuffer' }));

  const slide = (text) => ({ shapes: [{
    kind: 'shape', spt: 1, isConnector: false, anchor: { x: 0, y: 0, w: 6000000, h: 3000000 },
    text: { textType: 4, paragraphs: [{ indentLevel: 0, runs: [{ text }] }] },
  }] });
  files.set('旧版课程.ppt', Buffer.from(await buildPptFile({
    widthEmu: 9144000, heightEmu: 6858000, pictures: [], slides: [slide(wordText), slide('第二页考点')],
  })));
  return files;
}
