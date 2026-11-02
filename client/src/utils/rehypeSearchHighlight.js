/**
 * rehype 插件：把 Markdown 正文里的检索命中包成 <mark class="search-hit" data-hit="n">。
 *
 * 为什么不用正则替换源字符串：那样会破坏代码块 / 行内代码里的内容，也会和
 * rehype-highlight 生成的 span 打架。这里只处理 hast 的文本节点，天然安全。
 *
 * 顺序约定：本插件排在 rehype-highlight 之后；但会跳过 <code>/<pre> 内部，
 * 避免高亮 token 被拆碎（代码里的命中不参与计数）。
 */
export default function rehypeSearchHighlight(options = {}) {
  const query = String(options.query || '').trim();
  if (!query) return () => {};

  const lowerQuery = query.toLowerCase();
  const queryLength = query.length;

  return (tree) => {
    let counter = 0;

    const walk = (node, insideCode) => {
      if (!node || !Array.isArray(node.children)) return;
      const nextChildren = [];

      for (const child of node.children) {
        if (child.type === 'text' && !insideCode) {
          const value = child.value || '';
          const lowerValue = value.toLowerCase();
          if (!lowerValue.includes(lowerQuery)) {
            nextChildren.push(child);
            continue;
          }

          let cursor = 0;
          let pos = lowerValue.indexOf(lowerQuery);
          while (pos !== -1) {
            if (pos > cursor) {
              nextChildren.push({ type: 'text', value: value.slice(cursor, pos) });
            }
            nextChildren.push({
              type: 'element',
              tagName: 'mark',
              properties: { className: ['search-hit'], 'data-hit': String(counter) },
              children: [{ type: 'text', value: value.slice(pos, pos + queryLength) }],
            });
            counter += 1;
            cursor = pos + queryLength;
            pos = lowerValue.indexOf(lowerQuery, cursor);
          }
          if (cursor < value.length) {
            nextChildren.push({ type: 'text', value: value.slice(cursor) });
          }
          continue;
        }

        if (child.type === 'element' && (child.tagName === 'code' || child.tagName === 'pre')) {
          walk(child, true);
        } else {
          walk(child, insideCode);
        }
        nextChildren.push(child);
      }

      node.children = nextChildren;
    };

    walk(tree, false);
  };
}
