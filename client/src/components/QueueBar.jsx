import { useState } from 'react';
import { Button, Progress, Tag } from 'antd';
import { DownOutlined, RedoOutlined, UpOutlined } from '@ant-design/icons';

import StatusTag from './StatusTag.jsx';

/**
 * 处理中队列浮条：固定在页面底部，显示“已处理 x/y”、每项状态 / 失败原因 / 重试。
 * 队列 active=false 时由父组件直接卸载本组件。
 */
export default function QueueBar({ queue, onRetry, retryingId = null }) {
  const [expanded, setExpanded] = useState(true);

  const summary = queue?.summary || { total: 0, done: 0, processing: 0, queued: 0, failed: 0 };
  const items = queue?.items || [];
  const processed = (summary.done || 0) + (summary.failed || 0);
  const total = summary.total || 0;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

  return (
    <div className="queue-bar" role="status" aria-live="polite">
      <div className="queue-bar-inner">
        <div className="queue-bar-head">
          <div className="queue-bar-title">
            <span className="queue-bar-dot" aria-hidden="true" />
            <span>
              已处理 <strong>{processed}</strong>/{total}
            </span>
          </div>
          <Progress
            percent={percent}
            size="small"
            showInfo={false}
            className="queue-bar-progress"
          />
          <div className="queue-bar-stats">
            {summary.processing > 0 && (
              <Tag bordered={false} color="processing">
                解析中 {summary.processing}
              </Tag>
            )}
            {summary.queued > 0 && (
              <Tag bordered={false} color="default">
                排队 {summary.queued}
              </Tag>
            )}
            {summary.done > 0 && (
              <Tag bordered={false} color="success">
                完成 {summary.done}
              </Tag>
            )}
            {summary.failed > 0 && (
              <Tag bordered={false} color="error">
                失败 {summary.failed}
              </Tag>
            )}
          </div>
          <Button
            type="text"
            size="small"
            onClick={() => setExpanded((value) => !value)}
            icon={expanded ? <DownOutlined /> : <UpOutlined />}
            aria-expanded={expanded}
          >
            {expanded ? '收起' : '详情'}
          </Button>
        </div>

        {expanded && (
          <div className="queue-bar-list">
            {items.length === 0 ? (
              <div className="queue-item muted">等待队列状态…</div>
            ) : (
              items.map((item) => {
                // 后端 queue item 的 status 是笔记状态（processing），排队信息在 queueStatus
                const displayStatus =
                  item.status === 'processing' && item.queueStatus === 'queued' ? 'queued' : item.status;
                return (
                  <div className="queue-item" key={item.noteId}>
                    <span className="queue-item-title" title={item.title}>
                      {item.title || '未命名笔记'}
                    </span>
                    {item.status === 'failed' && item.errorMessage && (
                      <span className="queue-item-error" title={item.errorMessage}>
                        {item.errorMessage}
                      </span>
                    )}
                    <StatusTag status={displayStatus} />
                    {item.status === 'failed' && item.canRetry && (
                      <Button
                        size="small"
                        type="link"
                        icon={<RedoOutlined />}
                        loading={retryingId === item.noteId}
                        onClick={() => onRetry?.(item.noteId)}
                      >
                        重试
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
