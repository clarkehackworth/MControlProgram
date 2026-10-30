import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let key: Buffer | undefined;

function loadKey(): Buffer {
  if (key) return key;
  if (config.masterKey) {
    const k = Buffer.from(config.masterKey, config.masterKey.length === 64 ? 'hex' : 'base64');
    if (k.length !== 32) throw new Error('MCONTROLPROGRAM_MASTER_KEY must be 32 bytes (hex or base64)');
    return (key = k);
  }
  const file = path.join(config.dataDir, 'master.key');
  if (fs.existsSync(file)) return (key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'));
  fs.mkdirSync(config.dataDir, { recursive: true });
  const k = randomBytes(32);
  fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600 });
  return (key = k);
}

/** AES-256-GCM. Output: base64(iv|tag|ciphertext) prefixed with "enc:v1:". */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function isEncrypted(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('enc:v1:');
}

export function decrypt(blob: string): string {
  if (!isEncrypted(blob)) return blob;
  const buf = Buffer.from(blob.slice(7), 'base64');
  const d = createDecipheriv('aes-256-gcm', loadKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** scrypt password hash: "scrypt:salt:hash" */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** For API/bearer tokens: store only sha256 so a DB leak doesn't leak tokens. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
