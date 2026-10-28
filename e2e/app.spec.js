import { expect, test } from '@playwright/test';

const testSecret = 'sk-e2e-secret-must-never-be-returned';

test('authenticated task lifecycle, scheduling controls, history and mobile layout', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('e2e-admin');
  await page.getByLabel('密码', { exact: true }).fill('E2e-test-password!234');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.getByLabel('任务名称', { exact: true }).fill('测试主接口');
  await page.getByLabel(/^API 端点/).fill('http://127.0.0.1:4311/v1');
  await page.getByLabel('模型名称', { exact: true }).fill('test-model');
  await page.getByLabel(/^API 密钥/).fill(testSecret);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByText('测试主接口', { exact: true }).first()).toBeVisible();

  const session = await (await context.request.get('/api/auth/session')).json();
  const monitors = await (await context.request.get('/api/monitors')).json();
  const monitor = monitors.monitors.find((item) => item.name === '测试主接口');
  expect(monitor.keyConfigured).toBe(true);
  expect(JSON.stringify(monitors)).not.toContain(testSecret);
  expect(JSON.stringify(monitors)).not.toContain('encryptedApiKey');
  expect(monitor.nextRunAt).toBeTruthy();

  await page.getByTestId(`monitor-run-${monitor.id}`).click();
  await expect.poll(async () => {
    const body = await (await context.request.get('/api/runs')).json();
    return body.total;
  }).toBe(1);
  let history = await (await context.request.get('/api/runs')).json();
  expect(history.runs[0].status).toBe('success');
  expect(history.runs[0].tokensUsed).toBe(28);
  expect(JSON.stringify(history)).not.toContain(testSecret);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click();

  await page.getByTestId(`monitor-edit-${monitor.id}`).click();
  const keyField = page.getByLabel(/^API 密钥/);
  await expect(keyField).toHaveValue('');
  await page.getByLabel('任务名称', { exact: true }).fill('测试主接口（已编辑）');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByText('测试主接口（已编辑）', { exact: true }).first()).toBeVisible();

  const saved = (await (await context.request.get('/api/monitors')).json()).monitors.find((item) => item.id === monitor.id);
  const { id, keyConfigured, createdAt, updatedAt, lastRunAt, lastStatus, lastLatencyMs, nextRunAt, running, ...config } = saved;
  const update = await context.request.put(`/api/monitors/${monitor.id}`, {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: { ...config, scheduleType: 'daily', dailyTimes: ['09:00', '14:30', '21:00'] },
  });
  expect(update.status()).toBe(200);
  expect((await update.json()).dailyTimes).toEqual(['09:00', '14:30', '21:00']);
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^检测任务/ }).click();
  await expect(page.getByTestId(`monitor-row-${monitor.id}`)).toBeVisible();
  await page.screenshot({ path: '.qa/screenshots/tasks-desktop.png', fullPage: true });

  await context.request.put(`/api/monitors/${monitor.id}`, {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: { ...config, model: 'failure-model', scheduleType: 'daily', dailyTimes: ['09:00', '14:30', '21:00'] },
  });
  const failed = await context.request.post(`/api/monitors/${monitor.id}/run`, {
    headers: { 'X-CSRF-Token': session.csrfToken },
  });
  expect(failed.status()).toBe(200);
  expect((await failed.json()).status).toBe('failure');
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  await expect(page.getByText('failure-model', { exact: true }).first()).toBeVisible();
  history = await (await context.request.get('/api/runs?status=failure')).json();
  expect(history.total).toBe(1);
  expect(history.runs[0].httpStatus).toBe(503);

  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.screenshot({ path: '.qa/screenshots/overview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.qa/screenshots/overview-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('daily time editor, pause, history filters, settings, password and logout', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('e2e-admin');
  await page.getByLabel('密码', { exact: true }).fill('E2e-test-password!234');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  const editor = page.getByTestId('task-editor');
  await editor.getByLabel('任务名称', { exact: true }).fill('每日双时点');
  await editor.getByLabel(/^API 端点/).fill('http://127.0.0.1:4311/v1');
  await editor.getByLabel('模型名称', { exact: true }).fill('daily-test-model');
  await editor.getByLabel(/^API 密钥/).fill(testSecret);
  await editor.getByRole('button', { name: '每日定时', exact: true }).click();
  await editor.getByLabel('触发时间 1', { exact: true }).fill('08:15');
  await editor.getByRole('button', { name: '添加时间点', exact: true }).click();
  await editor.getByLabel('触发时间 2', { exact: true }).fill('20:45');
  await editor.getByLabel(/^调度时区/).selectOption('UTC');
  await editor.locator('summary').click();
  await editor.getByLabel(/^请求超时/).fill('5');
  await editor.getByLabel('最大输出 Token', { exact: true }).fill('32');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.qa/screenshots/editor-mobile.png', fullPage: true });
  await editor.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const monitors = (await (await context.request.get('/api/monitors')).json()).monitors;
  const monitor = monitors.find((item) => item.name === '每日双时点');
  expect(monitor.dailyTimes).toEqual(['08:15', '20:45']);
  expect(monitor.timezone).toBe('UTC');
  expect(monitor.timeoutSeconds).toBe(5);
  expect(monitor.maxTokens).toBe(32);
  expect(monitor.nextRunAt).toBeTruthy();

  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^检测任务/ }).click();
  const row = page.getByTestId(`monitor-row-${monitor.id}`);
  await row.getByRole('switch').scrollIntoViewIfNeeded();
  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  const paused = (await (await context.request.get('/api/monitors')).json()).monitors.find((item) => item.id === monitor.id);
  expect(paused.nextRunAt).toBeNull();
  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId(`monitor-run-${monitor.id}`).click();
  await expect(page.getByRole('dialog', { name: '检测详情', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click();

  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '运行记录', exact: true }).click();
  await page.getByLabel('按检测任务筛选', { exact: true }).selectOption(monitor.id);
  await page.getByLabel('按检测结果筛选', { exact: true }).selectOption('success');
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
  await expect(page.getByText('daily-test-model', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.qa/screenshots/history-mobile.png', fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByLabel(/^默认时区/).selectOption('Asia/Tokyo');
  await page.getByLabel(/^日志保留时间/).fill('14');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('系统设置已保存');
  const settings = await (await context.request.get('/api/settings')).json();
  expect(settings.timezone).toBe('Asia/Tokyo');
  expect(settings.logRetentionDays).toBe(14);
  await page.getByLabel('当前密码', { exact: true }).fill('E2e-test-password!234');
  await page.getByLabel('新密码', { exact: true }).fill('Updated-E2e-password!234');
  await page.getByLabel('确认新密码', { exact: true }).fill('not-the-same-password');
  await page.getByRole('button', { name: '更新密码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');
  await page.getByLabel('确认新密码', { exact: true }).fill('Updated-E2e-password!234');
  await page.getByRole('button', { name: '更新密码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已更新');
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await page.screenshot({ path: '.qa/screenshots/settings-desktop.png', fullPage: true });

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^检测任务/ }).click();
  await page.getByTestId(`monitor-delete-${monitor.id}`).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByTestId(`monitor-row-${monitor.id}`)).not.toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('e2e-admin');
  await page.getByLabel('密码', { exact: true }).fill('Updated-E2e-password!234');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '运行总览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.qa/screenshots/overview-small-mobile.png', fullPage: true });
});
