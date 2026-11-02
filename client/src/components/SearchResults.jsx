import { Button, Skeleton, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

import EmptyState from './EmptyState.jsx';
import HighlightText from './HighlightText.jsx';

/**
 * 课程内搜索结果：每个笔记最多 3 段命中（后端已截好 snippet）。
 * 点击后跳转阅读页并带上 q + hit（hit = occurrence，即该命中在笔记中的序号）。
 */
export default function SearchResults({ query, result, loading, error, onOpen, onClear }) {
  if (loading) {
    return (
      <div className="search-list">
        <Skeleton active paragraph={{ rows: 2 }} />
        <Skeleton active paragraph={{ rows: 2 }} />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="搜索失败"
        description={error}
        action={
          <Button onClick={onClear} icon={<SearchOutlined />}>
            清除搜索
          </Button>
        }
      />
    );
  }

  const total = result?.total ?? 0;
  const results = result?.results || [];

  if (total === 0) {
    return (
      <EmptyState
        title={`没有找到「${query}」`}
        description="试试更短的关键词，或换一个说法。搜索范围是本科程已完成笔记的标题与正文。"
        action={<Button onClick={onClear}>清除搜索</Button>}
      />
    );
  }

  return (
    <div className="search-result-block">
      <div className="search-summary">
        「{query}」共 {total} 段命中 · 点击结果直接跳到原文位置
      </div>
      <div className="search-list">
        {results.map((item) => (
          <button
            type="button"
            className="search-item"
            key={`${item.noteId}-${item.occurrence}`}
            onClick={() => onOpen?.(item)}
          >
            <div className="search-item-head">
              <span className="search-item-title">{item.title}</span>
              {item.heading && (
                <span className="search-item-heading" title={item.heading}>
                  {String(item.heading).replace(/^#+\s*/, '')}
                </span>
              )}
              <Tag bordered={false} className="search-item-count">
                {item.matchCount ?? 1} 处命中
              </Tag>
            </div>
            <p className="search-item-snippet">
              <HighlightText text={item.snippet} query={query} />
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
