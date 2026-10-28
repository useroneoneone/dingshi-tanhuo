import { randomInt, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Cron } from 'croner';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_RUNS = 4;
const TICK_MS = 5000;
const PROMPTS = [
  '用一句话描述一个晴朗的早晨。',
  '推荐一种适合工作间隙的简单放松方式。',
  '给一杯柠檬水起一个简短的名字。',
  '用一句话解释为什么天空是蓝色的。',
  '给我一句关于保持好奇心的简短寄语。',
  '说出一种绿色蔬菜和一种红色水果。',
  '用一句话描述春天的公园。',
  '给一个读书小组起一个简短的名字。',
  '请写一句简短、友好的问候语。',
  '用一句话解释什么是彩虹。',
  '推荐一个不需要器材的简单伸展动作。',
  '写一句关于今天的小小期待。',
  'Name one planet and describe it in one short sentence.',
  'Suggest a short name for a quiet library.',
  'Describe a peaceful garden in one sentence.',
  'What is one simple way to save water?',
  'Write a friendly greeting in a single sentence.',
  'Name two colors found in a rainbow.',
  'Give one short tip for keeping a desk tidy.',
  'Explain what a compass does in one sentence.',
];

class ProbeError extends Error {
  constructor(message, code = 'PROBE_ERROR') {
    super(message);
    this.code = code;
  }
}

function serviceError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function buildEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProbeError('API 地址无效。', 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProbeError('API 地址必须是不含账号、查询参数和片段的 HTTP(S) 地址。', 'INVALID_URL');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url;
}

export function isPublicAddress(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export async function resolveTarget(url, { allowPrivateEndpoints = false, lookupImpl = lookup, signal } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookupImpl(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ProbeError('无法解析 API 域名，请检查地址和服务器 DNS。', 'DNS_ERROR');
  }
  if (!addresses?.length || addresses.some(({ address }) => !isIP(address))) {
    throw new ProbeError('API 域名未解析到有效地址。', 'DNS_ERROR');
  }
  if (!allowPrivateEndpoints && addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ProbeError('已拦截内网、回环或保留地址；内网服务需由部署管理员显式允许。', 'PRIVATE_ADDRESS');
  }
  return addresses.map(({ address }) => ({ address, family: isIP(address) }));
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function pinnedAgent(addresses, timeoutMs) {
  // Pin the checked DNS answers for this request, including every IPv6 fallback.
  return new Agent({
    connect: {
      timeout: timeoutMs,
      autoSelectFamily: true,
      lookup(_hostname, options, callback) {
        const matching = options?.family
          ? addresses.filter((item) => item.family === options.family)
          : addresses;
        if (!matching.length) {
          callback(new Error('No validated address for requested family'));
        } else if (options?.all) {
          callback(null, matching);
        } else {
          callback(null, matching[0].address, matching[0].family);
        }
      },
    },
  });
}

export function redactText(text, apiKey) {
  let safe = String(text ?? '');
  if (apiKey) {
    for (const value of new Set([apiKey, encodeURIComponent(apiKey)])) {
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]');
}

export function createConversation() {
  const question = PROMPTS[randomInt(PROMPTS.length)];
  const marker = randomUUID().slice(0, 8);
  const prompt = `${question} [probe:${marker}]`;
  const messages = [
    {
      role: 'system',
      content: 'You are answering a connectivity check. Reply briefly in one sentence. Do not repeat the probe identifier.',
    },
  ];
  if (randomInt(2)) {
    messages.push({ role: 'user', content: '你好。' }, { role: 'assistant', content: '你好，很高兴见到你。' });
  }
  messages.push({ role: 'user', content: prompt });
  return { prompt, messages };
}

async function readBoundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProbeError('API 响应过大，超过 1 MB 检测限制。', 'BODY_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError('API 返回了空响应。', 'EMPTY_RESPONSE');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProbeError('API 响应过大，超过 1 MB 检测限制。', 'BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new ProbeError('API 未返回有效的 JSON 响应。', 'INVALID_JSON');
  }
}

function responseText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : part?.text?.value ?? ''))
    .filter((part) => typeof part === 'string')
    .join('\n')
    .trim();
}

