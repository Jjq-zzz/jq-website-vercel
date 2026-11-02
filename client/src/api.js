/**
 * 统一 API 封装（契约见 docs/api-contract.md）。
 *
 * 约定：
 * - 除登录 / 健康检查外，所有请求自动带上 `Authorization`（来自 localStorage 当前用户）。
 * - 错误统一解析 `{ error: { code, message } }`，抛出 ApiError。
 * - 401 时清空本地登录态并跳转 /login。
 * - 上传走 XMLHttpRequest 以获得上传进度（fetch 无法读取上传进度）。
 * - 下载必须用 fetch + blob（接口需要 登录凭证，不能用裸 window.location）。
 */

const API_PREFIX = '/api';
export const USER_STORAGE_KEY = 'kys.user';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'REQUEST_FAILED') {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getStoredUser() {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeUser(user) {
  if (!user || !user.id) return;
  const payload = { id: user.id, nickname: user.nickname || '', token: user.token || getStoredUser()?.token, aiKeyConfigured: Boolean(user.aiKeyConfigured) };
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

export function clearStoredUser() {
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

function authHeaders(extra) {
  const user = getStoredUser();
  const headers = { ...(extra || {}) };
  if (user) headers.Authorization = `Bearer ${user.token}`;
  return headers;
}

let redirectingToLogin = false;

function handleUnauthorized() {
  clearStoredUser();
  if (typeof window === 'undefined') return;
  if (window.location.pathname.startsWith('/login')) return;
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  // 用整页跳转清空内存状态，避免旧的 user 残留
  window.location.replace('/login');
}

async function parseErrorBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    const data = JSON.parse(text);
    if (data && data.error) return data.error;
    return null;
  } catch {
    return null;
  }
}

async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const hasBody = body !== undefined && body !== null;
  const init = {
    method,
    signal,
    headers: authHeaders({
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      ...headers,
    }),
  };
  if (hasBody) init.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('网络异常，请确认后端服务已启动', 0, 'NETWORK_ERROR');
  }

  if (response.status === 401 && path !== '/auth/login') {
    handleUnauthorized();
    throw new ApiError('请先登录', 401, 'UNAUTHORIZED');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = (data && data.error) || {};
    throw new ApiError(error.message || `请求失败（${response.status}）`, response.status, error.code || 'REQUEST_FAILED');
  }

  return data;
}

/**
 * 批量上传课件：POST /courses/:courseId/files，字段名 files（可多个）。
 * @returns Promise<{ accepted, notes, skipped, message }>
 */
