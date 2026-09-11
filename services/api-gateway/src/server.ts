import process from 'node:process';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);
let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (exitCode !== 0) process.exitCode = exitCode;
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref();
  try {
    await app.close();
  } catch (error) {
    process.exitCode = 1;
    app.log.error({ err: error }, 'Graceful shutdown failed');
  } finally {
    clearTimeout(forced);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  app.log.fatal({ err: error }, 'Unhandled rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'Failed to start');
  await app.close();
  process.exitCode = 1;
}
