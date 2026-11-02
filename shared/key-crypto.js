import { Buffer } from 'node:buffer';
const encoder = new TextEncoder();
export async function getMasterKey(env) {
  if (!env.BYOK_SECRET) throw Object.assign(new Error('服务端未配置 BYOK_SECRET，无法保存密钥'), { code: 'BYOK_SECRET_MISSING', status: 503 });
  if (!/^[a-f0-9]{64}$/i.test(env.BYOK_SECRET)) throw Object.assign(new Error('服务端 BYOK_SECRET 格式无效'), { code: 'BYOK_SECRET_INVALID', status: 503 });
  return crypto.subtle.importKey('raw', Buffer.from(env.BYOK_SECRET, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptKey(plaintext, env) {
  const key = await getMasterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return { cipherB64: Buffer.from(cipher).toString('base64'), ivB64: Buffer.from(iv).toString('base64') };
}
export async function decryptKey(cipherB64, ivB64, env) {
  try {
    const key = await getMasterKey(env);
    const iv = Buffer.from(ivB64, 'base64');
    if (iv.length !== 12) throw new Error('无效 IV');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, Buffer.from(cipherB64, 'base64')));
  } catch {
    throw Object.assign(new Error('用户密钥解密失败，请重新配置'), { code: 'BYOK_DECRYPT_FAILED' });
  }
}
export function maskKey(plaintext) {
  return typeof plaintext === 'string' && plaintext.length >= 4 ? '••••' + plaintext.slice(-4) : null;
}