export async function probeMonitor(monitor, apiKey, {
  signal,
  allowPrivateEndpoints = false,
  fetchImpl = undiciFetch,
  lookupImpl = lookup,
} = {}) {
  const { prompt, messages } = createConversation();
  const start = performance.now();
  const timeoutMs = Math.max(1, monitor.timeoutSeconds * 1000);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new Error('PROBE_TIMEOUT')), timeoutMs);
  timeout.unref?.();
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let dispatcher;
  let httpStatus = null;
  try {
    const endpoint = buildEndpoint(monitor.endpoint);
    const addresses = await resolveTarget(endpoint, { allowPrivateEndpoints, lookupImpl, signal: combinedSignal });
    if (combinedSignal.aborted) throw combinedSignal.reason;
    dispatcher = pinnedAgent(addresses, timeoutMs);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'DingshiTanhuo/1.0',
      },
      body: JSON.stringify({
        model: monitor.model,
        messages,
        max_tokens: monitor.maxTokens,
        stream: false,
      }),
      redirect: 'manual',
      signal: combinedSignal,
      dispatcher,
    });
    httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status >= 300 && response.status < 400
        ? 'API 返回重定向，请填写最终地址。'
        : `API 返回 HTTP ${response.status}，请检查端点、密钥和模型。`;
      throw new ProbeError(hint, 'HTTP_ERROR');
    }
    const data = await readBoundedJson(response);
    const text = responseText(data?.choices?.[0]?.message?.content);
    if (!text) throw new ProbeError('API 没有返回有效的聊天内容，请检查接口协议和模型。', 'EMPTY_CONTENT');
    const totalTokens = data?.usage?.total_tokens;
    return {
      status: 'success',
      httpStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - start)),
      prompt,
      responsePreview: redactText(text, apiKey).slice(0, 500),
      error: null,
      tokensUsed: Number.isSafeInteger(totalTokens) && totalTokens >= 0 && totalTokens < 1e9 ? totalTokens : null,
    };
  } catch (error) {
    const message = timeoutController.signal.aborted
      ? `请求超时（${monitor.timeoutSeconds} 秒）。`
      : signal?.aborted
        ? '检测已取消。'
        : error instanceof ProbeError
          ? error.message
          : '无法连接 API，请检查网络、TLS 证书和端点地址。';
    return {
      status: 'failure',
      httpStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - start)),
      prompt,
      responsePreview: null,
      error: redactText(message, apiKey).slice(0, 300),
      tokensUsed: null,
    };
  } finally {
    clearTimeout(timeout);
    if (dispatcher) await dispatcher.destroy().catch(() => {});
  }
}

export function nextRunAt(monitor, now = new Date(), anchor = null) {
  if (!monitor.enabled) return null;
  const reference = new Date(now);
  if (monitor.scheduleType === 'daily') {
    const dates = monitor.dailyTimes.map((time) => {
      const [hour, minute] = time.split(':').map(Number);
      const cron = new Cron(`${minute} ${hour} * * *`, { timezone: monitor.timezone, paused: true });
      const next = cron.nextRun(reference);
      cron.stop();
      return next?.getTime() ?? Infinity;
    });
    const earliest = Math.min(...dates);
    if (!Number.isFinite(earliest)) throw new Error('Unable to calculate daily schedule');
    return new Date(earliest).toISOString();
  }
  const period = monitor.intervalMinutes * 60_000;
  const base = anchor ? new Date(anchor).getTime() : reference.getTime();
  const steps = Math.max(1, Math.floor((reference.getTime() - base) / period) + 1);
  return new Date(base + steps * period).toISOString();
}

