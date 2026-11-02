const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

function splitPages(rawText) {
  const text = String(rawText || '');
  const pages = [];
  const re = /\[Page (\d+)\]\s*([\s\S]*?)(?=\n\n\[Page \d+\]|$)/g;
  let match;
  while ((match = re.exec(text))) {
    const body = match[2].trim();
    if (body) pages.push({ number: Number(match[1]), text: body });
  }
  if (!pages.length && text.trim()) pages.push({ number: 1, text: text.trim() });
  return pages;
}

function cleanLine(line) {
  return String(line || '')
    .replace(/^\s*(?:[-*+•●▪◦>]|\d+[.)、])\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTitleLine(line) {
  if (!line || line.length > 42) return false;
  if (/^(例如|比如|案例|举例|注意|重点|考点|定义|如：)/.test(line)) return false;
  return !/[。；;！？!?]$/.test(line);
}

function shortHeading(line, pageNumber) {
  const cleaned = cleanLine(line)
    .replace(/^(第[一二三四五六七八九十百\d]+[章节讲部分])\s*/, '')
    .replace(/[：:]+$/, '')
    .trim();
  return (cleaned || `第 ${pageNumber} 页要点`).slice(0, 36);
}

function isExample(line) {
  return /^(例如|比如|案例|举例|如：|比如：|例\s*[：:\d]|病例[：:]|eg[.:])/i.test(line);
}

function isExamPoint(line) {
  return /(考点|重点|常考|必考|易错|注意|记住|关键|高频)/.test(line);
}

function isDefinition(line) {
  return /(是指|定义|称为|叫做|概念|公式|原理|规律|标准|由.+组成|＝|=)/.test(line) && line.length >= 6;
}

function escapeInline(text) {
  return String(text)
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/_{2,}/g, '')
    .trim();
}

function asBullet(line) {
  return `- ${escapeInline(line)}`;
}

function asDefinition(line) {
  const text = escapeInline(line).replace(/[。；;]\s*$/, '');
  return `- **${text}** 📌 必背`;
}

function asExam(line) {
  const text = escapeInline(line)
    .replace(/^(⚠️|考点|重点|注意|常考|必考|易错|关键|高频|本章重点)\s*[：:]\s*/, '')
    .replace(/^(⚠️|考点)\s*/, '');
  return `- ⚠️ 考点：${text}`;
}

function summaryText(line) {
  return escapeInline(line)
    .replace(/📌 必背/g, '')
    .replace(/^(本章)?(重点|注意|考点|关键)\s*[：:]\s*/, '')
    .trim();
}

/**
 * 未配置大模型时的确定性兜底引擎。
 * 它不是假装 AI：只做保守的结构化重排（标题/要点/必背/考点/举例/速记），
 * 保证未配置 API 的本地演示也能完整跑通上传→结构化笔记→搜索→导出。
 * 通过 engine='local-fallback' 明确标识，UI 会提示用户配置 AI。
 */
export function generateLocalNotes({ rawText, title }) {
  const pages = splitPages(rawText);
  if (!pages.length) {
    const err = new Error('没有可整理的课件文本');
    err.code = 'NO_TEXT';
    throw err;
  }

  // 去除每页重复的页眉/页脚（如课程名、页码），避免把版式文字误当知识点。
  const frequency = new Map();
  const pageLines = pages.map((page) =>
    page.text
      .split('\n')
      .map(cleanLine)
      .filter((line) => line && !/^\[Page \d+\]$/i.test(line)),
  );
  for (const lines of pageLines) {
    for (const line of new Set(lines)) frequency.set(line, (frequency.get(line) || 0) + 1);
  }
  const repeatThreshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const furniture = new Set(
    [...frequency.entries()].filter(([line, count]) => count >= repeatThreshold && line.length <= 60).map(([line]) => line),
  );

  const sections = [];
  const summaryPool = [];
  const extraPool = [];
  const seenSummary = new Set();
  const seenExtra = new Set();

  const rememberSummary = (line) => {
    const text = summaryText(line).slice(0, 70);
    if (!text || text.length < 4) return;
    const key = text.toLowerCase();
    if (seenSummary.has(key)) return;
    seenSummary.add(key);
    summaryPool.push(text);
  };

  const rememberExtra = (line) => {
    const text = summaryText(line).slice(0, 70);
    if (!text || text.length < 4) return;
    const key = text.toLowerCase();
    if (seenExtra.has(key)) return;
    seenExtra.add(key);
    extraPool.push(text);
  };

  pages.forEach((page, pageIndex) => {
    const allLines = pageLines[pageIndex].filter(
      (line) =>
        !furniture.has(line) &&
        !/课堂讲义|讲稿|课件制作|^\d+\s*\/\s*\d+$/.test(line) &&
        !/·\s*\d+$/.test(line),
    );
    if (!allLines.length) return;

    let heading = shortHeading(allLines[0], page.number);
    let bodyLines = allLines;
    if (isTitleLine(allLines[0])) bodyLines = allLines.slice(1);
    if (heading.length > 34) heading = `第 ${page.number} 页要点`;

    const bullets = [];
    const examples = [];
    let pageImportant = false;

    bodyLines.forEach((line) => {
      rememberExtra(line);
      if (isExample(line)) {
        examples.push(line.replace(/^(例如|比如|案例|病例|举例|如：)\s*[：:]?\s*/, ''));
        rememberSummary(line);
        return;
      }
      if (isExamPoint(line)) {
        bullets.push(asExam(line));
        rememberSummary(line);
        pageImportant = true;
        return;
      }
      if (isDefinition(line)) {
        bullets.push(asDefinition(line));
        rememberSummary(line);
        pageImportant = true;
        return;
      }
      bullets.push(asBullet(line));
      if (!pageImportant && bullets.length <= 2) rememberSummary(line);
    });

    // 如果第一行本身就是唯一正文（没有标题行），把它保留为要点，避免丢内容。
    if (!bodyLines.length && allLines[0]) {
      bullets.push(asBullet(allLines[0]));
      rememberSummary(allLines[0]);
    }
    if (!bullets.length && !examples.length) return;

    const numberPrefix = pageIndex < CN_NUM.length ? CN_NUM[pageIndex] : String(pageIndex + 1);
    const lines = [`## ${numberPrefix}、${heading}`];
    lines.push('');
    if (bullets.length) {
      lines.push('### 核心要点', '');
      lines.push(...bullets);
      lines.push('');
    }
    if (examples.length) {
      lines.push('### 📖 老师举例', '');
      lines.push(...examples.map((item) => `- ${escapeInline(item)}`));
      lines.push('');
    }
    sections.push(lines.join('\n').trim());
  });

  // 速记固定 5-8 条：优先定义/考点，再补充普通要点；绝不编造课程内容。
  const finalSummary = summaryPool.slice(0, 8);
  if (finalSummary.length < 5) {
    const existing = new Set(finalSummary.map((item) => item.toLowerCase()));
    for (const candidate of extraPool) {
      if (finalSummary.length >= Math.min(5, 8)) break;
      if (existing.has(candidate.toLowerCase())) continue;
      existing.add(candidate.toLowerCase());
      finalSummary.push(candidate);
    }
  }

  const parts = sections.length ? sections : [`## 一、内容概览\n\n${asBullet(title || '课件内容')}`];
  if (finalSummary.length) {
    parts.push(['## 🎯 本章速记', '', ...finalSummary.map((item) => `- ${item}`)].join('\n'));
  }

  return {
    markdown: parts.join('\n\n'),
    engine: 'local-fallback',
    chunks: 1,
  };
}
