/**
 * 固定 Prompt（产品需求指定，勿随意修改）。
 * 分块调用时仍使用同一模板，长度上限由 AI_CHUNK_CHARS 控制。
 */
export function buildPrompt(rawText) {
  return `你是一个资深大学生学习助手，擅长把老师的课件整理成考试复习笔记。
下面是我从一份 PPT/PDF 中提取的原始文本（按页分隔，第 N 页用 [Page N] 标记）：
---
${rawText}
---
请你输出一份结构化的 Markdown 复习笔记，严格按以下要求：
1. 章节结构：按知识点分小节，用 ## / ### 标题层级
2. 必背定义：概念、定义、公式加粗，末尾标注「📌 必背」
3. 易考点：适合选择/简答考点，行内标注「⚠️ 考点：xxx」
4. 举例：单独小节「📖 老师举例」存放课件案例
5. 结尾增加「🎯 本章速记」，5-8条要点总结
6. 无多余寒暄，直接输出markdown；纯图片无文字页面直接跳过`;
}

/** 按 [Page N] 分页边界切块，尽量不破坏一页文本。 */
export function splitIntoChunks(rawText, maxChars) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const blocks = text.split(/\n\n(?=\[Page \d+\])/g);
  const chunks = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const block of blocks) {
    if (!block) continue;
    if (block.length > maxChars) {
      push();
      // 单页超长时保留每个续块的来源页码，再按行拆分正文。
      const marker = block.match(/^\[Page \d+\]/)?.[0] || '';
      const prefix = marker ? `${marker}\n` : '';
      const capacity = Math.max(1, maxChars - prefix.length);
      let rest = marker ? block.slice(marker.length).trimStart() : block;
      while (rest.length > capacity) {
        let cut = rest.lastIndexOf('\n', capacity);
        if (cut < capacity * 0.6) cut = capacity;
        chunks.push(`${prefix}${rest.slice(0, cut).trim()}`);
        rest = rest.slice(cut);
      }
      if (rest.trim()) chunks.push(`${prefix}${rest.trim()}`);
      continue;
    }
    if (current && current.length + block.length + 2 > maxChars) push();
    current += (current ? '\n\n' : '') + block;
  }
  push();
  return chunks;
}
