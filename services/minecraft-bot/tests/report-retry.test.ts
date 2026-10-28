import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { REPORT_RETRY_DELAYS_MS, retryReport } from '../src/report-retry.js';

const noWait = async (): Promise<void> => undefined;

/* A gateway that was unreachable for a second used to cost the receipt for good: the money was on
 * the account, so the next /bal booked it as a nameless adjustment. */
test('keeps trying a receipt through a gateway outage', async () => {
  let calls = 0;
  const retries: number[] = [];
  await retryReport(
    async () => {
      calls += 1;
      if (calls < 4) throw new Error('fetch failed');
    },
    (_error, _attempt, delayMs) => retries.push(delayMs),
    REPORT_RETRY_DELAYS_MS,
    noWait,
  );
  assert.equal(calls, 4);
  assert.deepEqual(retries, REPORT_RETRY_DELAYS_MS.slice(0, 3));
});

test('keeps trying through server errors, timeouts and rate limits', async () => {
  for (const message of ['API 503: unavailable', 'API 500: boom', 'API 429: slow down', 'API 408: timeout']) {
    let calls = 0;
    await retryReport(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error(message);
      },
      () => undefined,
      REPORT_RETRY_DELAYS_MS,
      noWait,
    );
    assert.equal(calls, 2, message);
  }
});

test('gives up at once on a definite refusal, so the receipts behind it are not held up', async () => {
  let calls = 0;
  await assert.rejects(
    retryReport(
      async () => {
        calls += 1;
        throw new Error('API 400: invalid event');
      },
      () => undefined,
      REPORT_RETRY_DELAYS_MS,
      noWait,
    ),
    /API 400/,
  );
  assert.equal(calls, 1);
});

test('gives up after the last delay and hands back the error', async () => {
  let calls = 0;
  await assert.rejects(
    retryReport(
      async () => {
        calls += 1;
        throw new Error('fetch failed');
      },
      () => undefined,
      [1, 1],
      noWait,
    ),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

/* Every attempt must be the SAME event: the gateway answers a repeated id from its journal, so a
 * retry after an attempt that landed cannot credit the payment twice. */
test('reports every attempt of one receipt under one event id', async () => {
  const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const queue = worker.slice(worker.indexOf('private queuePaymentReport('));
  assert.match(queue.slice(0, 400), /const eventId = randomUUID\(\);/);
  assert.match(worker, /this\.api\.reportPaymentNotice\(payer, displayedAmount, payerUuid, eventId\)/);
  const client = await readFile(new URL('../src/api-client.ts', import.meta.url), 'utf8');
  assert.match(client, /eventId: string = randomUUID\(\),\s*\): Promise<void> \{\s*await this\.sendEvent\(\{\s*eventId,/);
});
