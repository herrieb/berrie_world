import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a), bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------- secret box

/**
 * Authenticated encryption (AES-256-GCM) for secrets at rest: SSH keys, passwords, TOTP seeds.
 * The key comes from BERRIE_MASTER_KEY (32 bytes, hex or base64) or, failing that, a 0600 key file
 * next to the database. Ciphertext format: v1.<iv>.<tag>.<data> (base64url).
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly source: 'env' | 'file';

  constructor(env: string | undefined, dataDir: string) {
    if (env) {
      const k = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
      if (k.length !== 32) throw new Error('BERRIE_MASTER_KEY must be 32 bytes (64 hex chars or base64)');
      this.key = k;
      this.source = 'env';
      return;
    }
    const path = resolve(dataDir, 'master.key');
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const k = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error(`${path} is not a valid master key`);
    this.key = k;
    this.source = 'file';
  }

  seal(plain: string, aad = ''): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) c.setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  open(sealed: string, aad = ''): string {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('unsupported secret format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so unknown users are not distinguishable by timing.
    await scrypt('x', randomBytes(16), 32, SCRYPT);
    return false;
  }
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const out = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), 32, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return safeEqual(out, Buffer.from(hash, 'base64url'));
}

export function passwordProblem(password: string, username: string): string | null {
  if (typeof password !== 'string' || password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password is too long';
  if (password.toLowerCase().includes(username.toLowerCase())) return 'password must not contain the username';
  if (/^(.)\1+$/.test(password)) return 'password is too simple';
  return null;
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Returns the matched time step (±1 step drift), or null. Callers must reject steps <= the last used one. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpCode(secret, s), code)) return s;
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Berrie World'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
