import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000001': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
});

describe('the stocks page', () => {
  it('draws the chart: nothing in drawChart shadows the price split anchor()', async () => {
    /* 2026-11-14: the split made levelOf call anchor(), but drawChart already had a local number
     * called anchor (where the forming candle sits). Inside the function that number won, every frame
     * threw "anchor is not a function", and the chart stayed blank. */
    const page = await front('assets/js/stocks.js');
    const start = page.indexOf('function drawChart(');
    const body = page.slice(start, page.indexOf('\n}\n', start));
    assert.ok(start > 0 && body.length > 0);
    assert.match(body, /\+ anchor\(\);/);
    assert.doesNotMatch(body, /\b(const|let|var|function)\s+anchor\b/);
  });

  it('closes a position by itself at a $2B max win, and says so', async () => {
    assert.equal(config.stocksMaxPayoutMinor, 2_000_000_000n);
    assert.ok(config.stocksMaxPayoutMinor > config.stocksMaxStakeMinor);
    const [page, html] = await Promise.all([front('assets/js/stocks.js'), front('index.html')]);
    assert.match(page, /\$\('#stocksMaxWin', root\)\.textContent = `max win \$\{money\(Number\(cfg\.maxPayoutMinor\)\)\}`;/);
    assert.match(page, /Closed by itself at the \$\{money\(Number\(p\.maxPayoutMinor\)\)\} max win/);
    assert.match(html, /A position that reaches the max win closes by itself and pays it\./);
  });
});
