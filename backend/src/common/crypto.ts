import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { env } from './env';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hmac = (data: string, secret = env().jwtSecret) => createHmac('sha256', secret).update(data).digest('base64url');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Chiffrement AES-256-GCM des secrets (clés API, mot de passe SMTP, secret TOTP). */
export function encrypt(plain: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', env().encryptionKey, iv);
  const ciphertext = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}
export function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', env().encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}
export const encryptToString = (plain: string) => { const e = encrypt(plain); return [e.iv, e.tag, e.ciphertext].map(b => b.toString('base64url')).join('.'); };
export const decryptFromString = (s: string) => { const [iv, tag, ct] = s.split('.').map(p => Buffer.from(p, 'base64url')); return decrypt(ct, iv, tag); };

// ── TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s) ──────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const totpSecret = () => base32Encode(randomBytes(20));
export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export function totpVerify(secret: string, code: string, atMs = Date.now()): boolean {
  const c = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some(w => safeEqual(totpCode(secret, atMs + w * 30000), c));
}
export const totpUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(len: number): string {
  const b = randomBytes(len); let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
