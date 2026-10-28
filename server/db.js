import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const monitorColumns = {
  name: 'name',
  endpoint: 'endpoint',
  model: 'model',
  encryptedApiKey: 'api_key',
  enabled: 'enabled',
  scheduleType: 'schedule_type',
  intervalMinutes: 'interval_minutes',
  dailyTimes: 'daily_times',
  timezone: 'timezone',
  timeoutSeconds: 'timeout_seconds',
  maxTokens: 'max_tokens',
  updatedAt: 'updated_at',
  nextRunAt: 'next_run_at',
  lastRunAt: 'last_run_at',
  lastStatus: 'last_status',
  lastLatencyMs: 'last_latency_ms',
};

export function monitorFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    model: row.model,
    encryptedApiKey: row.api_key,
    enabled: Boolean(row.enabled),
    scheduleType: row.schedule_type,
    intervalMinutes: row.interval_minutes,
    dailyTimes: JSON.parse(row.daily_times),
    timezone: row.timezone,
    timeoutSeconds: row.timeout_seconds,
    maxTokens: row.max_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
  };
}

export function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    model: row.model,
    trigger: row.trigger,
    status: row.status,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    prompt: row.prompt,
    responsePreview: row.response_preview,
    error: row.error,
    createdAt: row.created_at,
    tokensUsed: row.tokens_used,
  };
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sql = new DatabaseSync(join(dataDir, 'monitor.db'));
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings(key,value) VALUES ('timezone','"Asia/Shanghai"');
    INSERT OR IGNORE INTO settings(key,value) VALUES ('logRetentionDays','30');
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_type TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      daily_times TEXT NOT NULL,
      timezone TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_latency_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      monitor_name TEXT NOT NULL,
      model TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      latency_ms INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      response_preview TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      tokens_used INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS runs_monitor_created ON runs(monitor_id,created_at DESC);
  `);

  return {
    sql,
    readMonitor(id) {
      return monitorFromRow(sql.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
    },
    listMonitors() {
      return sql.prepare('SELECT * FROM monitors ORDER BY created_at DESC, rowid DESC').all().map(monitorFromRow);
    },
    createMonitor(values) {
      const id = randomUUID();
      const now = new Date().toISOString();
      sql.prepare(`
        INSERT INTO monitors(id,name,endpoint,model,api_key,enabled,schedule_type,interval_minutes,
          daily_times,timezone,timeout_seconds,max_tokens,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, values.name, values.endpoint, values.model, values.encryptedApiKey,
        Number(values.enabled), values.scheduleType, values.intervalMinutes, JSON.stringify(values.dailyTimes),
        values.timezone, values.timeoutSeconds, values.maxTokens, now, now,
      );
      return this.readMonitor(id);
    },
    updateMonitor(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => monitorColumns[key]);
      if (entries.length) {
        const values = entries.map(([key, value]) => key === 'dailyTimes'
          ? JSON.stringify(value)
          : key === 'enabled' ? Number(value) : value);
        sql.prepare(`UPDATE monitors SET ${entries.map(([key]) => `${monitorColumns[key]} = ?`).join(', ')} WHERE id = ?`)
          .run(...values, id);
      }
      return this.readMonitor(id);
    },
    deleteMonitor(id) {
      sql.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    },
    insertRun(run) {
      const id = run.id ?? randomUUID();
      sql.prepare(`
        INSERT INTO runs(id,monitor_id,monitor_name,model,trigger,status,http_status,latency_ms,prompt,
          response_preview,error,created_at,tokens_used)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, run.monitorId, run.monitorName, run.model, run.trigger, run.status, run.httpStatus ?? null,
        Math.round(run.latencyMs), run.prompt, run.responsePreview ?? null, run.error ?? null,
        run.createdAt ?? new Date().toISOString(), run.tokensUsed ?? null,
      );
      return runFromRow(sql.prepare('SELECT * FROM runs WHERE id = ?').get(id));
    },
    listRuns({ monitorId, status, page = 1, pageSize = 20 } = {}) {
      const conditions = [];
      const parameters = [];
      if (monitorId) {
        conditions.push('monitor_id = ?');
        parameters.push(monitorId);
      }
      if (status) {
        conditions.push('status = ?');
        parameters.push(status);
      }
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const total = sql.prepare(`SELECT COUNT(*) AS total FROM runs${where}`).get(...parameters).total;
      const runs = sql.prepare(`SELECT * FROM runs${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (page - 1) * pageSize).map(runFromRow);
      return { runs, total, page, pageSize };
    },
    getSettings() {
      return Object.fromEntries(sql.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, JSON.parse(row.value)]));
    },
    updateSettings(values) {
      const statement = sql.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      sql.exec('BEGIN');
      try {
        for (const [key, value] of Object.entries(values)) statement.run(key, JSON.stringify(value));
        sql.exec('COMMIT');
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
      return this.getSettings();
    },
    pruneRuns(beforeIso) {
      return sql.prepare('DELETE FROM runs WHERE created_at < ?').run(beforeIso);
    },
    overview(runningCount = 0) {
      const now = new Date();
      const until = now.toISOString();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const aggregate = sql.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failed,
          AVG(latency_ms) AS latency
        FROM runs WHERE created_at >= ? AND created_at <= ?
      `).get(since, until);
      const monitors = sql.prepare('SELECT COUNT(*) AS total,SUM(enabled) AS enabled FROM monitors').get();
      const activity = Array.from({ length: 24 }, (_, index) => ({
        hour: new Date(Date.parse(since) + index * 60 * 60 * 1000).toISOString(),
        total: 0, success: 0, failed: 0, avgLatencyMs: null,
      }));
      const buckets = sql.prepare(`
        SELECT MIN(23,CAST((unixepoch(created_at,'subsec')-unixepoch(?,'subsec'))/3600 AS INTEGER)) AS bucket,
          COUNT(*) AS total,
          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failed,
          AVG(latency_ms) AS latency FROM runs WHERE created_at >= ? AND created_at <= ? GROUP BY bucket
      `).all(since, since, until);
      for (const bucket of buckets) {
        const item = activity[bucket.bucket];
        if (item) Object.assign(item, {
          total: bucket.total, success: bucket.success, failed: bucket.failed,
          avgLatencyMs: Math.round(bucket.latency),
        });
      }
      return {
        totalMonitors: monitors.total,
        enabledMonitors: monitors.enabled ?? 0,
        successRate24h: aggregate.total ? Math.round(aggregate.success / aggregate.total * 10000) / 100 : null,
        averageLatency24h: aggregate.total ? Math.round(aggregate.latency) : null,
        totalRuns24h: aggregate.total,
        failedRuns24h: aggregate.failed ?? 0,
        runningCount,
        recentRuns: this.listRuns({ pageSize: 8 }).runs,
        activity,
      };
    },
    close() {
      sql.close();
    },
  };
}