export async function uploadCourseFiles(courseId, files, { onProgress, signal } = {}) {
  const health = await request('/health');
  if (health?.deployment === 'vercel') return uploadVercelFiles(courseId, files, { onProgress, signal });
  if (health?.deployment === 'cloudflare') return uploadCloudFiles(courseId, files, { onProgress, signal });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_PREFIX}/courses/${encodeURIComponent(courseId)}/files`);
    xhr.responseType = 'text';
    const user = getStoredUser();
    if (user) xhr.setRequestHeader('Authorization', `Bearer ${user.token}`);

    if (signal) {
      if (signal.aborted) {
        reject(new ApiError('上传已取消', 0, 'ABORTED'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    if (xhr.upload && typeof onProgress === 'function') {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(event.loaded / event.total, 1));
        }
      };
    }

    xhr.onload = () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status === 401) {
        handleUnauthorized();
        reject(new ApiError('请先登录', 401, 'UNAUTHORIZED'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data || {});
        return;
      }
      const error = (data && data.error) || {};
      reject(new ApiError(error.message || `上传失败（${xhr.status}）`, xhr.status, error.code || 'UPLOAD_FAILED'));
    };
    xhr.onerror = () => reject(new ApiError('网络异常，上传失败', 0, 'NETWORK_ERROR'));
    xhr.onabort = () => reject(new ApiError('上传已取消', 0, 'ABORTED'));
    xhr.ontimeout = () => reject(new ApiError('上传超时，请重试', 0, 'TIMEOUT'));

    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    xhr.send(form);
  });
}

/** 大文件从浏览器直传私有 Blob，函数只接收授权和完成通知。 */
async function uploadVercelFiles(courseId, files, { onProgress, signal }) {
  const { upload } = await import('@vercel/blob/client');
  const notes = [], skipped = [];
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let transferred = 0;
  for (const file of files) {
    if (signal?.aborted) throw new ApiError('上传已取消', 0, 'ABORTED');
    try {
      const ticket = await request(`/courses/${encodeURIComponent(courseId)}/upload-ticket`, { method: 'POST', body: { filename: file.name, size: file.size }, signal });
      await upload(ticket.pathname, file, {
        access: 'private', handleUploadUrl: '/api/blob-upload',
        clientPayload: JSON.stringify({ ticketId: ticket.id, token: getStoredUser()?.token }),
        multipart: file.size > 8 * 1024 * 1024,
        contentType: file.type || 'application/octet-stream', abortSignal: signal,
        onUploadProgress: ({ loaded }) => onProgress?.(Math.min(1, (transferred + loaded) / total)),
      });
      const accepted = await request(`/uploads/${encodeURIComponent(ticket.id)}/complete`, { method: 'POST', body: {}, signal });
      notes.push(...accepted.notes);
    } catch (error) {
      if (signal?.aborted || error.status === 401) throw error;
      skipped.push({ name: file.name, reason: error.message || '上传失败' });
    }
    transferred += file.size;
    onProgress?.(transferred / total);
  }
  if (!notes.length) throw new ApiError(skipped.map((file) => `${file.name}：${file.reason}`).join('；') || '没有可处理的文件');
  return { accepted: notes.length, notes, skipped, message: `已加入队列，共 ${notes.length} 个文件` };
}

/** 云端逐文件流式提交，避免将多份大课件缓冲到边缘运行时。 */
async function uploadCloudFiles(courseId, files, { onProgress, signal }) {
  const notes = [], skipped = [];
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let transferred = 0;
  for (const file of files) {
    if (signal?.aborted) throw new ApiError('上传已取消', 0, 'ABORTED');
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_PREFIX}/courses/${encodeURIComponent(courseId)}/files?filename=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        const user = getStoredUser();
        if (user) xhr.setRequestHeader('Authorization', `Bearer ${user.token}`);
        const abort = () => xhr.abort();
        signal?.addEventListener('abort', abort, { once: true });
        xhr.upload.onprogress = (event) => onProgress?.(Math.min(1, (transferred + event.loaded) / total));
        xhr.onloadend = () => signal?.removeEventListener('abort', abort);
        xhr.onerror = () => reject(new ApiError('网络异常，上传失败', 0, 'NETWORK_ERROR'));
        xhr.onabort = () => reject(new ApiError('上传已取消', 0, 'ABORTED'));
        xhr.onload = () => {
          let data;
          try { data = JSON.parse(xhr.responseText); } catch { data = null; }
          if (xhr.status === 401) handleUnauthorized();
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(data?.error?.message || `上传失败（${xhr.status}）`, xhr.status, data?.error?.code));
        };
        xhr.send(file);
      });
      notes.push(...result.notes);
    } catch (error) {
      if (error.code === 'ABORTED' || error.status === 401) throw error;
      skipped.push({ name: file.name, reason: error.message });
    }
    transferred += file.size;
    onProgress?.(transferred / total);
  }
  if (!notes.length) throw new ApiError(skipped.map((item) => `${item.name}：${item.reason}`).join('；') || '没有可上传的文件');
  return { accepted: notes.length, notes, skipped, message: `已加入队列，共 ${notes.length} 个文件` };
}

function parseContentDisposition(header) {
  if (!header) return null;
  const utf8 = header.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8[1].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = header.match(/filename="([^"]*)"/) || header.match(/filename=([^;]+)/);
  if (plain && plain[1]) {
    const value = plain[1].trim();
    // multipart / 下载名称中以 latin-1 传输的中文需要还原，失败则保留原串
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 带登录态下载文件（笔记 .md / 课程导出 md、zip）。
 * 解析 Content-Disposition 文件名，拿不到则用 fallbackName。
 */
export async function downloadFile(path, fallbackName, { signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { headers: authHeaders(), signal });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('网络异常，下载失败', 0, 'NETWORK_ERROR');
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError('请先登录', 401, 'UNAUTHORIZED');
  }
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ApiError(
      (error && error.message) || `下载失败（${response.status}）`,
      response.status,
      (error && error.code) || 'DOWNLOAD_FAILED',
    );
  }

  const blob = await response.blob();
  const filename = parseContentDisposition(response.headers.get('Content-Disposition')) || fallbackName;
  saveBlob(blob, filename);
  return filename;
}

export const api = {
  getAiSettings: () => request('/settings/ai-key'),
  saveAiSettings: (payload) => request('/settings/ai-key', { method: 'PUT', body: payload }),
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  uploadFiles: uploadCourseFiles,
  download: downloadFile,
  health: () => request('/health'),
};

export default api;
