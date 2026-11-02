/** 只读导出本地账号和笔记，用户执行后再按部署文档导入 D1。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';
const directory = path.resolve(process.argv[2] || 'cloudflare/private');
await fs.mkdir(directory, { recursive: true });
const database = new DatabaseSync(config.dbPath, { readOnly: true });
const quote = (value) => value === null || value === undefined ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const statements = ['-- 包含私人笔记和账号哈希，请勿上传 GitHub。只导入已经初始化的空 D1 数据库。'];
try {
  for (const table of ['users', 'courses', 'notes']) {
    const records = database.prepare(`SELECT * FROM ${table}`).all();
    for (const record of records) {
      if (table === 'notes' && record.status === 'processing') {
        record.status = 'failed';
        record.error_message = record.raw_text ? '本地未完成任务已迁移，请点击重试' : '本地未完成任务未上传原文件，请重新上传';
      }
      const columns = Object.keys(record);
      const statement = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((key) => quote(record[key])).join(',')});`;
      if (Buffer.byteLength(statement) > 90000) {
        // D1 单条 SQL 文本有大小限制，大字段使用分段 UPDATE 恢复。
        const large = columns.filter((key) => typeof record[key] === 'string' && Buffer.byteLength(record[key]) > 10000);
        const reduced = { ...record };
        for (const key of large) reduced[key] = '';
        statements.push(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((key) => quote(reduced[key])).join(',')});`);
        for (const key of large) {
          for (let offset = 0; offset < record[key].length; offset += 5000) statements.push(`UPDATE ${table} SET ${key}=${key}||${quote(record[key].slice(offset, offset + 5000))} WHERE id=${quote(record.id)};`);
        }
      } else statements.push(statement);
    }
  }
  const output = path.join(directory, 'import.sql');
  await fs.writeFile(output, statements.join('\n') + '\n', { mode: 0o600 });
  console.log(`已生成迁移文件：${output}。未修改本地数据；请勿重复导入。`);
} finally { database.close(); }
