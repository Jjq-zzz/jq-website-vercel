function stripCodeFence(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fence ? fence[1].trim() : trimmed;
}

function stripLeadingChatter(text) {
  let result = text.trim();
  const chatter = /^(好的|当然可以|以下是|下面是|收到)[^\n]{0,60}\n+/;
  if (chatter.test(result) && !result.startsWith('#')) result = result.replace(chatter, '');
  return result.trim();
}

function stripDuplicateLeadingTitle(markdown, title) {
  const lines = markdown.split('\n');
  const firstHeading = lines.findIndex((line) => line.trim());
  if (firstHeading === -1) return markdown;
  const first = lines[firstHeading].trim();
  if (!first.startsWith('# ')) return markdown;
  const normalized = (value) => value.replace(/\s+/g, '').replace(/[：:]/g, '').toLowerCase();
  if (normalized(first.slice(2)) === normalized(title)) {
    lines.splice(firstHeading, 1);
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join('\n').trim();
  }
  return markdown;
}

export function cleanAiMarkdown(text, title) {
  let markdown = stripCodeFence(String(text || ''));
  markdown = stripLeadingChatter(markdown);
  markdown = stripDuplicateLeadingTitle(markdown, title || '');
  return markdown.trim();
}

function takeSummaryBlock(markdown) {
  const match = markdown.match(/\n*#{2,3}\s*🎯[^\n]*\n([\s\S]*)$/);
  if (!match) return { body: markdown, bullets: [] };
  const body = markdown.slice(0, match.index).trim();
  const bullets = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+]|\d+[.)、])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)、])\s+/, '').trim())
    .filter(Boolean);
  return { body, bullets };
}

/** 拒绝空白、原文回显和缺失速记的响应，交给队列按同一重试预算处理。 */
export function validateAiMarkdown(content) {
  const markdown = stripCodeFence(String(content || ''));
  const { bullets } = takeSummaryBlock(markdown);
  if (!/^#{2,3}\s+\S/m.test(markdown) || bullets.length < 5 || bullets.length > 8) {
    const err = new Error('AI 返回内容不符合笔记格式：需要章节标题以及 5～8 条本章速记，请重试');
    err.code = 'AI_INVALID_MARKDOWN';
    throw err;
  }
}

/** 多段调用后合并；只保留一个「本章速记」，去重 bullet，避免重复 H1。 */
export function mergeAiChunks(outputs, title, max = 8) {
  const cleaned = outputs.map((output) => cleanAiMarkdown(output, title)).filter(Boolean);
  if (!cleaned.length) {
    const err = new Error('大模型返回了空内容');
    err.code = 'AI_EMPTY_RESPONSE';
    throw err;
  }
  if (cleaned.length === 1) return cleaned[0];

  const bodies = [];
  const summaryBullets = [];
  for (const output of cleaned) {
    const { body, bullets } = takeSummaryBlock(output);
    bodies.push(body);
    summaryBullets.push(...bullets);
  }
  const deduped = [];
  const seen = new Set();
  for (const bullet of summaryBullets) {
    const key = bullet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(bullet);
    if (deduped.length >= max) break;
  }
  const merged = bodies.join('\n\n---\n\n');
  if (!deduped.length) return merged;
  return `${merged}\n\n## 🎯 本章速记\n\n${deduped.map((item) => `- ${item}`).join('\n')}`;
}
