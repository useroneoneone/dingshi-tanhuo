import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  constantEqual, createSecretCipher, hashPassword, loadEncryptionKey, parseCookies, verifyPassword,
} from '../server/security.js';

test('passwords use salted hashes and constant-time verification', async () => {
  const first = await hashPassword('long-test-password');
  const second = await hashPassword('long-test-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('long-test-password', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyPassword('anything', 'invalid'), false);
});

test('API secrets are encrypted, authenticated and recover across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tanhuo-key-'));
  try {
    const key = loadEncryptionKey(directory);
    const cipher = createSecretCipher(key);
    const encrypted = cipher.encrypt('sk-secret-value');
    assert.ok(!encrypted.includes('sk-secret'));
    assert.notEqual(cipher.encrypt('sk-secret-value'), encrypted);
    assert.equal(createSecretCipher(loadEncryptionKey(directory)).decrypt(encrypted), 'sk-secret-value');
    assert.throws(() => createSecretCipher(randomBytes(32)).decrypt(encrypted));
    assert.equal(readFileSync(join(directory, 'master.key')).length, 32);
    assert.throws(() => loadEncryptionKey(directory, 'bad'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cookie parsing and safe comparison reject malformed values', () => {
  assert.deepEqual(parseCookies('x=1; broken=%XX; hello=some%20value'), { x: '1', hello: 'some value' });
  assert.equal(constantEqual('abc', 'abc'), true);
  assert.equal(constantEqual('abc', 'abcd'), false);
  assert.equal(constantEqual(undefined, 'abc'), false);
});
