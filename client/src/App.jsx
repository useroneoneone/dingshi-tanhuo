import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, CalendarClock,
  Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Circle, Clock3, Ellipsis, ExternalLink, Eye, EyeOff, FileClock, Globe2,
  KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu,
  Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal,
  Terminal, Trash2, TriangleAlert, Unplug, X, Zap, Pencil, Copy,
} from "lucide-react";

const NAV = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "monitors", label: "检测任务", icon: Activity },
  { id: "runs", label: "运行记录", icon: FileClock },
  { id: "settings", label: "系统设置", icon: Settings2 },
];
const TIMEZONES = ["Asia/Shanghai", "UTC", "Asia/Tokyo", "America/New_York", "Europe/London"];
const DEFAULT_SETTINGS = { timezone: "Asia/Shanghai", logRetentionDays: 30, allowPrivateEndpoints: false };

async function fetchApi(path, options = {}, csrfToken) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...options.headers,
    },
  });
  let data = null;
  if (response.status !== 204) {
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) data = await response.json();
  }
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : "请求失败，请稍后重试。";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function dateText(value, timezone = "Asia/Shanghai", options = {}) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone, month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, ...options,
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function latencyText(value) {
  if (value === null || value === undefined) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function scheduleText(monitor) {
  return monitor.scheduleType === "daily"
    ? `每天 ${(monitor.dailyTimes || []).join("、")}`
    : `每 ${monitor.intervalMinutes} 分钟`;
}

function IconButton({ icon: Icon, label, className = "", ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={17} strokeWidth={1.8} /></button>;
}

function Spinner({ size = 18 }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

function Status({ status, running = false, enabled = true }) {
  if (running) return <span className="status is-running"><Spinner size={12} />检测中</span>;
  if (!enabled) return <span className="status is-paused"><Circle size={7} fill="currentColor" />已暂停</span>;
  if (status === "success") return <span className="status is-success"><Circle size={7} fill="currentColor" />通畅</span>;
  if (status === "failure") return <span className="status is-failure"><Circle size={7} fill="currentColor" />异常</span>;
  return <span className="status is-pending"><Circle size={7} fill="currentColor" />待检测</span>;
}

function Toggle({ checked, onChange, label, disabled = false }) {
  return <button type="button" className={`toggle ${checked ? "is-on" : ""}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function EmptyState({ icon: Icon = Activity, title, children, action }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={26} strokeWidth={1.35} /></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

function Modal({ title, children, onClose, wide = false, className = "", testId }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusables = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length);
    focusables()[0]?.focus();
    function keydown(event) {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  const titleId = React.useId();
  return <div className={`modal-backdrop ${className}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      {children}
    </section>
  </div>;
}

function Login({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await fetchApi("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      setPassword("");
      onLogin(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return <main className="login-page">
    <div className="login-top"><span className="brand-mark"><Activity size={24} strokeWidth={2} /></span><span>定时探活</span><span className="login-edition">API MONITOR</span></div>
    <div className="login-content">
      <div className="login-symbol"><LockKeyhole size={24} strokeWidth={1.6} /></div>
      <div className="login-heading"><p className="eyebrow">WORKSPACE ACCESS</p><h1>登录控制台</h1><p>欢迎回来。</p></div>
      <form onSubmit={submit} className="login-form">
        <label className="field">用户名<input autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={128} placeholder="请输入用户名" /></label>
        <label className="field">密码<span className="password-field"><input type={visible ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} placeholder="请输入密码" /><IconButton icon={visible ? EyeOff : Eye} label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)} /></span></label>
        {error && <div className="form-error" role="alert"><TriangleAlert size={16} />{error}</div>}
        <button className="button button-primary login-submit" disabled={busy} type="submit">{busy ? <Spinner /> : <ArrowRight size={17} />}<span>{busy ? "正在登录" : "登录"}</span></button>
      </form>
      <div className="login-security"><ShieldCheck size={14} /><span>私有工作空间 · 管理员访问</span></div>
    </div>
    <footer className="login-footer"><span>定时探活</span><span>保持连接，始终在线。</span></footer>
  </main>;
}

function ActivityChart({ activity = [], timezone, total }) {
  const max = Math.max(1, ...activity.map((item) => item.total || 0));
  const buckets = activity.length ? activity.slice(-24) : Array.from({ length: 24 }, (_, index) => ({ hour: Date.now() - (23 - index) * 3600000, total: 0, success: 0, failed: 0 }));
  return <div className="activity-chart">
    <div className="chart-context"><div><span className="chart-big">{total || 0}</span><span className="text-muted"> 次检测</span></div><div className="chart-legend"><span><i className="legend-dot green" />成功</span><span><i className="legend-dot red" />失败</span></div></div>
    <div className="chart-canvas">
      <svg viewBox="0 0 960 180" preserveAspectRatio="none" role="img" aria-label={`过去24小时共${total || 0}次检测`}>
        {[24, 72, 120, 168].map((y) => <line key={y} x1="0" x2="960" y1={y} y2={y} stroke="#e9eeeb" strokeDasharray={y === 168 ? "0" : "3 5"} />)}
        {buckets.map((item, index) => {
          const height = item.total ? Math.max(5, (item.total / max) * 140) : 0;
          const failureHeight = item.total ? height * (item.failed || 0) / item.total : 0;
          const successHeight = Math.max(0, height - failureHeight);
          const x = index * 40 + 8;
          return <g key={item.hour || index}><title>{dateText(item.hour, timezone)} · 成功 {item.success || 0} · 失败 {item.failed || 0}</title>
            <rect x={x} y={168 - height} width="24" height={successHeight} rx="2" fill="#29a775" />
            <rect x={x} y={168 - failureHeight} width="24" height={failureHeight} rx="2" fill="#e16c6c" />
          </g>;
        })}
      </svg>
      {!total && <div className="chart-empty"><Activity size={18} /><span>等待第一次检测</span></div>}
    </div>
    <div className="chart-axis">{[0, 6, 12, 18, 23].map((index) => <span key={index}>{dateText(buckets[index]?.hour, timezone, { hour: "2-digit", minute: "2-digit", month: undefined, day: undefined })}</span>)}</div>
  </div>;
}

function MonitorTable({ monitors, busyIds, timezone, onEdit, onRun, onDelete, onToggle, compact = false }) {
  return <div className="table-scroll"><table className={`data-table monitor-table ${compact ? "is-compact" : ""}`}><thead><tr><th>检测任务</th><th>状态</th><th>调度</th><th>最近响应</th>{!compact && <th>下次检测</th>}<th className="align-right">操作</th></tr></thead><tbody>
    {monitors.map((monitor) => <tr key={monitor.id} data-testid={`monitor-row-${monitor.id}`}>
      <td><div className="task-cell"><span className={`endpoint-icon ${monitor.lastStatus === "failure" ? "endpoint-failure" : ""}`}><Globe2 size={18} strokeWidth={1.6} /></span><div className="task-copy"><button className="plain-link task-name" onClick={() => onEdit(monitor)}>{monitor.name}</button><span className="task-meta" title={`${monitor.endpoint} · ${monitor.model}`}>{monitor.model}<span className="meta-divider">·</span>{(() => { try { return new URL(monitor.endpoint).host; } catch { return monitor.endpoint; } })()}</span></div></div></td>
      <td><Status status={monitor.lastStatus} enabled={monitor.enabled} running={monitor.running || busyIds.has(monitor.id)} /></td>
      <td><span className="schedule-main">{monitor.scheduleType === "daily" ? <CalendarClock size={13} /> : <Clock3 size={13} />}{monitor.scheduleType === "daily" ? `每天 ${monitor.dailyTimes?.length || 0} 次` : `每 ${monitor.intervalMinutes} 分钟`}</span><span className="cell-secondary">{monitor.scheduleType === "daily" ? monitor.dailyTimes?.join(" / ") : monitor.timezone}</span></td>
      <td><span className="latency-value">{latencyText(monitor.lastLatencyMs)}</span><span className="cell-secondary">{dateText(monitor.lastRunAt, timezone)}</span></td>
      {!compact && <td><span className="next-run">{monitor.enabled ? dateText(monitor.nextRunAt, monitor.timezone) : "—"}</span><span className="cell-secondary">{monitor.enabled ? monitor.timezone : "调度已暂停"}</span></td>}
      <td><div className="row-actions">{!compact && <Toggle checked={monitor.enabled} label={`${monitor.enabled ? "暂停" : "启用"} ${monitor.name}`} onChange={(enabled) => onToggle(monitor, enabled)} disabled={busyIds.has(monitor.id)} />}<IconButton icon={monitor.running || busyIds.has(monitor.id) ? LoaderCircle : Play} className={monitor.running || busyIds.has(monitor.id) ? "is-spinning" : ""} label={`立即检测 ${monitor.name}`} data-testid={`monitor-run-${monitor.id}`} disabled={monitor.running || busyIds.has(monitor.id)} onClick={() => onRun(monitor)} /><IconButton icon={Pencil} label={`编辑 ${monitor.name}`} data-testid={`monitor-edit-${monitor.id}`} onClick={() => onEdit(monitor)} />{!compact && <IconButton icon={Trash2} className="danger-hover" label={`删除 ${monitor.name}`} data-testid={`monitor-delete-${monitor.id}`} onClick={() => onDelete(monitor)} />}</div></td>
    </tr>)}
  </tbody></table></div>;
}

function Overview({ overview, monitors, timezone, busyIds, onCreate, onEdit, onRun, onDelete, onToggle, onViewAll, onViewRuns, onRunDetails }) {
  const data = overview || {};
  const total = data.totalRuns24h || 0;
  const metrics = [
    { label: "检测任务", value: data.totalMonitors ?? monitors.length, icon: Activity, note: `${data.enabledMonitors ?? monitors.filter((m) => m.enabled).length} 个调度中`, tone: "green" },
    { label: "24h 成功率", value: total ? `${Number(data.successRate24h ?? 0).toFixed(1)}%` : "—", icon: CheckCircle2, note: total ? `成功 ${total - (data.failedRuns24h || 0)} / ${total} 次` : "暂无运行数据", tone: "blue" },
    { label: "平均响应", value: latencyText(data.averageLatency24h), icon: Zap, note: "过去 24 小时", tone: "amber" },
    { label: "异常检测", value: data.failedRuns24h || 0, icon: TriangleAlert, note: data.failedRuns24h ? "过去 24 小时" : "暂无异常记录", tone: data.failedRuns24h ? "red" : "neutral" },
  ];
  return <>
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE OVERVIEW</div><h1>运行总览</h1><p>每一次响应，都有迹可循。</p></div><button className="button button-primary" onClick={onCreate}><Plus size={17} />新建任务</button></div>
    <div className="metrics-strip">{metrics.map(({ label, value, icon: Icon, note, tone }) => <div className="metric" key={label}><div className="metric-top"><span>{label}</span><Icon className={`metric-icon ${tone}`} size={17} strokeWidth={1.6} /></div><div className="metric-value">{value}</div><div className="metric-note">{label === "检测任务" && <span className="live-dot" />}{note}</div></div>)}</div>
    <section className="workspace-section"><div className="section-heading"><div><h2>检测活动<span className="section-period">最近 24 小时</span></h2></div><span className="small-note"><Clock3 size={13} />{timezone}</span></div><ActivityChart activity={data.activity} total={total} timezone={timezone} /></section>
    <section className="workspace-section"><div className="section-heading"><h2>检测任务<span className="count-label">{monitors.length}</span></h2><button className="text-button" onClick={onViewAll}>查看全部<ArrowRight size={14} /></button></div>
      {monitors.length ? <MonitorTable monitors={monitors.slice(0, 5)} compact timezone={timezone} busyIds={busyIds} onEdit={onEdit} onRun={onRun} onDelete={onDelete} onToggle={onToggle} /> : <EmptyState title="还没有检测任务" action={<button className="button button-secondary" onClick={onCreate}><Plus size={16} />新建任务</button>}>添加你的第一个 API 端点。</EmptyState>}
    </section>
    {!!data.recentRuns?.length && <section className="workspace-section"><div className="section-heading"><h2>最近运行</h2><button className="text-button" onClick={onViewRuns}>运行记录<ArrowRight size={14} /></button></div><div className="recent-runs">{data.recentRuns.slice(0, 4).map((run) => <button className="recent-run" key={run.id} onClick={() => onRunDetails(run)}><span className={`run-event-icon ${run.status === "success" ? "green" : "red"}`}>{run.status === "success" ? <Check size={15} /> : <X size={15} />}</span><span className="recent-run-name">{run.monitorName}<span>{run.trigger === "manual" ? "手动检测" : "定时检测"}</span></span><span className="recent-run-time">{dateText(run.createdAt, timezone)}</span><span className="recent-run-latency">{latencyText(run.latencyMs)}</span><ChevronRight size={15} /></button>)}</div></section>}
  </>;
}

function MonitorsView({ monitors, busyIds, timezone, onCreate, onEdit, onRun, onDelete, onToggle }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = monitors.filter((monitor) => `${monitor.name} ${monitor.model} ${monitor.endpoint}`.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || (filter === "enabled" ? monitor.enabled : !monitor.enabled)));
  return <>
    <div className="page-heading"><div><div className="eyebrow">MONITORS</div><h1>检测任务<span className="heading-count">{monitors.length}</span></h1><p>{monitors.filter((m) => m.enabled).length} 个任务正在调度</p></div><button className="button button-primary" onClick={onCreate}><Plus size={17} />新建任务</button></div>
    <div className="filter-toolbar"><div className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务、模型或端点" aria-label="搜索任务" />{search && <IconButton icon={X} label="清空搜索" onClick={() => setSearch("")} />}</div><select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="调度状态筛选"><option value="all">全部状态</option><option value="enabled">调度中</option><option value="paused">已暂停</option></select><span className="filter-count">{filtered.length} 个任务</span></div>
    <section className="workspace-section table-section">
      {filtered.length ? <MonitorTable monitors={filtered} busyIds={busyIds} timezone={timezone} onEdit={onEdit} onRun={onRun} onDelete={onDelete} onToggle={onToggle} /> : <EmptyState icon={search ? Search : Activity} title={monitors.length ? "没有匹配的任务" : "还没有检测任务"} action={monitors.length ? <button className="button button-secondary" onClick={() => { setSearch(""); setFilter("all"); }}>重置筛选</button> : <button className="button button-primary" onClick={onCreate}><Plus size={16} />新建任务</button>}>{monitors.length ? "试试其他关键词或筛选条件。" : "从一个 API 端点开始。"}</EmptyState>}
    </section>
  </>;
}

function MonitorEditor({ monitor, defaultTimezone, request, onSaved, onClose }) {
  const initial = useRef({
    name: monitor?.name || "", endpoint: monitor?.endpoint || "", model: monitor?.model || "",
    apiKey: "", enabled: monitor?.enabled ?? true, scheduleType: monitor?.scheduleType || "interval",
    intervalMinutes: monitor?.intervalMinutes || 30, dailyTimes: monitor?.dailyTimes?.length ? [...monitor.dailyTimes] : ["09:00"],
    timezone: monitor?.timezone || defaultTimezone, timeoutSeconds: monitor?.timeoutSeconds || 30, maxTokens: monitor?.maxTokens || 64,
  });
  const [form, setForm] = useState(initial.current);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  async function save(event) {
    event.preventDefault();
    setError("");
    if (form.scheduleType === "daily" && (!form.dailyTimes.length || form.dailyTimes.some((time) => !/^\d{2}:\d{2}$/.test(time)))) return setError("请填写有效的每日触发时间。");
    if (new Set(form.dailyTimes).size !== form.dailyTimes.length) return setError("每日触发时间不能重复。");
    setBusy(true);
    try {
      const body = { ...form, name: form.name.trim(), endpoint: form.endpoint.trim(), model: form.model.trim(), intervalMinutes: Number(form.intervalMinutes), timeoutSeconds: Number(form.timeoutSeconds), maxTokens: Number(form.maxTokens), dailyTimes: [...form.dailyTimes].sort() };
      if (!body.apiKey) delete body.apiKey;
      await request(monitor ? `/api/monitors/${monitor.id}` : "/api/monitors", { method: monitor ? "PUT" : "POST", body: JSON.stringify(body) });
      change("apiKey", "");
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={monitor ? "编辑检测任务" : "新建检测任务"} testId="task-editor" className="drawer-backdrop" onClose={() => { if (!busy) onClose(); }}>
    <form className="monitor-form" onSubmit={save}>
      <div className="drawer-body">
        <div className="form-section-label"><Globe2 size={15} />端点配置</div>
        <label className="field">任务名称<input value={form.name} onChange={(e) => change("name", e.target.value)} required maxLength={80} placeholder="例如：生产环境 API" autoComplete="off" /></label>
        <label className="field">API 端点<input type="url" value={form.endpoint} onChange={(e) => change("endpoint", e.target.value)} required maxLength={2048} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck="false" /><span className="field-hint">Base URL 或完整的 /chat/completions 地址</span></label>
        <label className="field">模型名称<input value={form.model} onChange={(e) => change("model", e.target.value)} required maxLength={200} placeholder="例如：gpt-4.1-mini" autoComplete="off" spellCheck="false" /></label>
        <label className="field"><span className="field-label-line">API 密钥{monitor?.keyConfigured && <span className="inline-secure"><ShieldCheck size={12} />已配置</span>}</span><span className="input-with-icon"><KeyRound size={16} /><input type="password" value={form.apiKey} onChange={(e) => change("apiKey", e.target.value)} required={!monitor} maxLength={8192} placeholder={monitor?.keyConfigured ? "留空保持现有密钥" : "输入 API 密钥"} autoComplete="new-password" spellCheck="false" /></span><span className="field-hint">保存后不再显示密钥</span></label>
        <div className="form-divider" />
        <div className="form-section-label"><CalendarClock size={15} />调度计划</div>
        <div className="field"><span>触发方式</span><div className="segmented-control"><button type="button" aria-pressed={form.scheduleType === "interval"} className={form.scheduleType === "interval" ? "active" : ""} onClick={() => change("scheduleType", "interval")}><Clock3 size={15} />固定间隔</button><button type="button" aria-pressed={form.scheduleType === "daily"} className={form.scheduleType === "daily" ? "active" : ""} onClick={() => change("scheduleType", "daily")}><CalendarClock size={15} />每日定时</button></div></div>
        {form.scheduleType === "interval" ? <label className="field">间隔时间<div className="number-with-unit"><input type="number" min="1" max="10080" step="1" required value={form.intervalMinutes} onChange={(e) => change("intervalMinutes", e.target.value)} /><span>分钟</span></div></label> : <div className="field"><span className="field-label-line">每日触发时间<span className="field-optional">{form.dailyTimes.length} / 24</span></span><div className="daily-times">{form.dailyTimes.map((time, index) => <div className="daily-time" key={index}><Clock3 size={14} /><input aria-label={`触发时间 ${index + 1}`} type="time" required value={time} onChange={(e) => change("dailyTimes", form.dailyTimes.map((value, i) => i === index ? e.target.value : value))} /><IconButton icon={X} label={`移除时间 ${index + 1}`} disabled={form.dailyTimes.length === 1} onClick={() => change("dailyTimes", form.dailyTimes.filter((_, i) => i !== index))} /></div>)}</div><button type="button" className="text-button add-time" disabled={form.dailyTimes.length >= 24} onClick={() => { const available = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`).find((time) => !form.dailyTimes.includes(time)); change("dailyTimes", [...form.dailyTimes, available || "12:30"]); }}><Plus size={15} />添加时间点</button></div>}
        <label className="field">调度时区<select value={form.timezone} onChange={(e) => change("timezone", e.target.value)}>{[...new Set([...TIMEZONES, form.timezone])].map((timezone) => <option key={timezone}>{timezone}</option>)}</select></label>
        <div className="switch-field"><div><span>启用调度</span><span className="field-hint">{form.enabled ? "按计划自动检测" : "仅手动触发检测"}</span></div><Toggle checked={form.enabled} label="启用调度" onChange={(enabled) => change("enabled", enabled)} /></div>
        <details className="advanced-settings"><summary><SlidersHorizontal size={14} /><span>高级设置</span><ChevronDown size={14} /></summary><div className="form-two-columns"><label className="field">请求超时<div className="number-with-unit"><input type="number" required min="5" max="120" value={form.timeoutSeconds} onChange={(e) => change("timeoutSeconds", e.target.value)} /><span>秒</span></div></label><label className="field">最大输出 Token<input type="number" required min="16" max="512" value={form.maxTokens} onChange={(e) => change("maxTokens", e.target.value)} /></label></div></details>
        {error && <div className="form-error" role="alert"><TriangleAlert size={16} />{error}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>取消</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? <Spinner size={16} /> : <Check size={16} />}{busy ? "保存中" : "保存任务"}</button></div>
    </form>
  </Modal>;
}

function RunDetails({ run, timezone, onClose }) {
  return <Modal title="检测详情" wide onClose={onClose}><div className="run-detail-body">
    <div className="run-detail-title"><span className={`detail-status-icon ${run.status === "success" ? "success" : "failure"}`}>{run.status === "success" ? <CheckCheck size={23} /> : <Unplug size={23} />}</span><div><h3>{run.monitorName}</h3><span>{dateText(run.createdAt, timezone, { year: "numeric", second: "2-digit" })}</span></div><Status status={run.status} /></div>
    <dl className="detail-metrics"><div><dt>响应耗时</dt><dd>{latencyText(run.latencyMs)}</dd></div><div><dt>HTTP 状态</dt><dd>{run.httpStatus || "—"}</dd></div><div><dt>触发方式</dt><dd>{run.trigger === "manual" ? "手动检测" : "定时检测"}</dd></div><div><dt>Token 用量</dt><dd>{run.tokensUsed ?? "—"}</dd></div></dl>
    <div className="detail-model"><Terminal size={14} /><span>{run.model || "—"}</span></div>
    {run.error && <div className="detail-block"><h4 className="red"><TriangleAlert size={14} />错误信息</h4><pre className="error-preview">{run.error}</pre></div>}
    <div className="detail-block"><h4><ArrowUpRight size={14} />发送内容</h4><pre>{typeof run.prompt === "string" ? run.prompt : JSON.stringify(run.prompt, null, 2) || "—"}</pre></div>
    <div className="detail-block"><h4><ArrowDownRight size={14} />响应摘要</h4><pre>{run.responsePreview || "无响应内容"}</pre></div>
  </div><div className="modal-footer"><button className="button button-secondary" onClick={onClose}>关闭</button></div></Modal>;
}

function History({ monitors, request, timezone, refreshTick, onRunDetails }) {
  const [monitorId, setMonitorId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ runs: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (monitorId) params.set("monitorId", monitorId);
    if (status) params.set("status", status);
    request(`/api/runs?${params}`).then((data) => { if (!cancelled) { setResult(data); setError(""); } }).catch((err) => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [monitorId, status, page, request, refreshTick]);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return <>
    <div className="page-heading"><div><div className="eyebrow">RUN HISTORY</div><h1>运行记录</h1><p>请求与响应的完整时间线</p></div><span className="heading-context"><FileClock size={15} />共 {result.total} 条记录</span></div>
    <div className="filter-toolbar"><select aria-label="按检测任务筛选" value={monitorId} onChange={(e) => { setMonitorId(e.target.value); setPage(1); }}><option value="">全部任务</option>{monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}</select><select aria-label="按检测结果筛选" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">全部结果</option><option value="success">检测成功</option><option value="failure">检测失败</option></select><span className="filter-count">{loading && <Spinner size={14} />}{timezone}</span></div>
    {error && <div className="inline-error" role="alert"><TriangleAlert size={16} />{error}</div>}
    <section className="workspace-section table-section">
      {result.runs.length ? <><div className="table-scroll"><table className="data-table history-table"><thead><tr><th>运行时间</th><th>检测任务</th><th>结果</th><th>响应耗时</th><th>触发方式</th><th className="align-right">详情</th></tr></thead><tbody>{result.runs.map((run) => <tr key={run.id}><td><span className="monospace">{dateText(run.createdAt, timezone, { second: "2-digit" })}</span></td><td><button className="plain-link task-name" onClick={() => onRunDetails(run)}>{run.monitorName}</button><span className="cell-secondary">{run.model}</span></td><td><Status status={run.status} /></td><td className="monospace">{latencyText(run.latencyMs)}</td><td><span className="trigger-tag">{run.trigger === "manual" ? <Play size={12} /> : <CalendarClock size={12} />}{run.trigger === "manual" ? "手动" : "定时"}</span></td><td><div className="row-actions"><IconButton icon={ArrowUpRight} label={`查看 ${run.monitorName} 检测详情`} onClick={() => onRunDetails(run)} /></div></td></tr>)}</tbody></table></div><div className="pagination"><span>共 {result.total} 条 · 第 {page} / {pages} 页</span><div><IconButton icon={ChevronLeft} label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} /><IconButton icon={ChevronRight} label="下一页" disabled={page >= pages || loading} onClick={() => setPage(page + 1)} /></div></div></> : loading ? <div className="loading-block"><Spinner /><span>读取运行记录</span></div> : <EmptyState icon={FileClock} title={monitorId || status ? "没有匹配的运行记录" : "暂无运行记录"}>{monitorId || status ? "调整筛选条件后重试。" : "任务完成检测后，记录会显示在这里。"}</EmptyState>}
    </section>
  </>;
}

function SettingsView({ settings, request, onSaved, notify }) {
  const [form, setForm] = useState({ timezone: settings.timezone, logRetentionDays: settings.logRetentionDays });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  async function saveSettings(event) {
    event.preventDefault();
    setBusy("settings");
    setError("");
    try {
      await request("/api/settings", { method: "PUT", body: JSON.stringify({ ...form, logRetentionDays: Number(form.logRetentionDays) }) });
      await onSaved();
      notify("系统设置已保存");
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function savePassword(event) {
    event.preventDefault();
    setPasswordError("");
    if (password.newPassword !== password.confirmPassword) return setPasswordError("两次输入的新密码不一致。");
    if (password.newPassword.length < 12) return setPasswordError("新密码至少需要 12 个字符。");
    setBusy("password");
    try {
      await request("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: password.currentPassword, newPassword: password.newPassword }) });
      setPassword({ currentPassword: "", newPassword: "", confirmPassword: "" });
      notify("密码已更新，其他登录会话已退出");
    } catch (err) { setPasswordError(err.message); } finally { setBusy(""); }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>系统设置</h1><p>工作空间与账户</p></div></div>
    <section className="settings-section"><div className="settings-section-intro"><span className="settings-category-icon"><SlidersHorizontal size={20} strokeWidth={1.6} /></span><h2>工作空间</h2></div><form className="settings-form" onSubmit={saveSettings}>
      <label className="field">默认时区<select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>{[...new Set([...TIMEZONES, form.timezone])].map((timezone) => <option key={timezone}>{timezone}</option>)}</select></label>
      <label className="field">日志保留时间<div className="number-with-unit"><input type="number" min="1" max="365" required value={form.logRetentionDays} onChange={(e) => setForm({ ...form, logRetentionDays: e.target.value })} /><span>天</span></div></label>
      <div className="settings-readonly"><span>内网端点访问</span><span className={settings.allowPrivateEndpoints ? "green" : "text-muted"}>{settings.allowPrivateEndpoints ? "允许" : "关闭"}<LockKeyhole size={12} /></span></div>
      {error && <div className="form-error" role="alert"><TriangleAlert size={16} />{error}</div>}
      <div className="settings-form-actions"><button className="button button-primary" disabled={!!busy} type="submit">{busy === "settings" ? <Spinner size={16} /> : <Check size={16} />}保存设置</button></div>
    </form></section>
    <section className="settings-section"><div className="settings-section-intro"><span className="settings-category-icon"><ShieldCheck size={20} strokeWidth={1.6} /></span><h2>账户安全</h2></div><form className="settings-form" onSubmit={savePassword}>
      <label className="field">当前密码<input type="password" required maxLength={128} autoComplete="current-password" value={password.currentPassword} onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })} /></label>
      <label className="field">新密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" placeholder="至少 12 个字符" value={password.newPassword} onChange={(e) => setPassword({ ...password, newPassword: e.target.value })} /></label>
      <label className="field">确认新密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password.confirmPassword} onChange={(e) => setPassword({ ...password, confirmPassword: e.target.value })} /></label>
      {passwordError && <div className="form-error" role="alert"><TriangleAlert size={16} />{passwordError}</div>}
      <div className="settings-form-actions"><button className="button button-secondary" disabled={!!busy} type="submit">{busy === "password" ? <Spinner size={16} /> : <KeyRound size={16} />}更新密码</button></div>
    </form></section>
    <div className="settings-security-note"><ShieldCheck size={16} /><span>API 密钥已加密存储</span><span className="separator">·</span><span>仅服务端使用</span></div>
  </>;
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const csrfRef = useRef(null);
  const [bootError, setBootError] = useState("");
  const [view, setView] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const [overview, setOverview] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [editor, setEditor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [selectedRun, setSelectedRun] = useState(null);
  const [busyIds, setBusyIds] = useState(new Set());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const authenticate = useCallback((result) => {
    csrfRef.current = result?.csrfToken || null;
    setSession(result);
  }, []);
  const request = useCallback(async (path, options) => {
    try {
      return await fetchApi(path, options, csrfRef.current);
    } catch (err) {
      if (err.status === 401) {
        csrfRef.current = null;
        setSession({ authenticated: false });
        setEditor(null);
        setSelectedRun(null);
        setDeleteTarget(null);
      }
      throw err;
    }
  }, []);
  const notify = useCallback((message, tone = "success") => {
    clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const checkSession = useCallback(async () => {
    setBootError("");
    try { authenticate(await fetchApi("/api/auth/session")); } catch { setBootError("暂时无法连接服务，请确认服务已启动。"); }
  }, [authenticate]);
  useEffect(() => { checkSession(); }, [checkSession]);
  const loadData = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    try {
      const [monitorData, overviewData, settingsData] = await Promise.all([request("/api/monitors"), request("/api/overview"), request("/api/settings")]);
      setMonitors(monitorData.monitors || []);
      setOverview(overviewData);
      setSettings(settingsData);
      setDataError("");
      setLastUpdated(new Date());
      setRefreshTick((value) => value + 1);
    } catch (err) { setDataError(err.message); } finally { setDataLoading(false); if (!quiet) setRefreshing(false); }
  }, [request]);
  useEffect(() => {
    if (!session?.authenticated) return;
    setDataLoading(true);
    loadData();
    const timer = setInterval(() => { if (document.visibilityState === "visible") loadData({ quiet: true }); }, 15000);
    return () => clearInterval(timer);
  }, [session?.authenticated, loadData]);
  useEffect(() => { setSidebarOpen(false); window.scrollTo({ top: 0 }); }, [view]);
  useEffect(() => {
    if (!sidebarOpen) return;
    function keydown(event) { if (event.key === "Escape") setSidebarOpen(false); }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [sidebarOpen]);

  async function logout() {
    try { await request("/api/auth/logout", { method: "POST" }); authenticate({ authenticated: false }); setMonitors([]); setOverview(null); setView("overview"); }
    catch (err) { notify(err.message, "error"); }
  }
  async function runMonitor(monitor) {
    setBusyIds((old) => new Set([...old, monitor.id]));
    try {
      const result = await request(`/api/monitors/${monitor.id}/run`, { method: "POST" });
      const run = result?.run || result;
      notify(run.status === "success" ? `${monitor.name}：检测成功` : `${monitor.name}：检测失败`, run.status === "success" ? "success" : "error");
      setSelectedRun(run);
      await loadData({ quiet: true });
    } catch (err) { notify(err.message, "error"); }
    finally { setBusyIds((old) => { const next = new Set(old); next.delete(monitor.id); return next; }); }
  }
  async function toggleMonitor(monitor, enabled) {
    setBusyIds((old) => new Set([...old, monitor.id]));
    try {
      const { name, endpoint, model, scheduleType, intervalMinutes, dailyTimes, timezone, timeoutSeconds, maxTokens } = monitor;
      await request(`/api/monitors/${monitor.id}`, { method: "PUT", body: JSON.stringify({ name, endpoint, model, scheduleType, intervalMinutes, dailyTimes, timezone, timeoutSeconds, maxTokens, enabled }) });
      await loadData({ quiet: true });
      notify(enabled ? "调度已启用" : "调度已暂停");
    } catch (err) { notify(err.message, "error"); }
    finally { setBusyIds((old) => { const next = new Set(old); next.delete(monitor.id); return next; }); }
  }
  async function deleteMonitor() {
    setDeleting(true);
    setDeleteError("");
    try { await request(`/api/monitors/${deleteTarget.id}`, { method: "DELETE" }); setDeleteTarget(null); await loadData({ quiet: true }); notify("检测任务已删除"); }
    catch (err) { setDeleteError(err.message); } finally { setDeleting(false); }
  }
  const showDelete = (monitor) => { setDeleteError(""); setDeleteTarget(monitor); };
  const createMonitor = () => setEditor({ isNew: true });
  const editMonitor = (monitor) => setEditor({ monitor });
  const common = { monitors, busyIds, timezone: settings.timezone, onCreate: createMonitor, onEdit: editMonitor, onRun: runMonitor, onDelete: showDelete, onToggle: toggleMonitor };

  if (session === undefined) return <main className="boot-screen"><span className="brand-mark"><Activity size={26} /></span><h1>定时探活</h1>{bootError ? <><p role="alert">{bootError}</p><button className="button button-secondary" onClick={checkSession}><RefreshCw size={16} />重新连接</button></> : <Spinner size={22} />}</main>;
  if (!session.authenticated) return <Login onLogin={authenticate} />;
  return <div className="app-layout">
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
      <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); setView("overview"); }}><span className="brand-mark"><Activity size={24} strokeWidth={1.9} /></span><span>定时探活<span className="brand-caption">API MONITOR</span></span></a>
      <div className="workspace-label"><span className="workspace-avatar">W</span><span>我的工作空间<small>个人部署</small></span><LockKeyhole size={13} /></div>
      <div className="nav-section-label">工作空间</div>
      <nav aria-label="主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? "is-active" : ""}`} onClick={() => setView(id)} aria-current={view === id ? "page" : undefined}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{id === "monitors" && monitors.length > 0 && <span className="nav-count">{monitors.length}</span>}{view === id && <span className="nav-active-mark" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="scheduler-status"><span className={`live-dot ${dataError ? "is-error" : ""}`} /><span>{dataError ? "服务连接异常" : "调度服务运行中"}<small>{overview?.runningCount ? `${overview.runningCount} 个任务检测中` : `${monitors.filter((m) => m.enabled).length} 个活跃任务`}</small></span></div><div className="sidebar-footer"><span>定时探活</span><span>v1.0</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><IconButton className="mobile-menu-button" icon={Menu} label="打开导航" onClick={() => setSidebarOpen(true)} /><span className="breadcrumb-workspace">工作空间</span><span className="breadcrumb-slash">/</span><span>{NAV.find((item) => item.id === view)?.label}</span></div><div className="topbar-actions"><span className="last-updated">{lastUpdated ? `${dateText(lastUpdated, settings.timezone, { month: undefined, day: undefined, second: "2-digit" })} 更新` : ""}</span><IconButton icon={RefreshCw} label="刷新数据" className={refreshing ? "is-spinning" : ""} disabled={refreshing} onClick={() => loadData()} /><span className="topbar-divider" /><span className="user-avatar">{session.user?.username?.slice(0, 1).toUpperCase() || "A"}</span><span className="username">{session.user?.username || "admin"}</span><IconButton icon={LogOut} label="退出登录" onClick={logout} /></div></header>
      <main className={`main-content view-${view}`} id="main-content">
        {dataError && <div className="inline-error page-error" role="alert"><TriangleAlert size={16} /><span>{dataError}</span><button className="text-button" onClick={() => loadData()}>重试<RefreshCw size={13} /></button></div>}
        {dataLoading && !overview ? <div className="loading-block initial-loading"><Spinner size={22} /><span>正在读取工作空间</span></div> : <>
          {view === "overview" && <Overview {...common} overview={overview} onViewAll={() => setView("monitors")} onViewRuns={() => setView("runs")} onRunDetails={setSelectedRun} />}
          {view === "monitors" && <MonitorsView {...common} />}
          {view === "runs" && <History monitors={monitors} request={request} timezone={settings.timezone} refreshTick={refreshTick} onRunDetails={setSelectedRun} />}
          {view === "settings" && <SettingsView settings={settings} request={request} onSaved={() => loadData({ quiet: true })} notify={notify} />}
        </>}
        <footer className="page-footer"><span>定时探活</span><span><ShieldCheck size={12} />私有部署</span></footer>
      </main>
    </div>
    {editor && <MonitorEditor monitor={editor.monitor} defaultTimezone={settings.timezone} request={request} onSaved={() => { setEditor(null); loadData({ quiet: true }); notify("检测任务已保存"); }} onClose={() => setEditor(null)} />}
    {selectedRun && <RunDetails run={selectedRun} timezone={settings.timezone} onClose={() => setSelectedRun(null)} />}
    {deleteTarget && <Modal title="删除检测任务" onClose={() => { if (!deleting) setDeleteTarget(null); }}><div className="confirmation-body"><span className="confirmation-icon"><Trash2 size={22} /></span><h3>删除「{deleteTarget.name}」？</h3><p>删除后停止后续调度，此操作无法撤销。</p>{deleteError && <div className="form-error" role="alert">{deleteError}</div>}</div><div className="modal-footer"><button className="button button-secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="button button-danger" disabled={deleting} onClick={deleteMonitor}>{deleting ? <Spinner size={16} /> : <Trash2 size={16} />}确认删除</button></div></Modal>}
    {toast && <div className={`toast ${toast.tone}`} role="status">{toast.tone === "error" ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}<span>{toast.message}</span><IconButton icon={X} label="关闭提示" onClick={() => setToast(null)} /></div>}
  </div>;
}
