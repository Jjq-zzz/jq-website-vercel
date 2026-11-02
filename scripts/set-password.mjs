/** 仅供服务器管理员在本机设置旧账号密码，不通过公开接口认领账号。 */
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { initDb, closeDb, lowKey } from '../server/db.js';
import { hashPassword } from '../server/password.js';

const nickname = process.argv[2];
if (!nickname) { console.error('用法：npm run set-password -- "昵称"'); process.exit(1); }
const db = initDb();
const user = db.prepare('SELECT id FROM users WHERE nickname_key = ?').get(lowKey(nickname));
if (!user) { console.error('该昵称不存在'); closeDb(); process.exit(1); }
let hidden = false;
const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
try {
  process.stdout.write('请输入新密码（8–128 个字符，输入不显示）：');
  hidden = true;
  const password = await terminal.question('');
  process.stdout.write('\n请再次输入密码：');
  const confirmation = await terminal.question('');
  process.stdout.write('\n');
  if (password.length < 8 || password.length > 128) throw new Error('密码需为 8–128 个字符');
  if (password !== confirmation) throw new Error('两次输入的密码不一致');
  const hash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.exec('COMMIT');
  console.log('密码已设置，旧登录会话已失效，课程和笔记保留。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal.close(); closeDb(); }
