import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { payTaxMinor, payoutAfterTax } from '../src/lib/pay-tax.js';

const root = path.resolve(import.meta.dirname, '..');

/* DonutSMP taxes /pay since 2026-11-11. The owner: "the site should take it from the players wd". */
describe("DonutSMP's /pay tax, paid out of the withdrawal", () => {
  it('matches what the live server charged on 2026-11-11', () => {
    // The teller's /bal fell by exactly these, in order: 6,355,518 and 51,998,123.
    assert.equal(payTaxMinor(6_230_900n, 200), 124_618n);
    assert.equal(payTaxMinor(50_978_551n, 200), 1_019_572n); // 1,019,571.02 rounded up
    assert.equal(payTaxMinor(1_802_500n, 200), 36_050n); // "36K"
    assert.equal(payTaxMinor(1_000_000n, 200), 20_000n); // "20K"
  });

  it('pays the most whose tax still fits inside what the player was debited', () => {
    for (const gross of [10_000n, 99_999n, 1_000_000n, 6_355_518n, 51_998_123n, 100_000_000n, 2_000_000_000n, 123_456_789_012n]) {
      const net = payoutAfterTax(gross, 200);
      assert.ok(net + payTaxMinor(net, 200) <= gross, `fits for ${gross}`);
      assert.ok(net + 1n + payTaxMinor(net + 1n, 200) > gross, `largest for ${gross}`);
    }
    // A $100M withdrawal: the player receives $98,039,215 and the tax is the rest, to the dollar.
    assert.equal(payoutAfterTax(100_000_000n, 200), 98_039_215n);
    assert.equal(payTaxMinor(98_039_215n, 200), 1_960_785n);
    // The two payouts of this morning, had they been sent net, would have cost exactly what was debited.
    assert.equal(payoutAfterTax(6_355_518n, 200), 6_230_900n);
    // Off, the whole withdrawal is paid.
    assert.equal(payoutAfterTax(6_230_900n, 0), 6_230_900n);
    assert.equal(payTaxMinor(6_230_900n, 0), 0n);
  });

  it('is 2% unless configured, and the bot is sent the net figure in its three-field job', async () => {
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'c'.repeat(32),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({
        '00000000-0000-4000-8000-000000000001': {
          secret: Buffer.alloc(32, 2).toString('base64'),
          serverHost: 'donutsmp.net',
          username: 'DonutBot',
        },
      }),
      AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
      IP_HASH_KEY: 'i'.repeat(32),
    };
    assert.equal(loadConfig(env).payTaxBps, 200);
    assert.equal(loadConfig({ ...env, PAY_TAX_BPS: '0' }).payTaxBps, 0);
    const route = await readFile(path.join(root, 'src/routes/cash-withdrawals.ts'), 'utf8');
    assert.match(
      route,
      /return JSON\.stringify\(\{\s*withdrawalId: withdrawal\.id,\s*payee: withdrawal\.payee_username,\s*amountMinor: payoutAfterTax\(BigInt\(withdrawal\.amount_minor\), config\.payTaxBps\)\.toString\(\),\s*\}\);/,
    );
    // Both places that queue a player's payout use it; neither sends the gross amount any more.
    assert.equal(route.match(/payoutJobPayload\(config, withdrawal\)/g)?.length, 2);
    assert.doesNotMatch(route, /amountMinor: withdrawal\.amount_minor/);
    // The books still take the whole withdrawal off the teller, which is what left its account.
    const bot = await readFile(path.join(root, 'src/routes/minecraft-in.ts'), 'utf8');
    assert.match(bot, /reason: 'withdrawal',\s*referenceId: jobId,/);
    assert.match(bot, /amountMinor: BigInt\(row\.amount_minor\),\s*reason: 'withdrawal'/);
  });
});
