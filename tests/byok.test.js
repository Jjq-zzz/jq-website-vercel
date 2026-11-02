import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../vercel/database.js';
import { handleRequest } from '../vercel/handler.js';
import { consumeNote } from '../vercel/consumer.js';
import { NoteProcessor } from '../serverless/processor.js';
import { encryptKey, decryptKey, maskKey, getMasterKey } from '../vercel/key-crypto.js';

const secret = { BYOK_SECRET: 'ab'.repeat(32) };
test('加密往返、随机 IV、掩码与错误处理', async () => {
  const plain = 'sk-仅用于测试-abcd';
  const a = await encryptKey(plain, secret), b = await encryptKey(plain, secret);
  assert.notEqual(a.ivB64, b.ivB64);
  assert.equal(await decryptKey(a.cipherB64, a.ivB64, secret), plain);
  assert.equal(maskKey(plain), '••••abcd');
  assert.equal(maskKey('abc'), null);
  await assert.rejects(getMasterKey({}), { code: 'BYOK_SECRET_MISSING' });
  await assert.rejects(getMasterKey({ BYOK_SECRET: '无效' }), { code: 'BYOK_SECRET_INVALID' });
  await assert.rejects(decryptKey(a.cipherB64, b.ivB64, secret));
  await assert.rejects(decryptKey(a.cipherB64, a.ivB64, { BYOK_SECRET: 'cd'.repeat(32) }));
  await assert.rejects(decryptKey('损坏', a.ivB64, secret));
});

test('存量库幂等迁移、设置接口鉴权、用户隔离与清除', async () => {
  const DB = createDatabase('file::memory:');
  try {
    await DB.client.execute('CREATE TABLE users (id TEXT PRIMARY KEY,nickname TEXT,nickname_key TEXT UNIQUE,created_at TEXT,password_hash TEXT)');
    await DB.migrate(); await DB.migrate();
    const env = { DB, ...secret, DEPLOYMENT: 'vercel', QUEUE: { idFromName: x => x, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } };
    async function call(path, method = 'GET', body, token) {
      const response = await handleRequest(new Request('https://test/api' + path, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    }
    for (const method of ['GET', 'PUT']) assert.equal((await call('/settings/ai-key', method, method === 'PUT' ? {} : undefined)).status, 401);
    const register = async nickname => (await call('/auth/login', 'POST', { nickname, password: '测试密码123456', register: true })).data.user;
    const a = await register('甲同学'), b = await register('乙同学');
    assert.equal((await call('/settings/ai-key', 'GET', undefined, a.token)).data.configured, false);
    const plain = 'sk-测试专用-abcd';
    const saved = await call('/settings/ai-key', 'PUT', { apiKey: plain, model: '测试模型', baseUrl: 'https://example.com/v1' }, a.token);
    assert.equal(saved.status, 200); assert.equal(saved.data.masked, '••••abcd');
    assert.ok(!JSON.stringify(saved.data).includes(plain));
    assert.equal((await call('/settings/ai-key', 'GET', undefined, a.token)).data.configured, true);
    assert.equal((await call('/auth/me', 'GET', undefined, a.token)).data.user.aiKeyConfigured, true);
    assert.equal((await call('/settings/ai-key', 'GET', undefined, b.token)).data.configured, false);
    const stored = (await DB.client.execute({ sql: 'SELECT * FROM users WHERE id=?', args: [a.id] })).rows[0];
    assert.notEqual(stored.ai_key_cipher, plain);
    for (const body of [{ apiKey: '短' }, { apiKey: 123 }, { baseUrl: 'ftp://example.com' }, { model: 'a'.repeat(65) }]) assert.equal((await call('/settings/ai-key', 'PUT', body, a.token)).status, 400);
    delete env.BYOK_SECRET;
    assert.equal((await call('/settings/ai-key', 'PUT', { apiKey: plain }, a.token)).status, 503);
    const cleared = await call('/settings/ai-key', 'PUT', { apiKey: '', baseUrl: null, model: null }, a.token);
    assert.equal(cleared.data.configured, false);
    assert.equal((await DB.client.execute({ sql: 'SELECT ai_key_cipher FROM users WHERE id=?', args: [a.id] })).rows[0].ai_key_cipher, null);
  } finally { DB.client.close(); }
});

test('队列按归属注入密钥、全局兜底及损坏密钥回退本地模式', async () => {
  const DB = createDatabase('file::memory:');
  const original = NoteProcessor.prototype.step;
  try {
    await DB.migrate();
    const cipher = await encryptKey('sk-甲用户测试-key1', secret);
    await DB.client.executeMultiple("INSERT INTO users(id,nickname,nickname_key,created_at) VALUES ('a','甲','a','今天'),('b','乙','b','今天'); INSERT INTO courses VALUES ('ca','a','课程甲','今天','今天'),('cb','b','课程乙','今天','今天'); INSERT INTO notes(id,course_id,title,source_filename,raw_text,created_at,updated_at) VALUES ('na','ca','标题','a.txt','课程内容知识定义。','今天','今天'),('nb','cb','标题','b.txt','课程内容知识定义。','今天','今天'); INSERT INTO upload_queue(id,note_id,file_path,created_at,updated_at) VALUES ('qa','na','','今天','今天'),('qb','nb','','今天','今天');");
    await DB.client.execute({ sql: 'UPDATE users SET ai_key_cipher=?,ai_key_iv=? WHERE id=?', args: [cipher.cipherB64, cipher.ivB64, 'a'] });
    const env = { DB, ...secret, publish: async message => assert.deepEqual(Object.keys(message), ['noteId']) };
    const seen = [];
    NoteProcessor.prototype.step = async function () { seen.push(this.env.AI_API_KEY); };
    await consumeNote(env, { noteId: 'na' }); await consumeNote(env, { noteId: 'nb' });
    assert.deepEqual(seen, ['sk-甲用户测试-key1', undefined]);
    env.AI_API_KEY = 'sk-全局测试-key2'; await consumeNote(env, { noteId: 'nb' }); assert.equal(seen.at(-1), env.AI_API_KEY);
    delete env.AI_API_KEY;
    await DB.client.execute("UPDATE users SET ai_key_cipher='损坏' WHERE id='b'");
    NoteProcessor.prototype.step = original;
    await consumeNote(env, { noteId: 'nb' });
    assert.equal((await DB.client.execute("SELECT engine FROM notes WHERE id='nb'")).rows[0].engine, 'local-fallback');
  } finally { NoteProcessor.prototype.step = original; DB.client.close(); }
});
