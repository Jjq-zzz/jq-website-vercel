import { Tag } from 'antd';
import { Link } from 'react-router-dom';
import DeleteButton from './DeleteButton.jsx';

import { ArrowRightOutlined } from '@ant-design/icons';
import { formatRelativeTime, getInitial, formatDateTime } from '../utils/format.js';

/**
 * 课程卡片：书脊、课程首字与归档信息构成统一的纸张封面。
 * 删除按钮位于链接外，支持独立的键盘焦点与确认操作。
 */
export default function CourseCard({ course, onDelete }) {
  const noteCount = course.noteCount ?? 0;
  const processingCount = course.processingCount ?? 0;
  const failedCount = course.failedCount ?? 0;
  const updatedLabel = formatRelativeTime(course.updatedAt || course.createdAt);

  return (
    <div className="course-card-container">
    <Link to={`/courses/${course.id}`} className="course-card-link" aria-label={`打开课程 ${course.name}`}>
      <article className="course-card">
        <div className="course-cover">
          <span className="course-cover-label">课程笔记</span>
          <span className="course-cover-char" aria-hidden="true">
            {getInitial(course.name)}
          </span>
          <span className="course-cover-arrow" aria-hidden="true"><ArrowRightOutlined /></span>
        </div>
        <div className="course-card-body">
          <h3 className="course-card-title" title={course.name}>
            {course.name}
          </h3>
          <p className="course-card-meta" title={formatDateTime(course.updatedAt)}>
            <span className="course-note-count">{noteCount} 篇笔记</span>
            <span>{updatedLabel ? `${updatedLabel}更新` : '暂无更新时间'}</span>
          </p>
          <div className="course-card-badges">
            {processingCount > 0 && (
              <Tag color="processing" bordered={false}>
                解析中 {processingCount}
              </Tag>
            )}
            {failedCount > 0 && (
              <Tag color="error" bordered={false}>
                失败 {failedCount}
              </Tag>
            )}
            {noteCount === 0 && processingCount === 0 && failedCount === 0 && (
              <Tag bordered={false}>暂无笔记</Tag>
            )}
          </div>
        </div>
      </article>
    </Link>
    <div className="course-delete-action">
      <DeleteButton
        title={`删除课程《${course.name}》？`}
        description="将删除课程内全部笔记并停止未完成任务，删除后无法恢复。"
        ariaLabel={`删除课程 ${course.name}`}
        onDelete={() => onDelete(course)}
      />
    </div>
    </div>
  );
}
