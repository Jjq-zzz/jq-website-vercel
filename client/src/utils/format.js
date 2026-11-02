/** 时间 / 文本 / 文件相关的纯函数工具。 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / x 天前 / 月日 / 年月日 */
export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const diff = now - date.getTime();
  if (diff < 0) return '刚刚'; // 服务端时钟略快时容错
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const dayGap = Math.round((today.getTime() - target.getTime()) / DAY);

  if (dayGap === 1) return '昨天';
  if (dayGap > 1 && dayGap < 7) return `${dayGap} 天前`;
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 绝对时间：2026-10-25 14:30 */
export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 压缩空白并截断（摘要兜底，服务端一般已截到 100 字） */
export function truncateText(text, max = 100) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = index === 0 || size >= 10 ? Math.round(size) : Number(size.toFixed(1));
  return `${rounded} ${units[index]}`;
}

/** 下载文件名安全化（避免 Windows / macOS 非法字符） */
export function sanitizeFilename(name, fallback = '笔记') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** 取名字首字（支持 emoji / 中文） */
export function getInitial(name) {
  const text = String(name || '').trim();
  if (!text) return '课';
  const first = Array.from(text)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 复制文本：优先 Clipboard API，失败降级到 textarea + execCommand */
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试降级方案
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
