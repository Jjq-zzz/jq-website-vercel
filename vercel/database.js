import { createClient } from '@libsql/client';
import fs from 'node:fs/promises';

// 本地版数据库后续同步，本期只迁移 Vercel。
async function ensureUserColumns(client) {
  for (const column of ['ai_key_cipher', 'ai_key_iv', 'ai_base_url', 'ai_model']) {
    try { await client.execute('ALTER TABLE users ADD COLUMN ' + column + ' TEXT'); }
    catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
  }
}

/** 用相同的异步 SQL 契约连接 Turso，禁止线上写入本地 SQLite 文件。 */
export function createDatabase(url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN) {
  if (!url) throw new Error('未配置 TURSO_DATABASE_URL，请连接 Turso 数据库');
  if (process.env.VERCEL && url.startsWith('file:')) throw new Error('线上必须使用持久化云数据库');
  const client = createClient({ url, authToken });
  const execute = async (statement) => client.execute({ sql: statement.sql, args: statement.args || [] });
  const result = (value) => ({ meta: { changes: value.rowsAffected }, results: value.rows.map((row) => ({ ...row })) });
  return {
    client,
    prepare(sql) {
      const make = (args = []) => ({ sql, args, bind: (...values) => make(values),
        async first() { return (await execute({ sql, args })).rows[0] || null; },
        async all() { return result(await execute({ sql, args })); },
        async run() { return result(await execute({ sql, args })); },
      });
      return make();
    },
    async batch(statements) { return (await client.batch(statements.map((s) => ({ sql: s.sql, args: s.args })), 'write')).map(result); },
    async migrate() {
      const schema = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      // 新库先建用户表，存量库保持原表，再补列；完整 schema 随后执行。
      await client.execute(schema.match(/CREATE TABLE IF NOT EXISTS users[\s\S]*?;/)[0]);
      await ensureUserColumns(client);
      await client.executeMultiple(schema);
    },
  };
}
