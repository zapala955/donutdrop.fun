import process from 'node:process';
import pino from 'pino';
import { ApiClient } from './api-client.js';
import { loadBotConfig } from './config.js';
import { DisabledTransferAdapter } from './transfer-adapter.js';
import { MinecraftWorker } from './worker.js';

const config = loadBotConfig();
const log = pino({ level: config.logLevel, redact: ['*.leaseToken', '*.deliveryCodeHash'] });
if (config.transfersEnabled) {
  throw new Error(
    'BOT_TRANSFERS_ENABLED cannot be enabled until a reviewed DonutSMP-specific TransferAdapter is installed',
  );
}
const worker = new MinecraftWorker(
  config,
  new ApiClient(config),
  new DisabledTransferAdapter(),
  log,
);
worker.start();

let stopping = false;
async function stop(signal: string, exitCode = 0): Promise<void> {
  if (exitCode !== 0) process.exitCode = exitCode;
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Stopping Mineflayer worker');
  try {
    await worker.stop();
  } catch (error) {
    process.exitCode = 1;
    log.error({ err: error }, 'Mineflayer worker shutdown failed');
  }
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
process.on('unhandledRejection', (error) => {
  log.fatal({ err: error }, 'Unhandled rejection');
  void stop('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'Uncaught exception');
  void stop('uncaughtException', 1);
});
