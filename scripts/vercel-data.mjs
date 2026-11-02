/** 通过已配置的远程数据库导入旧数据或设置账号密码。 */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createDatabase } from '../vercel/database.js';
import { passwordHash } from '../cloudflare/auth.js';
dotenv.config({ path: '.env.local' }); dotenv.config();
const database = createDatabase();
let terminal;
try {
  if (process.argv[2] === 'import') {
    const count = await database.prepare('SELECT COUNT(*) count FROM users').first();
    if (count.count > 0) throw new Error('目标数据库已有账号，禁止重复导入。请使用初始化后的空数据库。');
    const file = path.resolve(process.argv[3] || 'vercel/private/import.sql');
    await database.client.executeMultiple(await fs.readFile(file, 'utf8'));
    console.log('旧账号和笔记已导入；原登录密码可继续使用，未完成任务需重试或重新上传。');
  } else if (process.argv[2] === 'password') {
    const nickname = process.argv[3];
    if (!nickname) throw new Error('用法：npm run vercel:password -- "昵称"');
    const user = await database.prepare('SELECT id FROM users WHERE nickname_key=?').bind(nickname.normalize('NFKC').toLowerCase()).first();
    if (!user) throw new Error('该昵称不存在');
    terminal = readline.createInterface({ input: process.stdin, output: new Writable({ write(chunk, encoding, done) { done(); } }), terminal: true });
    process.stdout.write('请输入新密码（输入不显示）：');
    const password = await terminal.question('');
    process.stdout.write('\n再次输入：');
    const confirmed = await terminal.question(''); process.stdout.write('\n');
    if (password.length < 8 || password.length > 128 || password !== confirmed) throw new Error('密码长度需为 8–128 字符且两次一致');
    await database.batch([
      database.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await passwordHash(password), user.id),
      database.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
    ]);
    console.log('云端密码已更新，旧会话已撤销。');
  } else throw new Error('请选择 import 或 password 操作');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal?.close(); database.client.close(); }
