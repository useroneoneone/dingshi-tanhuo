import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../server/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'tanhuo-e2e-'));
const upstream = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const payload = JSON.parse(text || '{}');
  res.setHeader('Content-Type', 'application/json');
  if (payload.model === 'failure-model') {
    res.writeHead(503);
    res.end(JSON.stringify({ error: { message: 'Simulated upstream unavailable' } }));
    return;
  }
  if (req.url !== '/v1/chat/completions' || !req.headers.authorization?.startsWith('Bearer ')) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid probe request' }));
    return;
  }
  const secret = req.headers.authorization.slice(7);
  res.end(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: `连接正常。Echo redaction check: ${secret}` } }],
    usage: { total_tokens: 28 },
  }));
});
await new Promise((done) => upstream.listen(4311, '127.0.0.1', done));

const application = await createApp({
  dataDir,
  adminUsername: 'e2e-admin',
  adminPassword: 'E2e-test-password!234',
  allowPrivateEndpoints: true,
  startScheduler: false,
});
const server = createServer(application.app);
await new Promise((done) => server.listen(4310, '127.0.0.1', done));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await application.close();
  await Promise.all([
    new Promise((done) => server.close(done)),
    new Promise((done) => upstream.close(done)),
  ]);
  if (dirname(resolve(dataDir)) === resolve(tmpdir()) && basename(dataDir).startsWith('tanhuo-e2e-')) {
    await rm(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
