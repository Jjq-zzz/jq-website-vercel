/** 管理员在本机输入密码，仅将加盐哈希写入 D1。 */
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { passwordHash } from '../cloudflare/auth.js';
// auth.js 只包含可移植逻辑，无 Cloudflare 运行时模块依赖。
const nickname = process.argv[2];
if (!nickname) { console.error('用法：npm run cf:password -- "昵称"'); process.exit(1); }
const output = new Writable({ write(chunk, encoding, done) { done(); } });
const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
let directory;
try {
  process.stdout.write('请输入新密码（8–128 字符，输入不显示）：');
  const password = await terminal.question('');
  process.stdout.write('\n请再次输入：');
  const confirmation = await terminal.question('');
  process.stdout.write('\n');
  if (password.length < 8 || password.length > 128 || password !== confirmation) throw new Error('密码长度不符或两次输入不一致');
  const hash = await passwordHash(password);
  const escape = (text) => `'${text.replaceAll("'", "''")}'`;
  directory = await fs.mkdtemp(path.resolve('.tmp-build/cf-password-'));
  const file = path.join(directory, 'password.sql');
  const key = escape(nickname.normalize('NFKC').toLowerCase());
  await fs.writeFile(file, `UPDATE users SET password_hash=${escape(hash)} WHERE nickname_key=${key};\nDELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE nickname_key=${key});\nSELECT nickname FROM users WHERE nickname_key=${key};`, { mode: 0o600 });
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'course-notes', '--remote', '--file', file], { stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code) throw new Error('云端密码设置失败，请检查账号和 D1 配置');
  console.log('请检查上方昵称查询结果：有该昵称时密码已更新；无结果表示账号不存在。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
