import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Input, Result, Skeleton, Tooltip } from 'antd';
import {
  ArrowLeftOutlined,
  CloudUploadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';

import AppHeader from '../components/AppHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import NoteListItem from '../components/NoteListItem.jsx';
import QueueBar from '../components/QueueBar.jsx';
import SearchResults from '../components/SearchResults.jsx';
import UploadModal from '../components/UploadModal.jsx';
import DeleteButton from '../components/DeleteButton.jsx';
import { api } from '../api.js';
import useCourseQueue from '../hooks/useCourseQueue.js';
import { formatRelativeTime, sanitizeFilename } from '../utils/format.js';

const EMPTY_SEARCH = { q: '', loading: false, result: null, error: '' };

/**
 * 课程详情：课程名 + 批量上传 + 课程内全文搜索 + 笔记列表 + 处理中队列浮条。
 * 队列 active 结束后自动刷新笔记列表。
 */
export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  const [data, setData] = useState(null); // { course, notes }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { status, message }
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState(EMPTY_SEARCH);
  const [retryingId, setRetryingId] = useState(null);
  const [exporting, setExporting] = useState('');

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await api.get(`/courses/${encodeURIComponent(courseId)}`);
        setData(response);
        setError(null);
      } catch (err) {
        if (!silent) setError({ status: err?.status || 0, message: err?.message || '课程加载失败' });
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [courseId],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    setQuery('');
    setSearch(EMPTY_SEARCH);
    load();
  }, [load]);

  // 队列处理结束（active=false）后静默刷新笔记列表
  const handleSettled = useCallback(() => {
    load(true);
  }, [load]);

  const queue = useCourseQueue(courseId, handleSettled);

  const runSearch = async (raw) => {
    const keyword = String(raw ?? '').trim();
    if (!keyword) {
      setSearch(EMPTY_SEARCH);
      return;
    }
    setSearch({ q: keyword, loading: true, result: null, error: '' });
    try {
      const response = await api.get(
        `/courses/${encodeURIComponent(courseId)}/search?q=${encodeURIComponent(keyword)}`,
      );
      setSearch({ q: keyword, loading: false, result: response, error: '' });
    } catch (err) {
      setSearch({ q: keyword, loading: false, result: null, error: err?.message || '搜索失败' });
    }
  };

  const handleQueryChange = (event) => {
    const value = event.target.value;
    setQuery(value);
    if (!value.trim()) setSearch(EMPTY_SEARCH);
  };

  const clearSearch = () => {
    setQuery('');
    setSearch(EMPTY_SEARCH);
  };

  const openSearchResult = (item) => {
    const params = new URLSearchParams({ q: search.q, hit: String(item.occurrence ?? 0) });
    navigate(`/courses/${courseId}/notes/${item.noteId}?${params.toString()}`);
  };

  const handleAccepted = (result) => {
    // 上传接口立即返回 accepted notes：先点亮浮条，再刷新列表拿到 processing 行
    queue.prime(result?.notes || [], result?.accepted ?? 0);
    load(true);
  };

  const handleRetry = async (noteOrId) => {
    const noteId = typeof noteOrId === 'string' ? noteOrId : noteOrId?.id;
    if (!noteId) return;
    setRetryingId(noteId);
    try {
      await api.post(`/notes/${encodeURIComponent(noteId)}/retry`);
      message.success('已重新加入队列');
      queue.kick();
      load(true);
    } catch (err) {
      message.error(
        err?.code === 'FILE_EXPIRED'
          ? '没有可重试的文本，请重新上传这份课件'
          : err?.message || '重试失败，请稍后再试',
      );
    } finally {
      setRetryingId(null);
    }
  };

  const handleExport = async (format) => {
    if (!data?.course) return;
    setExporting(format);
    const base = sanitizeFilename(data.course.name || '课程');
    try {
      const filename = await api.download(
        `/courses/${encodeURIComponent(courseId)}/export?format=${format}`,
        `${base}-笔记.${format}`,
      );
      message.success(`已开始下载 ${filename}`);
    } catch (err) {
      message.error(err?.message || '导出失败，请稍后再试');
    } finally {
      setExporting('');
    }
  };

  const handleDeleteNote = async (note) => {
    await api.del(`/notes/${encodeURIComponent(note.id)}`);
    message.success('笔记已删除');
    await load(true);
    queue.kick();
  };

  const handleDeleteCourse = async () => {
    await api.del(`/courses/${encodeURIComponent(courseId)}`);
    message.success('课程已删除');
    navigate('/');
  };

  const notes = data?.notes || [];
  const course = data?.course;
  const processingCount = notes.filter((note) => note.status === 'processing').length;
  const failedCount = notes.filter((note) => note.status === 'failed').length;
  const doneCount = notes.filter((note) => note.status === 'done').length;

  let body = null;

  if (loading) {
    body = (
      <div className="course-loading">
        <Skeleton active title={{ width: 220 }} paragraph={{ rows: 2 }} />
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  } else if (error && error.status === 404) {
    body = (
      <Result
        status="404"
        title="课程不存在"
        subTitle="它可能已被删除，或者不属于当前登录用户。"
        extra={[
          <Button key="home" type="primary" onClick={() => navigate('/')}>
            回到首页
          </Button>,
        ]}
      />
    );
  } else if (error) {
    body = (
      <Alert
        type="error"
        showIcon
        message="课程加载失败"
        description={error.message}
        action={
          <Button size="small" onClick={() => load()}>
            重试
          </Button>
        }
      />
    );
  } else if (course) {
    body = (
      <>
        <div className="course-heading">
          <div className="course-heading-main">
            <Link to="/" className="crumb-link">
              <ArrowLeftOutlined /> 全部课程
            </Link>
            <h1 className="course-name">{course.name}</h1>
            <p className="course-meta">
              {notes.length} 篇笔记 · 最近更新 {formatRelativeTime(course.updatedAt || course.createdAt) || '—'}
            </p>
          </div>
          <div className="course-heading-actions">
            <DeleteButton
              title={`删除课程《${course.name}》？`}
              description="将删除全部笔记并停止未完成任务，删除后无法恢复。"
              label="删除课程"
              size="middle"
              onDelete={handleDeleteCourse}
            />
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
              批量上传
            </Button>
            <Tooltip title={doneCount === 0 ? '还没有已完成的笔记可导出' : ''}>
              <span>
                <ExportMenu
                  onExport={handleExport}
                  loading={Boolean(exporting)}
                  disabled={doneCount === 0}
                />
              </span>
            </Tooltip>
          </div>
        </div>

        <div className="course-search">
          <Input.Search
            allowClear
            size="large"
            enterButton={<SearchOutlined aria-label="搜索笔记" />}
            aria-label="搜索本课程笔记"
            placeholder="在本课程中搜索：标题、正文都能搜到"
            value={query}
            onChange={handleQueryChange}
            onSearch={runSearch}
            loading={search.loading}
          />
        </div>

        {search.q ? (
          <SearchResults
            query={search.q}
            result={search.result}
            loading={search.loading}
            error={search.error}
            onOpen={openSearchResult}
            onClear={clearSearch}
          />
        ) : (
          <section className="notes-section">
            <div className="notes-section-head">
              <div className="notes-section-title">笔记（{notes.length}）</div>
              <div className="notes-section-hint">
                {processingCount > 0
                  ? `${processingCount} 篇正在解析`
                  : failedCount > 0
                    ? `${failedCount} 篇处理失败，请查看原因并重试或重新上传`
                    : '按上传顺序排列'}
              </div>
            </div>

            {notes.length === 0 ? (
              <EmptyState
                title="这门课还没有笔记"
                description="点击「批量上传」导入演示文稿、Word、表格、PDF、文本或 ZIP，整理完成后会自动出现在这里。"
                action={
                  <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
                    批量上传课件
                  </Button>
                }
              />
            ) : (
              <div className="note-list">
                {notes.map((note) => (
                  <NoteListItem
                    key={note.id}
                    note={note}
                    retrying={retryingId === note.id}
                    onOpen={(target) => navigate(`/courses/${courseId}/notes/${target.id}`)}
                    onRetry={handleRetry}
                    onDelete={handleDeleteNote}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </>
    );
  }

  return (
    <div className="page-shell">
      <AppHeader />
      <main className="page-main" style={queue.visible ? { paddingBottom: 172 } : undefined}>
        {body}
      </main>

      {queue.visible && (
        <QueueBar queue={queue.queue} onRetry={handleRetry} retryingId={retryingId} />
      )}

      <UploadModal
        open={uploadOpen}
        courseId={courseId}
        onClose={() => setUploadOpen(false)}
        onAccepted={handleAccepted}
      />
    </div>
  );
}
