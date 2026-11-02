import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Skeleton } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import AppHeader from '../components/AppHeader.jsx';
import CourseCard from '../components/CourseCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import NewCourseModal from '../components/NewCourseModal.jsx';
import { api } from '../api.js';

/**
 * 首页：课程卡片网格 + 右下角「+ 新建课程」浮动按钮。
 * 顶部应用名 + 用户昵称菜单（切换用户 / 退出）。
 */
export default function CoursesPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  const [courses, setCourses] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/courses');
      setCourses(Array.isArray(data?.courses) ? data.courses : []);
      setError('');
    } catch (err) {
      setError(err?.message || '课程加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = (course) => {
    setCreateOpen(false);
    message.success('课程已创建');
    if (course?.id) navigate(`/courses/${course.id}`);
    else load();
  };

  const handleDelete = async (course) => {
    await api.del(`/courses/${encodeURIComponent(course.id)}`);
    setCourses((items) => items.filter((item) => item.id !== course.id));
    message.success('课程已删除');
  };

  const count = courses?.length ?? 0;
  const noteCount = courses?.reduce((sum, course) => sum + (course.noteCount ?? 0), 0) ?? 0;

  return (
    <div className="page-shell">
      <AppHeader />

      <main className="page-main">
        <div className="page-heading library-heading">
          <div>
            <div className="page-eyebrow">课研 · 学习归档</div>
            <h1>我的课程</h1>
            <p>
              {loading
                ? '正在读取课程…'
                : count > 0
                  ? '课件按课程收好，复习从这里开始。'
                  : '先建一门课程，再把课件一起放进来。'}
            </p>
          </div>
          {!loading && count > 0 && (
            <dl className="library-counts" aria-label="笔记库概览">
              <div><dt>课程</dt><dd>{String(count).padStart(2, '0')}<span> 门</span></dd></div>
              <div><dt>笔记</dt><dd>{String(noteCount).padStart(2, '0')}<span> 篇</span></dd></div>
            </dl>
          )}
        </div>

        <div className="library-toolbar">
          <span className="library-section-label">全部课程 <span>{count}</span></span>
          <div className="library-toolbar-actions">
            <span className="library-sort">最近更新在前</span>
            <Button type="text" icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          </div>
        </div>

        {error && (
          <Alert
            className="page-alert"
            type="error"
            showIcon
            message="课程加载失败"
            description={error}
            action={
              <Button size="small" onClick={load}>
                重试
              </Button>
            }
          />
        )}

        {loading && !courses ? (
          <div className="card-grid">
            {[0, 1, 2, 3].map((key) => (
              <div className="course-card-skeleton" key={key}>
                <Skeleton.Image active style={{ width: '100%', height: 104 }} />
                <Skeleton active paragraph={{ rows: 2 }} title={{ width: '60%' }} />
              </div>
            ))}
          </div>
        ) : count === 0 ? (
          <EmptyState
            title="还没有课程"
            description="新建一门课程，把演示文稿、Word、表格、PDF、文本或 ZIP 一次性拖进去，生成按章节整理的复习笔记。"
            action={
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                新建第一门课程
              </Button>
            }
          />
        ) : (
          <div className="card-grid">
            {courses.map((course) => (
              <CourseCard key={course.id} course={course} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </main>

      <Button
        className="fab"
        type="primary"
        size="large"
        shape="round"
        icon={<PlusOutlined />}
        onClick={() => setCreateOpen(true)}
      >
        新建课程
      </Button>

      <NewCourseModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
    </div>
  );
}
