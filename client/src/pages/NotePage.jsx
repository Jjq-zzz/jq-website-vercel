import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Drawer, Grid, Result, Skeleton, Space, Spin } from 'antd';
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DownloadOutlined,
  MenuOutlined,
  RedoOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import MarkdownView from '../components/MarkdownView.jsx';
import DeleteButton from '../components/DeleteButton.jsx';
import { api } from '../api.js';
import { copyText, sanitizeFilename, formatDateTime } from '../utils/format.js';

/**
 * 笔记阅读页：
 * 顶部返回 / 复制 Markdown / 下载 .md；左侧本课程笔记目录；中间 Markdown 渲染。
 * URL 带 ?q=&hit= 时高亮所有命中并滚动到第 hit 个。
 * 覆盖 加载态 / 404 / 处理中 / 失败态。
 */
export default function NotePage() {
  const { courseId, noteId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = AntdApp.useApp();
  const screens = Grid.useBreakpoint();
  // 首帧 screens 为空对象，默认按桌面布局渲染，避免闪烁
  const isNarrow = screens.lg === false;

  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [downloading, setDownloading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [hitInfo, setHitInfo] = useState({ count: 0, index: -1 });

  const query = (searchParams.get('q') || '').trim();
  const hitParam = searchParams.get('hit');
  const hit = hitParam !== null && hitParam !== '' && Number.isFinite(Number(hitParam)) ? Number(hitParam) : null;

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setState({ loading: true, data: null, error: null });
      try {
        const data = await api.get(`/notes/${encodeURIComponent(noteId)}`);
        setState({ loading: false, data, error: null });
      } catch (err) {
        if (silent) return; // 处理中轮询失败不打断页面
        setState({
          loading: false,
          data: null,
          error: { status: err?.status || 0, message: err?.message || '笔记加载失败' },
        });
      }
    },
    [noteId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const noteStatus = state.data?.note?.status;

  // 处理中：每 1.6s 静默刷新，完成后自动展示正文
  useEffect(() => {
    if (noteStatus !== 'processing') return undefined;
    const timer = window.setInterval(() => load(true), 1600);
    return () => window.clearInterval(timer);
  }, [noteStatus, load]);

  const note = state.data?.note;
  const course = state.data?.course;
  const siblings = useMemo(() => state.data?.siblings || [], [state.data]);

  useEffect(() => {
    // 没有搜索条件时回到顶部；有 q 时交给 MarkdownView 滚动到命中位置（父层不要抢）
    if (!query) window.scrollTo({ top: 0 });
  }, [noteId, query]);

  const goCourse = useCallback(() => {
    if (courseId) navigate(`/courses/${courseId}`);
    else navigate('/');
  }, [courseId, navigate]);

  const handleCopy = async () => {
    if (!note?.markdownContent) return;
    const markdown = `# ${note.title}\n\n${note.markdownContent}`;
    const ok = await copyText(markdown);
    if (ok) message.success('Markdown 已复制到剪贴板');
    else message.error('复制失败，请手动选择内容复制');
  };

  const handleDownload = async () => {
    if (!note) return;
    setDownloading(true);
    try {
      const filename = await api.download(
        `/notes/${encodeURIComponent(note.id)}/download`,
        `${sanitizeFilename(note.title || '笔记')}.md`,
      );
      message.success(`已开始下载 ${filename}`);
    } catch (err) {
      message.error(err?.message || '下载失败，请稍后再试');
    } finally {
      setDownloading(false);
    }
  };

  const handleRetry = async () => {
    if (!note) return;
    setRetrying(true);
    try {
      await api.post(`/notes/${encodeURIComponent(note.id)}/retry`);
      message.success('已重新加入队列');
      await load(true);
    } catch (err) {
      message.error(err?.message || '重试失败，请稍后再试');
    } finally {
      setRetrying(false);
    }
  };

  const handleDelete = async () => {
    await api.del(`/notes/${encodeURIComponent(note.id)}`);
    message.success('笔记已删除');
    goCourse();
  };

  const handleHitInfo = useCallback((info) => {
    setHitInfo((prev) => (prev.count === info.count && prev.index === info.index ? prev : info));
  }, []);

  const toc = (
    <nav className={isNarrow ? 'note-toc note-toc-drawer' : 'note-toc'} aria-label="本课程笔记目录">
      {!isNarrow && <h4 className="note-toc-title">本课程笔记 <span>{siblings.length}</span></h4>}
      {siblings.length === 0 && <div className="toc-empty">还没有其他笔记</div>}
      {siblings.map((item) => (
        <Link
          key={item.id}
          to={`/courses/${courseId}/notes/${item.id}`}
          className={`toc-item${item.id === noteId ? ' active' : ''}`}
          aria-current={item.id === noteId ? 'page' : undefined}
          onClick={() => {
            if (isNarrow) setTocOpen(false);
          }}
        >
          <span className="toc-item-dot" data-status={item.status} aria-hidden="true" />
          <span className="toc-item-label" title={item.title}>
            {item.title}
          </span>
        </Link>
      ))}
    </nav>
  );

  let content = null;

  if (state.loading) {
    content = (
      <div className="note-content">
        <Skeleton active title={{ width: '55%' }} paragraph={{ rows: 12 }} />
      </div>
    );
  } else if (state.error) {
    content = (
      <div className="note-content">
        <Result
          status={state.error.status === 404 ? '404' : 'error'}
          title={state.error.status === 404 ? '笔记不存在' : '笔记加载失败'}
          subTitle={
            state.error.status === 404
              ? '它可能已被删除，或者链接不正确。'
              : state.error.message
          }
          extra={[
            <Button key="back" type="primary" onClick={goCourse}>
              返回课程
            </Button>,
            <Button key="home" onClick={() => navigate('/')}>
              回到首页
            </Button>,
          ]}
        />
      </div>
    );
  } else if (note.status === 'processing') {
    content = (
      <div className="note-content note-status-block">
        <Spin size="large" />
        <h2>正在解析这份课件…</h2>
        <p>页面会自动刷新，通常需要几十秒。可以先去看看课程里的其他笔记。</p>
        <Button onClick={goCourse}>返回课程</Button>
      </div>
    );
  } else if (note.status === 'failed') {
    content = (
      <div className="note-content">
        <Result
          status="warning"
          title="处理失败"
          subTitle={note.errorMessage || '这份课件没有解析成功，请重新上传。'}
          extra={[
            note.canRetry && <Button key="retry" type="primary" icon={<RedoOutlined />} loading={retrying} onClick={handleRetry}>
              重试
            </Button>,
            <Button key="back" onClick={goCourse}>
              返回课程
            </Button>,
          ]}
        />
      </div>
    );
  } else {
    content = (
      <div className="note-content">
        <div className="reading-meta">
          <span className="reading-label">复习笔记</span>
          <span title={note.sourceFilename}>{note.sourceFilename}</span>
          <time>{formatDateTime(note.updatedAt || note.createdAt)}</time>
        </div>
        {query && (
          <div className="note-search-bar">
            <SearchOutlined />
            <span className="note-search-text">
              搜索「{query}」·
              {hitInfo.count > 0
                ? `命中 ${hitInfo.count} 处，已定位第 ${hitInfo.index + 1} 处`
                : '没有命中'}
            </span>
            <Button size="small" type="text" onClick={() => setSearchParams({}, { replace: true })}>
              清除搜索
            </Button>
          </div>
        )}
        <MarkdownView
          content={note.markdownContent || ''}
          query={query}
          hit={hit}
          onHitInfo={handleHitInfo}
        />
      </div>
    );
  }

  return (
    <div className="note-page">
      <header className="note-topbar">
        <div className="note-topbar-inner">
          <div className="note-topbar-left">
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={goCourse} className="note-back">
              {course?.name || '返回课程'}
            </Button>
            {note && (
              <span className="note-topbar-title" title={note.title}>
                {note.title}
              </span>
            )}
          </div>
          <Space className="note-topbar-actions" size={8} wrap>
            {note && <DeleteButton
              title={`删除笔记《${note.title}》？`}
              description="会停止未完成的处理并删除笔记，删除后无法恢复。"
              label="删除笔记"
              size="middle"
              onDelete={handleDelete}
            />}
            {note?.status === 'done' && (
              <>
                <Button icon={<CopyOutlined />} onClick={handleCopy}>
                  复制 Markdown
                </Button>
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  loading={downloading}
                  onClick={handleDownload}
                >
                  下载 .md
                </Button>
              </>
            )}
            {isNarrow && (
              <Button icon={<MenuOutlined />} onClick={() => setTocOpen(true)}>
                目录
              </Button>
            )}
          </Space>
        </div>
      </header>

      <div className="note-body">
        {!isNarrow && note && toc}
        {content}
      </div>

      {isNarrow && (
        <Drawer
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          placement="left"
          width={280}
          title="本课程笔记"
          styles={{ body: { padding: '8px' } }}
        >
          {toc}
        </Drawer>
      )}
    </div>
  );
}
