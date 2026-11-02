/** 在独立数据库中运行浏览器验收，避免修改用户现有课程。 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'course-notes-browser-'));
const port = 45000 + process.pid % 10000;
const base = process.env.BASE_URL || `http://127.0.0.1:${port}`;
let server;
let logs = '';

try {
  if (!process.env.BASE_URL) {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: {
        ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
        DB_PATH: path.join(data, 'course-notes.db'),
        AI_API_KEY: '', AI_MODEL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', DEEPSEEK_API_KEY: '',
        LOCAL_ENGINE_DELAY_MS: '1800', NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => { logs += chunk; });
    server.stderr.on('data', (chunk) => { logs += chunk; });
    let ready = false;
    for (let i = 0; i < 75; i += 1) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; }
      } catch { /* 等待独立服务启动。 */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error(`浏览器测试服务启动失败：${logs}`);
  }
  const browserTest = spawn(process.execPath, ['tests/e2e-browser.mjs'], {
    cwd: root, env: { ...process.env, BASE_URL: base }, stdio: 'inherit',
  });
  const [code] = await once(browserTest, 'exit');
  process.exitCode = code ?? 1;
} finally {
  if (server?.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  const target = path.resolve(data);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('course-notes-browser-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
