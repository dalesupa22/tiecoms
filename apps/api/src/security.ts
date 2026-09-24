import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.ts';
import { unauthorized } from './errors.ts';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scryptAsync(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize('NFKC'), salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Con usuario inexistente igual calculamos un hash para no filtrar por tiempo.
  const parts = (stored ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA==').split('$');
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  const key = await scryptAsync(pw.normalize('NFKC'), salt);
  return stored !== null && expected.length === key.length && timingSafeEqual(expected, key);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

const secret = new TextEncoder().encode(config.jwtSecret);

export interface AccessClaims { sub: string; sid: string }

export async function signAccess(userId: string, sessionId: string) {
  const exp = Math.floor(Date.now() / 1000) + config.accessTtlSeconds;
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .setIssuer('tiecoms')
    .sign(secret);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: 'tiecoms', algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('claims');
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    throw unauthorized();
  }
}

const PALETTE: Array<[string, string]> = [
  ['#dcd0f2', '#3b2a5a'], ['#e8d5a8', '#4a3a14'], ['#c5d8ee', '#1f3a54'],
  ['#ecc3d2', '#4d2338'], ['#f0c6b4', '#5a2e1e'], ['#c9dcc9', '#263b29'],
];

export function orgLook(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = PALETTE[h % PALETTE.length]!;
  const words = name.trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w) && w.length > 2);
  const mark = (words.length >= 2 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 1)).toUpperCase();
  return { mark, bg, fg };
}
