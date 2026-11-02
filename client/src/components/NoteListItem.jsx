import { Button, Tag } from 'antd';
import { FileTextOutlined, RedoOutlined, RightOutlined } from '@ant-design/icons';

import StatusTag from './StatusTag.jsx';
import DeleteButton from './DeleteButton.jsx';
import { formatRelativeTime, truncateText } from '../utils/format.js';

/**
 * 笔记列表行：标题、摘要前 100 字、处理时间、状态。
 * 完成后可阅读；失败时根据是否保有提取文本提供重试或重新上传提示。
 */
export default function NoteListItem({ note, onOpen, onRetry, onDelete, retrying = false }) {
  const clickable = note.status === 'done';
  const timeRef = note.status === 'processing' ? note.createdAt : note.updatedAt || note.createdAt;
  const timeLabel =
    note.status === 'done' ? '完成于' : note.status === 'failed' ? '失败于' : '开始于';

  const handleKeyDown = (event) => {
    if (!clickable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen?.(note);
    }
  };

  return (
    <div
      className={`note-item${clickable ? ' clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen?.(note) : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="note-item-main">
        <h3 className="note-item-title">
          <FileTextOutlined className="note-item-icon" />
          <span className="note-item-title-text" title={note.title}>
            {note.title}
          </span>
          <StatusTag status={note.status} />
          {note.engine === 'local-fallback' && (
            <Tag bordered={false} className="note-engine-tag">
              本地模式
            </Tag>
          )}
        </h3>

        {note.summary ? (
          <p className="note-item-summary">{truncateText(note.summary, 100)}</p>
        ) : note.status === 'processing' ? (
          <p className="note-item-summary muted">正在解析课件，生成结构化笔记…</p>
        ) : note.status === 'failed' ? (
          <p className="note-item-summary failed">
            处理失败{note.errorMessage ? ` · ${note.errorMessage}` : ''}
          </p>
        ) : null}

        <div className="note-item-meta">
          <span className="note-item-file" title={note.sourceFilename}>
            {note.sourceFilename}
          </span>
          <span className="note-item-dot">·</span>
          <span>
            {timeLabel} {formatRelativeTime(timeRef) || '—'}
          </span>
        </div>
      </div>

      <div className="note-item-actions" onClick={(event) => event.stopPropagation()}>
        <DeleteButton
          title={`删除笔记《${note.title}》？`}
          description={note.status === 'processing' ? '会停止处理并删除这篇笔记，删除后无法恢复。' : '笔记及提取文本会被删除，删除后无法恢复。'}
          ariaLabel={`删除笔记 ${note.title}`}
          onDelete={() => onDelete(note)}
        />
        {note.status === 'failed' && note.canRetry && (
          <Button size="small" icon={<RedoOutlined />} loading={retrying} onClick={() => onRetry?.(note)}>
            重试
          </Button>
        )}
        {note.status === 'failed' && !note.canRetry && <span className="muted">请重新上传</span>}
        {clickable && (
          <span className="note-item-arrow" aria-hidden="true">
            <RightOutlined />
          </span>
        )}
      </div>
    </div>
  );
}
