import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const password = 'test-admin-password-2026';
const secret = 'sk-test-never-return-this-key-123456';
const monitorBody = {
  name: '测试检测',
  endpoint: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: secret,
  enabled: true,
  scheduleType: 'interval',
  intervalMinutes: 30,
  dailyTimes: ['09:00', '18:00'],
  timezone: 'Asia/Shanghai',
  timeoutSeconds: 10,
  maxTokens: 64,
};

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tanhuo-app-'));
  const application = await createApp({
    dataDir: directory, adminUsername: 'admin', adminPassword: password,
    startScheduler: false, ...options,
  });
  const server = createServer(application.app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  async function request(path, { method = 'GET', body, authenticated = true, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(authenticated && cookie ? { cookie, 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: text ? JSON.parse(text) : null };
  }
  async function login(credentials = { username: 'admin', password }) {
    const response = await request('/api/auth/login', { method: 'POST', body: credentials, authenticated: false });
    if (response.status === 200) {
      cookie = response.headers.get('set-cookie').split(';')[0];
      csrf = response.data.csrfToken;
    }
    return response;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...application, directory, request, login, base, get cookie() { return cookie; }, get csrf() { return csrf; } };
}

test('API authentication, opaque sessions, CSRF and same-origin checks', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/health')).status, 200);
  assert.deepEqual((await app.request('/api/auth/session')).data, { authenticated: false });
  assert.equal((await app.request('/api/monitors')).status, 401);
  assert.equal((await app.login({ username: 'admin', password: 'wrong' })).status, 401);
  const login = await app.login();
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(!login.text.includes(password));
  assert.equal((await app.request('/api/auth/session')).data.user.username, 'admin');
  assert.equal((await app.request('/api/monitors', { method: 'POST', body: monitorBody, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await app.request('/api/monitors', {
    method: 'POST', body: monitorBody, headers: { origin: 'https://evil.example' },
  })).status, 403);
  assert.equal((await app.request('/api/auth/login', {
    method: 'POST', authenticated: false, body: { username: 'admin', password }, headers: { 'sec-fetch-site': 'cross-site' },
  })).status, 403);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await app.request('/api/monitors')).status, 401);
});

test('failed logins are rate limited without restricting health checks', async (t) => {
  const app = await fixture(t, { loginRateLimit: 2 });
  assert.equal((await app.login({ username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await app.login({ username: 'unknown', password: 'wrong' })).status, 401);
  const blocked = await app.login();
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.has('ratelimit'));
  assert.equal((await app.request('/api/health', { authenticated: false })).status, 200);
});

test('fresh bootstrap generates a strong password only once and never resets it on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tanhuo-bootstrap-'));
  const output = [];
  const originalLog = console.log;
  const previousPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  let first;
  let second;
  try {
    console.log = (value) => output.push(String(value));
    first = await createApp({ dataDir: directory, adminUsername: 'admin', startScheduler: false });
    assert.equal(output.length, 1);
    const generated = /Initial password: ([A-Za-z0-9_-]+)/.exec(output[0])?.[1];
    assert.ok(generated && generated.length >= 32);
    const hash = first.db.prepare('SELECT password_hash FROM users').get().password_hash;
    assert.ok(!hash.includes(generated));
    await first.close();
    second = await createApp({ dataDir: directory, adminPassword: 'new-password-not-applied', startScheduler: false });
    assert.equal(output.length, 1);
    assert.equal(second.db.prepare('SELECT password_hash FROM users').get().password_hash, hash);
  } finally {
    console.log = originalLog;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
    await first?.close();
    await second?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('API secrets are write-only, encrypted at rest and retained on edit', async (t) => {
  const app = await fixture(t);
  await app.login();
  const created = await app.request('/api/monitors', { method: 'POST', body: monitorBody });
  assert.equal(created.status, 201);
  assert.equal(created.data.keyConfigured, true);
  assert.ok(!created.text.includes(secret));
  assert.ok(!Object.hasOwn(created.data, 'encryptedApiKey'));
  assert.ok(!Object.hasOwn(created.data, 'apiKey'));
  assert.ok(created.data.nextRunAt);
  const id = created.data.id;
  const encrypted = app.store.readMonitor(id).encryptedApiKey;
  assert.ok(!encrypted.includes(secret));
  const edited = await app.request(`/api/monitors/${id}`, {
    method: 'PUT', body: { ...monitorBody, name: '重命名', apiKey: '' },
  });
  assert.equal(edited.status, 200);
  assert.equal(app.store.readMonitor(id).encryptedApiKey, encrypted);
  assert.ok(!(await app.request('/api/monitors')).text.includes(secret));
  assert.equal(readFileSync(join(app.directory, 'monitor.db')).includes(Buffer.from(secret)), false);
  assert.equal((await app.request(`/api/monitors/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await app.request('/api/monitors')).data.monitors.length, 0);
});

test('restart preserves encrypted API keys, schedules and existing administrator credentials', async (t) => {
  const app = await fixture(t);
  await app.login();
  const created = (await app.request('/api/monitors', { method: 'POST', body: monitorBody })).data;
  const encrypted = app.store.readMonitor(created.id).encryptedApiKey;
  await app.close();
  const restarted = await createApp({
    dataDir: app.directory, adminUsername: 'ignored-new-admin', adminPassword: 'ignored-new-password',
    startScheduler: false,
  });
  try {
    const persisted = restarted.store.readMonitor(created.id);
    assert.equal(persisted.encryptedApiKey, encrypted);
    assert.equal(persisted.nextRunAt, created.nextRunAt);
    assert.equal(restarted.db.prepare('SELECT username FROM users').get().username, 'admin');
  } finally {
    await restarted.close();
  }
  await assert.rejects(() => createApp({
    dataDir: app.directory, encryptionKey: Buffer.alloc(32, 1).toString('base64'), startScheduler: false,
  }), /cannot decrypt saved API keys/);
});

test('validation rejects unsafe endpoint formats and invalid scheduling input', async (t) => {
  const app = await fixture(t);
  await app.login();
  for (const patch of [
    { endpoint: 'file:///etc/passwd' },
    { endpoint: 'https://user:password@example.com/v1' },
    { endpoint: 'https://example.com/v1?api_key=unsafe' },
    { endpoint: 'https://example.com/v1#secret' },
    { apiKey: '' },
    { apiKey: 'one\r\ntwo' },
    { intervalMinutes: 0 },
    { dailyTimes: ['24:00'] },
    { dailyTimes: ['09:00', '09:00'] },
    { timezone: 'Not/A_Timezone' },
    { timeoutSeconds: 999 },
    { maxTokens: 100000 },
  ]) {
    const response = await app.request('/api/monitors', { method: 'POST', body: { ...monitorBody, ...patch } });
    assert.equal(response.status, 400, JSON.stringify(patch));
  }
  const malformed = await app.request('/api/monitors', { method: 'POST', body: '{"apiKey":"sk-secret' });
  assert.equal(malformed.status, 400);
  assert.ok(!malformed.text.includes('sk-secret'));
  assert.equal((await app.request('/api/runs?page=-1')).status, 400);
  assert.equal((await app.request('/api/runs?status=unknown')).status, 400);
});

test('settings and aggregated run history are persisted and filterable', async (t) => {
  const app = await fixture(t);
  await app.login();
  assert.deepEqual((await app.request('/api/settings')).data, {
    timezone: 'Asia/Shanghai', logRetentionDays: 30, allowPrivateEndpoints: false,
  });
  assert.equal((await app.request('/api/settings', {
    method: 'PUT', body: { timezone: 'Europe/London', logRetentionDays: 14 },
  })).status, 200);
  assert.equal(app.store.getSettings().timezone, 'Europe/London');
  const monitor = (await app.request('/api/monitors', { method: 'POST', body: monitorBody })).data;
  for (const status of ['success', 'failure']) {
    app.store.insertRun({
      monitorId: monitor.id, monitorName: monitor.name, model: monitor.model,
      trigger: 'manual', status, httpStatus: status === 'success' ? 200 : 503,
      latencyMs: status === 'success' ? 100 : 300, prompt: '你好', responsePreview: '你好',
    });
  }
  const runs = await app.request(`/api/runs?monitorId=${monitor.id}&status=failure&pageSize=1`);
  assert.equal(runs.data.total, 1);
  assert.equal(runs.data.runs[0].status, 'failure');
  const overview = (await app.request('/api/overview')).data;
  assert.equal(overview.totalRuns24h, 2);
  assert.equal(overview.failedRuns24h, 1);
  assert.equal(overview.successRate24h, 50);
  assert.equal(overview.averageLatency24h, 200);
  assert.equal(overview.activity.length, 24);
  assert.equal(overview.activity.reduce((sum, row) => sum + row.total, 0), 2);
  await app.request(`/api/monitors/${monitor.id}`, { method: 'DELETE' });
  assert.equal((await app.request('/api/runs')).data.total, 2);
  assert.equal((await app.request('/api/runs', { method: 'DELETE' })).status, 204);
  assert.equal((await app.request('/api/runs')).data.total, 0);
});

test('activity includes the oldest partial hour in the same rolling 24-hour window as totals', async (t) => {
  const app = await fixture(t);
  app.store.insertRun({
    monitorId: 'rolling-window-test', monitorName: 'Rolling window', model: 'test-model',
    trigger: 'manual', status: 'success', httpStatus: 200, latencyMs: 100,
    prompt: 'Hello', responsePreview: 'Hello',
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000 + 1000).toISOString(),
  });
  const overview = app.store.overview();
  assert.equal(overview.totalRuns24h, 1);
  assert.equal(overview.activity.length, 24);
  assert.equal(overview.activity[0].total, 1);
  assert.equal(overview.activity.reduce((sum, row) => sum + row.total, 0), overview.totalRuns24h);
});

test('password changes validate current password and revoke other login sessions', async (t) => {
  const app = await fixture(t);
  await app.login();
  const oldCookie = app.cookie;
  await app.login();
  assert.equal((await app.request('/api/auth/password', {
    method: 'POST', body: { currentPassword: 'not-current', newPassword: 'brand-new-password' },
  })).status, 400);
  assert.equal((await app.request('/api/auth/password', {
    method: 'POST', body: { currentPassword: password, newPassword: 'brand-new-password' },
  })).status, 204);
  assert.equal((await app.request('/api/auth/session', { headers: { cookie: oldCookie } })).data.authenticated, false);
  assert.equal((await app.request('/api/auth/session')).data.authenticated, true);
  assert.equal((await app.login()).status, 401);
  assert.equal((await app.login({ username: 'admin', password: 'brand-new-password' })).status, 200);
});

test('private upstream requests need explicit opt-in and manual runs record valid completion', async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '连接正常' } }], usage: { total_tokens: 12 } }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const app = await fixture(t, { allowPrivateEndpoints: true });
  await app.login();
  const created = await app.request('/api/monitors', {
    method: 'POST',
    body: { ...monitorBody, endpoint: `http://127.0.0.1:${upstream.address().port}/v1` },
  });
  const run = await app.request(`/api/monitors/${created.data.id}/run`, { method: 'POST' });
  assert.equal(run.status, 200);
  assert.equal(run.data.status, 'success');
  assert.equal(run.data.tokensUsed, 12);
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.authorization, `Bearer ${secret}`);
  assert.equal(received.body.model, monitorBody.model);
  assert.ok(Array.isArray(received.body.messages));
  assert.ok(!run.text.includes(secret));
});
