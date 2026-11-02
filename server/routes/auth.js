import express from 'express';
import { randomBytes } from 'node:crypto';
import { getDb, nowIso, randomId, lowKey } from '../db.js';
import { HttpError, normalizeTitle } from '../utils.js';
import { hashPassword, verifyPassword, tokenHash } from '../password.js';

export const authRouter = express.Router();
export const publicUser = (row) => ({ id: row.id, nickname: row.nickname, createdAt: row.created_at });
const attempts = new Map();
const cleanup = setInterval(() => {
  for (const [key, item] of attempts) if (item.until < Date.now()) attempts.delete(key);
}, 60000);
cleanup.unref();

export function requireUser(req, res, next) {
  const token = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return next(new HttpError(401, 'UNAUTHORIZED', '请先登录'));
  const user = getDb().prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), nowIso());
  if (!user) return next(new HttpError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录'));
  req.user = user;
  req.sessionHash = tokenHash(token);
  next();
}

authRouter.post('/login', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const nickname = normalizeTitle(req.body?.nickname, 20);
    const password = req.body?.password;
    const register = req.body?.register === true;
    if (!nickname || [...nickname].length > 20) throw new HttpError(400, 'INVALID_NICKNAME', '昵称需为 1–20 个字符');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new HttpError(400, 'INVALID_PASSWORD', '密码需为 8–128 个字符');
    }
    const attemptKey = req.ip;
    let limit = attempts.get(attemptKey);
    if (!limit || limit.until < Date.now()) {
      limit = { count: 0, until: Date.now() + 15 * 60000 };
      attempts.set(attemptKey, limit);
    }
    if (++limit.count > 30) throw new HttpError(429, 'LOGIN_LIMIT', '尝试过于频繁，请 15 分钟后再试');
    const db = getDb();
    const key = lowKey(nickname);
    let user = db.prepare('SELECT * FROM users WHERE nickname_key = ?').get(key);
    if (register) {
      if (user) throw new HttpError(409, 'NICKNAME_TAKEN', '这个昵称已被使用，请换一个昵称或登录');
      const hash = await hashPassword(password);
      // 哈希计算期间昵称可能已被其他请求占用，插入使用唯一约束保护。
      const inserted = db.prepare('INSERT OR IGNORE INTO users (id, nickname, nickname_key, created_at, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(randomId(), nickname, key, nowIso(), hash);
      if (!inserted.changes) throw new HttpError(409, 'NICKNAME_TAKEN', '这个昵称已被使用，请换一个昵称或登录');
      user = db.prepare('SELECT * FROM users WHERE nickname_key = ?').get(key);
    } else {
      if (user && !user.password_hash) throw new HttpError(403, 'PASSWORD_SETUP_REQUIRED', '此为旧版账号，请联系站点管理员设置密码后登录');
      // 未存在的账号也执行哈希计算，避免快速返回泄露账号状态。
      const valid = user ? await verifyPassword(password, user.password_hash) : (await hashPassword(password), false);
      if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS', '昵称或密码错误');
    }
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), user.id, new Date(Date.now() + 30 * 86400000).toISOString());
    res.json({ user: { ...publicUser(user), token } });
  } catch (err) { next(err); }
});
authRouter.get('/me', requireUser, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ user: publicUser(req.user) });
});
authRouter.post('/logout', requireUser, (req, res) => {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  res.sendStatus(204);
});
