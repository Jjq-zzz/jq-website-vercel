import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
