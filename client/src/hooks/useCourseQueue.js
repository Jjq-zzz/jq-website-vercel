import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.js';

const POLL_INTERVAL = 1200;
const RETRY_INTERVAL = 2500;

/**
 * 课程处理队列轮询。
 * - 进入课程先探一次，刷新页面也能恢复“处理中”浮条。
 * - active 为 false 时停止轮询，并触发 onSettled（页面刷新笔记列表）。
 * - prime() 供上传接口返回后立即点亮浮条（不必等第一次轮询）。
 */
export default function useCourseQueue(courseId, onSettled) {
  const [queue, setQueue] = useState(null);
  const [watching, setWatching] = useState(false);

  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    setQueue(null);
    setWatching(false);
    if (!courseId) return undefined;

    let alive = true;
    api
      .get(`/courses/${encodeURIComponent(courseId)}/queue`)
      .then((data) => {
        if (!alive || !data) return;
        setQueue(data);
        if (data.active) setWatching(true);
      })
      .catch(() => {
        // 队列状态不是阅读关键路径，静默失败即可
      });
    return () => {
      alive = false;
    };
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !watching) return undefined;

    let cancelled = false;
    let timer = null;

    const tick = async () => {
      try {
        const data = await api.get(`/courses/${encodeURIComponent(courseId)}/queue`);
        if (cancelled) return;
        setQueue(data);
        if (!data || !data.active) {
          setWatching(false);
          if (settledRef.current) settledRef.current();
          return;
        }
        timer = window.setTimeout(tick, POLL_INTERVAL);
      } catch {
        if (cancelled) return;
        // 网络抖动时放慢重试，不打断浮条
        timer = window.setTimeout(tick, RETRY_INTERVAL);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [courseId, watching]);

  /**
   * 上传成功后立即展示队列（接口已返回 accepted notes）。
   * 后端同时返回 id 与 noteId，兼容两种字段。
   */
  const prime = useCallback((acceptedNotes = [], acceptedCount = 0) => {
    const items = (acceptedNotes || [])
      .map((note) => ({ note, noteId: note?.id || note?.noteId }))
      .filter((entry) => entry.noteId)
      .map(({ note, noteId }) => {
        const stamp = new Date().toISOString();
        return {
          noteId,
          title: note.title || note.sourceFilename || '未命名笔记',
          status: note.status || 'processing',
          queueStatus: 'queued',
          engine: null,
          retryCount: 0,
          attempts: 0,
          errorMessage: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
      });

    if (items.length === 0) {
      // 拿不到 notes 明细但确实受理了文件，也要开始轮询，避免浮条不出现
      if (acceptedCount > 0) setWatching(true);
      return;
    }

    setQueue({
      active: true,
      summary: { total: items.length, done: 0, processing: 0, queued: items.length, failed: 0 },
      items,
    });
    setWatching(true);
  }, []);

  /** 重试后重新开始轮询 */
  const kick = useCallback(() => setWatching(true), []);

  return {
    queue,
    watching,
    // active 为 false（处理结束）时自动收起浮条；失败项在笔记列表里单独展示
    visible: Boolean(queue) && queue.active !== false,
    prime,
    kick,
  };
}
