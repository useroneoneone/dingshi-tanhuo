import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const result = await scrypt(password, salt, 64, passwordOptions);
  return `scrypt$${salt}$${result.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(expectedHex ?? '')) return false;
  const actual = await scrypt(password, salt, 64, passwordOptions);
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

export function loadEncryptionKey(dataDir, suppliedKey) {
  if (suppliedKey) {
    const key = Buffer.from(suppliedKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== suppliedKey) {
      throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    }
    return key;
  }
  const keyPath = join(dataDir, 'master.key');
  if (!existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('The persisted encryption key is invalid.');
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  return key;
}

export function createSecretCipher(key) {
  return {
    encrypt(secret) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(encoded) {
      const [version, iv, tag, ciphertext] = encoded.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted secret.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values rather than failing the request.
    }
  }
  return cookies;
}

export function constantEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
