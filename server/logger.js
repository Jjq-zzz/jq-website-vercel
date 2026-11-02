const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function ts() {
  return new Date().toISOString();
}

function emit(level, scope, message, extra) {
  const color =
    level === 'error' ? COLORS.red : level === 'warn' ? COLORS.yellow : level === 'ai' ? COLORS.cyan : '';
  const line = `${COLORS.gray}${ts()}${COLORS.reset} ${color}[${scope}]${COLORS.reset} ${message}`;
  const stream = level === 'error' ? console.error : console.log;
  if (extra !== undefined) stream(line, extra);
  else stream(line);
}

export const logger = {
  info: (scope, message, extra) => emit('info', scope, message, extra),
  warn: (scope, message, extra) => emit('warn', scope, message, extra),
  error: (scope, message, extra) => emit('error', scope, message, extra),
  ai: (scope, message, extra) => emit('ai', scope, message, extra),
};
