/**
 * 搜索片段高亮：把 query 的所有命中包成 <mark>，只用于搜索结果片段。
 */
export default function HighlightText({ text = '', query = '' }) {
  const source = String(text ?? '');
  const keyword = String(query || '').trim();
  if (!keyword) return <>{source}</>;

  const lowerSource = source.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const parts = [];
  let cursor = 0;
  let index = 0;
  let pos = lowerSource.indexOf(lowerKeyword);

  while (pos !== -1) {
    if (pos > cursor) parts.push(source.slice(cursor, pos));
    parts.push(
      <mark className="search-hit" key={`hit-${index}`}>
        {source.slice(pos, pos + keyword.length)}
      </mark>,
    );
    cursor = pos + keyword.length;
    index += 1;
    pos = lowerSource.indexOf(lowerKeyword, cursor);
  }
  if (cursor < source.length) parts.push(source.slice(cursor));

  return <>{parts}</>;
}
