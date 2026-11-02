import { first, run, stmt, now, id, keyOf, fail, json, coordinator } from './common.js';
const encoder = new TextEncoder();
const hex = (value) => Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
export const digest = async (token) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
export async function passwordHash(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2:100000:${salt}:${hex(hash)}`;
}
export async function passwordValid(password, hash) {
  const candidate = await passwordHash(password, hash.split(':')[2]);
  let mismatch = candidate.length ^ hash.length;
  for (let i = 0; i < candidate.length; i++) mismatch |= candidate.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  return mismatch === 0;
}
export async function requireUser(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'UNAUTHORIZED', '请先登录');
  const user = await first(env, `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`, await digest(token), now());
  if (!user) fail(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
  return user;
}
export async function authRoute(request, env, parserFetch) {
  const route = new URL(request.url).pathname;
  if (route === '/api/auth/login' && request.method === 'POST') {
    if (Number(request.headers.get('content-length')) > 4096) fail(413, 'TOO_LARGE', '请求过大');
    const rate = await coordinator(env).fetch('https://queue/login-limit', { method: 'POST', body: request.headers.get('cf-connecting-ip') || 'local' });
    if (!rate.ok) fail(429, 'LOGIN_LIMIT', '尝试过于频繁，请 15 分钟后再试');
    const body = await request.json();
    const nickname = String(body.nickname || '').trim();
    const { password } = body;
    if (!nickname || [...nickname].length > 20) fail(400, 'INVALID_NICKNAME', '昵称需为 1–20 个字符');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail(400, 'INVALID_PASSWORD', '密码需为 8–128 个字符');
    let user = await first(env, 'SELECT * FROM users WHERE nickname_key=?', keyOf(nickname));
    if (body.register === true) {
      if (user) fail(409, 'NICKNAME_TAKEN', '昵称已被使用，请换一个昵称或登录');
      const userId = id();
      const result = await run(env, 'INSERT OR IGNORE INTO users (id,nickname,nickname_key,created_at,password_hash) VALUES (?,?,?,?,?)', userId, nickname, keyOf(nickname), now(), await passwordHash(password));
      if (!result.meta.changes) fail(409, 'NICKNAME_TAKEN', '昵称已被使用');
      user = await first(env, 'SELECT * FROM users WHERE id=?', userId);
    } else {
      if (user && !user.password_hash) fail(403, 'PASSWORD_SETUP_REQUIRED', '旧版账号请由管理员设置密码');
      let valid = false;
      if (user?.password_hash?.startsWith('pbkdf2:')) valid = await passwordValid(password, user.password_hash);
      else if (user) {
        const response = await parserFetch('/verify-legacy', { method: 'POST', body: JSON.stringify({ password, hash: user.password_hash }) });
        valid = response.ok && (await response.json()).valid;
        if (valid) await run(env, 'UPDATE users SET password_hash=? WHERE id=?', await passwordHash(password), user.id);
      } else await passwordHash(password);
      if (!valid) fail(401, 'INVALID_CREDENTIALS', '昵称或密码错误');
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      stmt(env, 'DELETE FROM sessions WHERE expires_at<=?', now()),
      stmt(env, 'INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', await digest(token), user.id, new Date(Date.now() + 30 * 86400000).toISOString()),
    ]);
    return json({ user: { id: user.id, nickname: user.nickname, createdAt: user.created_at, aiKeyConfigured: Boolean(user.ai_key_cipher), token } });
  }
  const user = await requireUser(request, env);
  if (route === '/api/auth/me' && request.method === 'GET') return json({ user: { id: user.id, nickname: user.nickname, createdAt: user.created_at, aiKeyConfigured: Boolean(user.ai_key_cipher) } });
  if (route === '/api/auth/logout' && request.method === 'POST') {
    await run(env, 'DELETE FROM sessions WHERE token_hash=?', await digest(request.headers.get('authorization').slice(7)));
    return new Response(null, { status: 204 });
  }
  fail(404, 'NOT_FOUND', '接口不存在');
}
