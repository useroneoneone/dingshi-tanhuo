import { createServer } from 'node:http';
import { createApp } from './app.js';

let application;
try {
  application = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const host = process.env.HOST ?? '0.0.0.0';
  const server = createServer(application.app);
  server.requestTimeout = 130000;
  server.headersTimeout = 15000;
  server.listen(port, host, () => console.log(`Tanhuo is listening at http://${host}:${port}`));
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(1), 10000);
    timer.unref();
    server.close(async () => {
      await application.close();
      clearTimeout(timer);
      process.exit(0);
    });
    server.closeIdleConnections();
    await application.monitorService.close();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.on('error', async (error) => {
    console.error('Unable to listen:', error.code ?? error.message);
    await application.close();
    process.exitCode = 1;
  });
} catch (error) {
  console.error('Unable to start:', error.message);
  if (application) await application.close();
  process.exitCode = 1;
}
