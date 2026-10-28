import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './db.js';
import {
  constantEqual, createSecretCipher, hashPassword, loadEncryptionKey, parseCookies,
  randomToken, tokenHash, verifyPassword,
} from './security.js';
import { createMonitorService } from './monitor.js';

const SESSION_COOKIE = 'tanhuo_session';
const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, '无效的时区');
const endpointSchema = z.string().trim().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, '端点必须是无查询参数和内嵌凭证的 HTTP(S) URL');
const monitorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  endpoint: endpointSchema,
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(8192).refine((value) => !/[\r\n\0]/.test(value), '密钥不能包含换行').optional(),
  enabled: z.boolean().default(true),
  scheduleType: z.enum(['interval', 'daily']).default('interval'),
  intervalMinutes: z.number().int().min(1).max(10080).default(30),
  dailyTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24)
    .refine((values) => new Set(values).size === values.length, '时间点不能重复').default(['09:00']),
  timezone: timezoneSchema.default('Asia/Shanghai'),
  timeoutSeconds: z.number().int().min(5).max(120).default(30),
  maxTokens: z.number().int().min(16).max(512).default(64),
}).strict();
const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
}).strict();
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
}).strict();
const settingsSchema = z.object({
  timezone: timezoneSchema,
  logRetentionDays: z.number().int().min(1).max(365),
}).strict();
const querySchema = z.object({
  monitorId: z.string().max(100).optional(),
  status: z.enum(['success', 'failure']).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '请求'}: ${issue.message}`).join('；');
    throw problem(400, details);
  }
  return result.data;
}

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? 'data');
  const allowPrivateEndpoints = options.allowPrivateEndpoints ?? process.env.ALLOW_PRIVATE_ENDPOINTS === 'true';
  const secureCookie = options.secureCookie ?? process.env.SECURE_COOKIE === 'true';
  const store = createStore(dataDir);
  const sql = store.sql;
  let cipher;
  try {
    cipher = createSecretCipher(loadEncryptionKey(dataDir, options.encryptionKey ?? process.env.ENCRYPTION_KEY));
    for (const monitor of store.listMonitors()) {
      try {
        cipher.decrypt(monitor.encryptedApiKey);
      } catch {
        throw new Error('The encryption key cannot decrypt saved API keys. Restore the original master.key or ENCRYPTION_KEY.');
      }
    }
    if (!sql.prepare('SELECT id FROM users LIMIT 1').get()) {
      const username = options.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin';
      const suppliedPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
      if (!username || username.length > 128) throw new Error('ADMIN_USERNAME must contain 1 to 128 characters.');
      if (suppliedPassword && (suppliedPassword.length < 12 || suppliedPassword.length > 128)) {
        throw new Error('ADMIN_PASSWORD must contain 12 to 128 characters.');
      }
      const password = suppliedPassword || randomBytes(24).toString('base64url');
      sql.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(1,?,?,?)')
        .run(username, await hashPassword(password), new Date().toISOString());
      if (!suppliedPassword) {
        console.log(`Initial administrator: ${username}\nInitial password: ${password}\nChange this password after signing in. It is shown only once.`);
      }
    }
  } catch (error) {
    store.close();
    throw error;
  }
  const monitorService = createMonitorService({
    store, decrypt: cipher.decrypt, allowPrivateEndpoints,
    startScheduler: options.startScheduler ?? true,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy ?? process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: secureCookie ? [] : null,
      },
    },
    strictTransportSecurity: secureCookie,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  function assertSameOrigin(req, _res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return next(problem(403, '请求来源不受信任'));
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return next(problem(403, '请求来源不受信任'));
    return next();
  }
  app.use('/api', assertSameOrigin);
  function getSession(req) {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return sql.prepare(`
      SELECT sessions.*,users.username FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE token_hash = ? AND expires_at > ?
    `).get(tokenHash(token), new Date().toISOString()) ?? null;
  }
  function sessionResponse(session) {
    return { authenticated: true, user: { username: session.username }, csrfToken: session.csrf_token };
  }
  function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/', maxAge: SESSION_LIFETIME,
    });
  }
  function requireAuth(req, _res, next) {
    req.session = getSession(req);
    if (!req.session) return next(problem(401, '请先登录'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && !constantEqual(req.get('x-csrf-token'), req.session.csrf_token)) {
      return next(problem(403, '安全令牌已失效，请刷新页面后重试'));
    }
    return next();
  }
  function publicMonitor(monitor) {
    const { encryptedApiKey, ...fields } = monitorService.decorate(monitor);
    return { ...fields, keyConfigured: Boolean(encryptedApiKey) };
  }
  function readMonitor(id) {
    const monitor = store.readMonitor(id);
    if (!monitor) throw problem(404, '检测任务不存在');
    return monitor;
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/auth/session', (req, res) => {
    const session = getSession(req);
    res.json(session ? sessionResponse(session) : { authenticated: false });
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: options.loginRateLimit ?? 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => res.status(429).json({ error: '尝试次数过多，请 15 分钟后重试' }),
  });
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = parse(loginSchema, req.body);
    const user = sql.prepare('SELECT * FROM users WHERE id=1').get();
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword || !constantEqual(username, user.username)) throw problem(401, '用户名或密码错误');
    sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    const token = randomToken();
    const csrfToken = randomToken();
    sql.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,1,?,?,?)')
      .run(tokenHash(token), csrfToken, new Date(Date.now() + SESSION_LIFETIME).toISOString(), new Date().toISOString());
    setSessionCookie(res, token);
    res.json({ authenticated: true, user: { username: user.username }, csrfToken });
  });
  app.post('/api/auth/logout', requireAuth, (req, res) => {
    sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/' });
    res.status(204).end();
  });
  app.post('/api/auth/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = parse(passwordSchema, req.body);
    const user = sql.prepare('SELECT * FROM users WHERE id=1').get();
    if (!await verifyPassword(currentPassword, user.password_hash)) throw problem(400, '当前密码不正确');
    if (currentPassword === newPassword) throw problem(400, '新密码不能与当前密码相同');
    const passwordHash = await hashPassword(newPassword);
    sql.exec('BEGIN');
    try {
      sql.prepare('UPDATE users SET password_hash=? WHERE id=1').run(passwordHash);
      sql.prepare('DELETE FROM sessions WHERE token_hash != ?').run(req.session.token_hash);
      sql.exec('COMMIT');
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
    res.status(204).end();
  });
  app.use('/api', requireAuth);
  app.get('/api/settings', (_req, res) => res.json({ ...store.getSettings(), allowPrivateEndpoints }));
  app.put('/api/settings', (req, res) => {
    const settings = store.updateSettings(parse(settingsSchema, req.body));
    store.pruneRuns(new Date(Date.now() - settings.logRetentionDays * 86400000).toISOString());
    res.json({ ...settings, allowPrivateEndpoints });
  });
  app.get('/api/overview', (_req, res) => {
    const runningCount = store.listMonitors().filter((monitor) => monitorService.decorate(monitor).running).length;
    res.json(store.overview(runningCount));
  });
  app.get('/api/monitors', (_req, res) => res.json({ monitors: store.listMonitors().map(publicMonitor) }));
  app.post('/api/monitors', async (req, res) => {
    const values = parse(monitorSchema, req.body);
    if (!values.apiKey?.trim()) throw problem(400, '新建任务必须配置 API 密钥');
    if (store.listMonitors().length >= 100) throw problem(400, '最多可创建 100 个检测任务');
    const { apiKey, ...fields } = values;
    const monitor = store.createMonitor({ ...fields, encryptedApiKey: cipher.encrypt(apiKey.trim()) });
    await monitorService.refresh(monitor.id);
    res.status(201).json(publicMonitor(store.readMonitor(monitor.id)));
  });
  app.put('/api/monitors/:id', async (req, res) => {
    const existing = readMonitor(req.params.id);
    if (monitorService.decorate(existing).running) throw problem(409, '任务正在检测中，请完成后再编辑');
    const { apiKey, ...fields } = parse(monitorSchema, req.body);
    store.updateMonitor(existing.id, {
      ...fields,
      ...(apiKey?.trim() ? { encryptedApiKey: cipher.encrypt(apiKey.trim()) } : {}),
      updatedAt: new Date().toISOString(),
    });
    await monitorService.refresh(existing.id);
    res.json(publicMonitor(store.readMonitor(existing.id)));
  });
  app.delete('/api/monitors/:id', async (req, res) => {
    const monitor = readMonitor(req.params.id);
    if (monitorService.decorate(monitor).running) throw problem(409, '任务正在检测中，请完成后再删除');
    store.deleteMonitor(monitor.id);
    await monitorService.refresh(monitor.id);
    res.status(204).end();
  });
  app.post('/api/monitors/:id/run', async (req, res) => {
    readMonitor(req.params.id);
    res.json(await monitorService.run(req.params.id, 'manual'));
  });
  app.get('/api/runs', (req, res) => res.json(store.listRuns(parse(querySchema, req.query))));
  app.delete('/api/runs', (_req, res) => {
    sql.prepare('DELETE FROM runs').run();
    res.status(204).end();
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

  const distDir = resolve(options.distDir ?? fileURLToPath(new URL('../dist', import.meta.url)));
  if (existsSync(resolve(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(distDir, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = status === 500 ? '服务暂时不可用，请稍后重试'
      : status === 413 ? '请求内容过大'
        : error.type === 'entity.parse.failed' ? '请求 JSON 格式无效' : error.message;
    if (status === 500) console.error('Request failed:', error.code ?? error.name ?? 'UnknownError');
    res.status(status).json({ error: message });
  });
  let closed = false;
  return {
    app, db: sql, store, monitorService,
    async close() {
      if (closed) return;
      closed = true;
      await monitorService.close();
      store.close();
    },
  };
}
