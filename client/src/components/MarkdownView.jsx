import { memo, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import rehypeSearchHighlight from '../utils/rehypeSearchHighlight.js';

/**
 * Markdown 渲染：react-markdown + remark-gfm + rehype-highlight。
 * 支持标题 / 加粗 / 列表 / 表格 / 代码块。
 *
 * 搜索定位：rehype 插件把命中包成 <mark class="search-hit" data-hit="n">，
 * 渲染后高亮主动命中项并滚动到第 hit 个（默认第一个）。
 *
 * 注意：本组件用 memo 包裹 —— 父组件把命中数量写回 state 时不会重建 DOM，
 * 否则 <mark> 上的 active class 会丢失。
 */
function MarkdownView({ content = '', query = '', hit = null, onHitInfo }) {
  const containerRef = useRef(null);

  const rehypePlugins = useMemo(() => {
    const plugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
    const keyword = String(query || '').trim();
    if (keyword) plugins.push([rehypeSearchHighlight, { query: keyword }]);
    return plugins;
  }, [query]);

  const components = useMemo(
    () => ({
      a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ node, ...props }) => <img {...props} loading="lazy" alt={props.alt || ''} />,
      table: ({ node, ...props }) => (
        <div className="markdown-table-wrap">
          <table {...props} />
        </div>
      ),
    }),
    [],
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return undefined;

    const marks = Array.from(root.querySelectorAll('mark.search-hit'));
    const raw = hit === null || hit === undefined || hit === '' ? 0 : Number(hit);
    const safeIndex = marks.length === 0 ? -1 : Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), marks.length - 1);

    marks.forEach((node) => node.classList.remove('search-hit-active'));
    const target = safeIndex >= 0 ? marks[safeIndex] : null;
    if (target) target.classList.add('search-hit-active');
    onHitInfo?.({ count: marks.length, index: safeIndex });

    let raf = 0;
    if (target) {
      // 等一帧让长文档完成排版，避免 scrollIntoView 定位偏移
      raf = window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [content, query, hit, onHitInfo]);

  return (
    <div className="markdown-body" ref={containerRef}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownView);
