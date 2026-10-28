import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  buildEndpoint,
  createConversation,
  createMonitorService,
  isPublicAddress,
  nextRunAt,
  probeMonitor,
  resolveTarget,
} from '../server/monitor.js';

const key = 'sk-private-healthcheck-secret-value';
const baseMonitor = {
  id: 'monitor-1',
  name: 'Test endpoint',
  endpoint: 'https://api.example.com/v1',
  model: 'custom-model-name',
  encryptedApiKey: key,
  enabled: true,
  scheduleType: 'interval',
  intervalMinutes: 30,
  dailyTimes: ['09:00', '21:00'],
  timezone: 'Asia/Shanghai',
  timeoutSeconds: 5,
  maxTokens: 64,
  nextRunAt: null,
};

function validResponse(content = 'Hello!', usage = 12) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: usage },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function memoryStore(monitors = [baseMonitor]) {
  const records = new Map(monitors.map((monitor) => [monitor.id, { ...monitor }]));
  const runs = [];
  return {
    runs,
    readMonitor: (id) => records.has(id) ? { ...records.get(id) } : undefined,
    listMonitors: () => [...records.values()].map((monitor) => ({ ...monitor })),
    updateMonitor(id, patch) {
      if (!records.has(id)) return undefined;
      records.set(id, { ...records.get(id), ...patch });
      return this.readMonitor(id);
    },
    insertRun(run) {
      const saved = { id: `run-${runs.length + 1}`, ...run };
      runs.push(saved);
      return saved;
    },
    getSettings: () => ({ logRetentionDays: 30 }),
    pruneRuns: () => {},
  };
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function localUpstream(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('endpoint builder accepts a base URL or complete chat endpoint without double appending', () => {
  assert.equal(buildEndpoint('https://example.com/v1/').href, 'https://example.com/v1/chat/completions');
  assert.equal(buildEndpoint('https://example.com/v1/chat/completions').href, 'https://example.com/v1/chat/completions');
  assert.equal(buildEndpoint('https://example.com').href, 'https://example.com/chat/completions');
  for (const url of ['file:///tmp/key', 'http://user:secret@example.com/v1', 'https://example.com?v=secret', 'invalid']) {
    assert.throws(() => buildEndpoint(url));
  }
});

test('SSRF policy rejects private, reserved, mapped and link-local IPv4 and IPv6', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('DNS validation checks all answers and private endpoint opt-in is explicit', async () => {
  const lookupImpl = async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(resolveTarget(new URL('https://example.com'), { lookupImpl }), { code: 'PRIVATE_ADDRESS' });
  assert.equal((await resolveTarget(new URL('https://example.com'), {
    lookupImpl, allowPrivateEndpoints: true,
  })).length, 2);
});

test('interval scheduling advances overdue anchors without a catch-up burst', () => {
  const monitor = { ...baseMonitor, intervalMinutes: 10 };
  assert.equal(nextRunAt(monitor, new Date('2026-10-28T00:05:00Z')), '2026-10-28T00:15:00.000Z');
  assert.equal(nextRunAt(monitor, new Date('2026-10-28T01:05:00Z'), '2026-10-28T00:00:00Z'), '2026-10-28T01:10:00.000Z');
  assert.equal(nextRunAt({ ...monitor, enabled: false }), null);
});

test('daily scheduling uses the task timezone and selects the earliest configured time', () => {
  const monitor = { ...baseMonitor, scheduleType: 'daily', dailyTimes: ['21:00', '08:30'] };
  assert.equal(nextRunAt(monitor, new Date('2026-10-28T00:00:00Z')), '2026-10-28T00:30:00.000Z');
  assert.equal(nextRunAt(monitor, new Date('2026-10-28T00:30:00Z')), '2026-10-28T13:00:00.000Z');
  assert.equal(nextRunAt(monitor, new Date('2026-10-28T14:00:00Z')), '2026-10-29T00:30:00.000Z');
});

test('daily timezone scheduling respects daylight-saving offsets rather than fixed UTC offsets', () => {
  const monitor = { ...baseMonitor, scheduleType: 'daily', dailyTimes: ['09:00'], timezone: 'America/New_York' };
  assert.equal(nextRunAt(monitor, new Date('2026-03-07T15:00:00Z')), '2026-03-08T13:00:00.000Z');
  assert.equal(nextRunAt(monitor, new Date('2026-10-31T15:00:00Z')), '2026-11-01T14:00:00.000Z');
});

test('random short conversations carry a unique anti-cache marker', () => {
  const first = createConversation();
  const second = createConversation();
  assert.notEqual(first.prompt, second.prompt);
  assert.ok(first.messages.length >= 2 && first.messages.length <= 4);
  assert.equal(first.messages.at(-1).role, 'user');
  assert.match(first.prompt, /\[probe:[0-9a-f]{8}\]/);
});

test('probe sends exact model, bearer key and bounded non-streaming chat request', async (t) => {
  let received;
  const endpoint = await localUpstream(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = { authorization: req.headers.authorization, url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `Echo ${key}` } }], usage: { total_tokens: 10 } }));
    });
  });
  const result = await probeMonitor({ ...baseMonitor, endpoint }, key, { allowPrivateEndpoints: true });
  assert.equal(result.status, 'success');
  assert.equal(result.tokensUsed, 10);
  assert.equal(result.responsePreview, 'Echo [REDACTED]');
  assert.equal(received.authorization, `Bearer ${key}`);
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.body.model, baseMonitor.model);
  assert.equal(received.body.max_tokens, 64);
  assert.equal(received.body.stream, false);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('connection uses the already validated DNS answer without resolving the hostname again', async (t) => {
  const endpoint = await localUpstream(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Pinned DNS works.' } }] }));
  });
  const url = new URL(endpoint);
  url.hostname = 'healthcheck.invalid';
  let lookups = 0;
  const result = await probeMonitor({ ...baseMonitor, endpoint: url.href }, key, {
    allowPrivateEndpoints: true,
    lookupImpl: async (hostname) => {
      assert.equal(hostname, 'healthcheck.invalid');
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  assert.equal(result.status, 'success');
  assert.equal(lookups, 1);
});

test('private targets are rejected before making any HTTP request by default', async () => {
  let fetched = false;
  const result = await probeMonitor({ ...baseMonitor, endpoint: 'http://127.0.0.1/v1' }, key, {
    fetchImpl: async () => { fetched = true; return validResponse(); },
  });
  assert.equal(result.status, 'failure');
  assert.match(result.error, /内网/);
  assert.equal(fetched, false);
});

test('HTTP errors and redirects never persist upstream response bodies or follow redirects', async () => {
  for (const status of [301, 401, 429, 500]) {
    let fetchOptions;
    const result = await probeMonitor(baseMonitor, key, {
      lookupImpl: publicLookup,
      fetchImpl: async (_url, options) => {
        fetchOptions = options;
        return new Response(`error secret: ${key}`, { status });
      },
    });
    assert.equal(result.status, 'failure');
    assert.equal(result.httpStatus, status);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.equal(fetchOptions.redirect, 'manual');
  }
});

test('a 200 response must contain valid JSON and nonempty chat content', async () => {
  for (const response of [
    new Response('<html>login required</html>'),
    new Response('{}'),
    validResponse('   '),
    validResponse(null),
  ]) {
    const result = await probeMonitor(baseMonitor, key, {
      lookupImpl: publicLookup,
      fetchImpl: async () => response,
    });
    assert.equal(result.status, 'failure');
    assert.equal(result.httpStatus, 200);
  }
});

test('structured text content is accepted and response previews are bounded', async () => {
  const result = await probeMonitor(baseMonitor, key, {
    lookupImpl: publicLookup,
    fetchImpl: async () => validResponse([{ type: 'text', text: 'A'.repeat(800) }]),
  });
  assert.equal(result.status, 'success');
  assert.equal(result.responsePreview.length, 500);
});

test('oversized bodies are rejected before parsing', async () => {
  const result = await probeMonitor(baseMonitor, key, {
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response('small', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
  });
  assert.equal(result.status, 'failure');
  assert.match(result.error, /1 MB/);
});

test('network failure text cannot leak bearer keys or raw exception details', async () => {
  const result = await probeMonitor(baseMonitor, key, {
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error(`TLS failed while using ${key}`); },
  });
  assert.equal(result.status, 'failure');
  assert.ok(!JSON.stringify(result).includes(key));
  assert.match(result.error, /TLS/);
});

test('timeout aborts a slow upstream and records a bounded failure', async (t) => {
  const endpoint = await localUpstream(t, () => {});
  const result = await probeMonitor({ ...baseMonitor, endpoint, timeoutSeconds: 0.04 }, key, { allowPrivateEndpoints: true });
  assert.equal(result.status, 'failure');
  assert.match(result.error, /超时/);
  assert.ok(result.latencyMs < 1000);
});

test('a task cannot overlap and completion is persisted with its snapshot', async (t) => {
  const store = memoryStore();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const engine = createMonitorService({
    store, decrypt: (value) => value, startScheduler: false, lookupImpl: publicLookup,
    fetchImpl: async () => { await pending; return validResponse(); },
  });
  t.after(() => engine.close());
  const first = engine.run(baseMonitor.id);
  assert.equal(engine.decorate(store.readMonitor(baseMonitor.id)).running, true);
  await assert.rejects(engine.run(baseMonitor.id), { status: 409 });
  release();
  const run = await first;
  assert.equal(run.monitorName, baseMonitor.name);
  assert.equal(run.trigger, 'manual');
  assert.equal(store.runs.length, 1);
  assert.equal(store.readMonitor(baseMonitor.id).lastStatus, 'success');
  assert.equal(engine.decorate(store.readMonitor(baseMonitor.id)).running, false);
});

test('global concurrency limit is bounded to four in-flight requests', async (t) => {
  const monitors = Array.from({ length: 5 }, (_, index) => ({ ...baseMonitor, id: `monitor-${index}` }));
  const store = memoryStore(monitors);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = createMonitorService({
    store, decrypt: (value) => value, startScheduler: false, lookupImpl: publicLookup,
    fetchImpl: async () => { await gate; return validResponse(); },
  });
  t.after(() => engine.close());
  const pending = monitors.slice(0, 4).map(({ id }) => engine.run(id));
  assert.equal(engine.runningCount, 4);
  await assert.rejects(engine.run(monitors[4].id), { status: 429 });
  release();
  await Promise.all(pending);
  assert.equal(engine.runningCount, 0);
});

test('restart keeps persisted due dates and schedules only one overdue invocation', async (t) => {
  const now = new Date('2026-10-28T01:05:00Z');
  const store = memoryStore([{ ...baseMonitor, intervalMinutes: 10, nextRunAt: '2026-10-28T00:00:00.000Z' }]);
  const engine = createMonitorService({
    store, decrypt: (value) => value, startScheduler: false, clock: () => now,
    lookupImpl: publicLookup, fetchImpl: async () => validResponse(),
  });
  t.after(() => engine.close());
  assert.equal(store.readMonitor(baseMonitor.id).nextRunAt, '2026-10-28T00:00:00.000Z');
  await engine.tick();
  await engine.tick();
  for (let i = 0; i < 20 && !store.runs.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].trigger, 'scheduled');
  assert.equal(store.readMonitor(baseMonitor.id).nextRunAt, '2026-10-28T01:10:00.000Z');
});

test('closing aborts in-flight requests before the database can be closed', async () => {
  const store = memoryStore();
  const engine = createMonitorService({
    store, decrypt: (value) => value, startScheduler: false, lookupImpl: publicLookup,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const pending = engine.run(baseMonitor.id);
  await new Promise((resolve) => setImmediate(resolve));
  const rejection = assert.rejects(pending, { status: 503 });
  await engine.close();
  await rejection;
  assert.equal(store.runs.length, 0);
  await assert.rejects(engine.run(baseMonitor.id), { status: 503 });
});