export function createMonitorService({
  store,
  decrypt,
  allowPrivateEndpoints = false,
  startScheduler = true,
  fetchImpl,
  lookupImpl,
  clock = () => new Date(),
}) {
  const inFlight = new Map();
  let stopped = false;
  let timer;
  let lastCleanup = 0;

  function refresh(id) {
    const monitors = id ? [store.readMonitor(id)].filter(Boolean) : store.listMonitors();
    for (const monitor of monitors) {
      store.updateMonitor(monitor.id, { nextRunAt: nextRunAt(monitor, clock()) });
    }
  }

  function decorate(monitor) {
    return { ...monitor, running: inFlight.has(monitor.id) };
  }

  async function run(id, trigger = 'manual') {
    if (stopped) throw serviceError(503, '服务正在关闭。');
    if (inFlight.has(id)) throw serviceError(409, '该任务正在检测中。');
    if (inFlight.size >= MAX_CONCURRENT_RUNS) throw serviceError(429, '同时检测的任务过多，请稍后重试。');
    const monitor = store.readMonitor(id);
    if (!monitor) throw serviceError(404, '检测任务不存在。');
    const startedAt = clock().toISOString();
    const state = { controller: new AbortController(), promise: null };
    inFlight.set(id, state);
    state.promise = (async () => {
      let result;
      try {
        const apiKey = decrypt(monitor.encryptedApiKey);
        result = await probeMonitor(monitor, apiKey, {
          signal: state.controller.signal,
          allowPrivateEndpoints,
          fetchImpl,
          lookupImpl,
        });
      } catch {
        result = {
          status: 'failure',
          httpStatus: null,
          latencyMs: 0,
          prompt: '',
          responsePreview: null,
          error: '无法读取已保存的密钥，请重新设置 API 密钥。',
          tokensUsed: null,
        };
      }
      if (stopped) throw serviceError(503, '服务正在关闭。');
      const saved = store.insertRun({
        ...result,
        monitorId: monitor.id,
        monitorName: monitor.name,
        model: monitor.model,
        trigger,
        createdAt: startedAt,
      });
      if (store.readMonitor(id)) {
        store.updateMonitor(id, {
          lastRunAt: startedAt,
          lastStatus: result.status,
          lastLatencyMs: result.latencyMs,
        });
      }
      return saved;
    })().finally(() => inFlight.delete(id));
    return state.promise;
  }

  async function tick() {
    if (stopped) return;
    const now = clock();
    if (now.getTime() - lastCleanup > 60 * 60_000) {
      const days = store.getSettings().logRetentionDays;
      store.pruneRuns(new Date(now.getTime() - days * 86_400_000).toISOString());
      lastCleanup = now.getTime();
    }
    const due = store.listMonitors()
      .filter((monitor) => monitor.enabled && monitor.nextRunAt && new Date(monitor.nextRunAt) <= now)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
    for (const monitor of due) {
      if (inFlight.has(monitor.id)) {
        store.updateMonitor(monitor.id, { nextRunAt: nextRunAt(monitor, now, monitor.nextRunAt) });
        continue;
      }
      if (inFlight.size >= MAX_CONCURRENT_RUNS) break;
      store.updateMonitor(monitor.id, { nextRunAt: nextRunAt(monitor, now, monitor.nextRunAt) });
      void run(monitor.id, 'scheduled').catch(() => {});
    }
  }

  for (const monitor of store.listMonitors()) {
    if (!monitor.enabled || !monitor.nextRunAt || !Number.isFinite(new Date(monitor.nextRunAt).getTime())) {
      store.updateMonitor(monitor.id, { nextRunAt: nextRunAt(monitor, clock()) });
    }
  }
  if (startScheduler) {
    timer = setInterval(() => void tick().catch(() => {}), TICK_MS);
    timer.unref?.();
    void tick().catch(() => {});
  }

  return {
    refresh,
    decorate,
    run,
    tick,
    get runningCount() { return inFlight.size; },
    async close() {
      stopped = true;
      clearInterval(timer);
      for (const state of inFlight.values()) state.controller.abort(new Error('SHUTDOWN'));
      await Promise.allSettled([...inFlight.values()].map((state) => state.promise));
    },
  };
}
