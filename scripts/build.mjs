/** 使用项目内的临时目录构建，避免系统 Temp 目录的权限影响 esbuild。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectory = path.join(root, '.tmp-build');
fs.mkdirSync(temporaryDirectory, { recursive: true });

const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
    'build', '--config', path.join(root, 'client', 'vite.config.js'), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    // 同时覆盖 Node.js 和 esbuild 子进程读取的临时路径，仅对本次构建生效。
    env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory },
  },
);

if (result.error) console.error('前端构建无法启动：', result.error.message);
process.exitCode = result.status ?? 1;
