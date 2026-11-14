import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { generateDropCode, normalizeDropCode, slotStartOf } from '../src/lib/code-drops.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

/*
 * Code drops replaced the daily codes on 2026-11-11. The owner: "the community bot [will] send a code
 * every 2 hours that gives 10m and only 5 ppl can claim it, wager req to withdraw it is 3x", and
 * "remove the wager req to claim a code". What keeps the five honest is structural -- a row lock, a
 * guarded counter, unique indexes, READ COMMITTED -- so these pin the structure; the race itself is
 * run against a real database before deploying.
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFile(path.resolve(root, file), 'utf8');

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

describe('code drops', () => {
  it('ship as the owner set them: $10M, five claims, 3x to withdraw, every two hours', () => {
    const config = loadConfig(env);
    assert.equal(config.codeDropsEnabled, true);
    assert.equal(config.codeDropPrizeMinor, 10_000_000n);
    assert.equal(config.codeDropMaxClaims, 5);
    assert.equal(config.codeDropWagerMultiplier, 3);
    assert.equal(config.codeDropEveryMinutes, 120);
    // 2026-11-14, the owner: "add a 50m deposited in the last 3 days rule".
    assert.equal(config.codeDropMinDepositMinor, 50_000_000n);
    assert.equal(config.codeDropDepositWindowHours, 72);
  });

  it('can be tuned live from the System tab, under their own heading', () => {
    for (const key of [
      'codeDropsEnabled',
      'codeDropPrizeMinor',
      'codeDropMaxClaims',
      'codeDropWagerMultiplier',
      'codeDropEveryMinutes',
      'codeDropMinDepositMinor',
      'codeDropDepositWindowHours',
    ] as const) {
      assert.ok(key in runtimeSettingDefinitions, key);
      assert.equal(runtimeSettingDefinitions[key].group, 'codedrops');
    }
  });

  it('fall into fixed slots, the same whoever asks', () => {
    const slot = slotStartOf(new Date('2026-11-11T13:59:59.999Z'), 120);
    assert.equal(slot.toISOString(), '2026-11-11T12:00:00.000Z');
    assert.equal(slotStartOf(new Date('2026-11-11T14:00:00.000Z'), 120).toISOString(), '2026-11-11T14:00:00.000Z');
    assert.equal(slotStartOf(new Date('2026-11-11T14:44:00.000Z'), 30).toISOString(), '2026-11-11T14:30:00.000Z');
  });

  it('are eight characters without 0, 1, I or O, read back from any case, dash or spaces', () => {
    for (let index = 0; index < 200; index += 1) assert.match(generateDropCode(), /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(generateDropCode(() => 0), 'AAAAAAAA');
    assert.equal(normalizeDropCode('abcd-2345'), 'ABCD2345');
    assert.equal(normalizeDropCode(' ABCD 2345 '), 'ABCD2345');
    for (const bad of ['', 'ABCD234', 'ABCD-23450', 'ABCD-234O', 'ABCD-234I']) assert.equal(normalizeDropCode(bad), null, bad);
  });
});

describe('claiming one', () => {
  it('locks the drop, then raises the count only while it is under the limit, at READ COMMITTED', async () => {
    const source = await read('src/lib/code-drops.ts');
    assert.match(source, /BEGIN ISOLATION LEVEL READ COMMITTED/);
    assert.match(source, /FROM discord_code_drops WHERE code = \$1 FOR UPDATE/);
    assert.match(source, /UPDATE discord_code_drops SET claims = claims \+ 1\s+WHERE id = \$1 AND claims < max_claims RETURNING claims/);
    // The count is raised before anything is paid, and a refusal pays nothing.
    const raise = source.indexOf('SET claims = claims + 1');
    assert.ok(raise > 0 && raise < source.indexOf('INSERT INTO discord_code_drop_claims'));
    assert.ok(source.indexOf('INSERT INTO discord_code_drop_claims') < source.indexOf('await creditWallet('));
  });

  it('needs no wager to claim, and adds the drop’s own multiple to what must be wagered to withdraw', async () => {
    const source = await read('src/lib/code-drops.ts');
    assert.doesNotMatch(source, /wageredFrom|minWager|status: 'locked'/);
    assert.match(source, /const owed = requirementFor\(prize, Number\(drop\.wager_multiplier\)\);/);
    assert.match(source, /await creditWallet\(client, user\.id, prize, 'daily_code_reward', claimId\);\s+await addWagerRequirement\(client, user\.id, owed\);/);
  });

  it('is for a signed-in player with a linked, old-enough Discord, once per account and once per Discord', async () => {
    const source = await read('src/lib/code-drops.ts');
    assert.match(source, /if \(!user\.discord_user_id\) \{/);
    assert.match(source, /if \(!oldEnough\(config, user\.discord_user_id\)\) \{/);
    assert.match(source, /WHERE drop_id = \$1 AND \(user_id = \$2 OR discord_user_id = \$3\)/);
    const routes = await read('src/routes/discord-rewards.ts');
    assert.match(routes, /'\/v1\/discord\/codes\/redeem',\s*\{ preHandler: guards\.requireCsrf/);
    assert.match(routes, /return redeemCodeDrop\(db, config, \{ userId, code: body\.code, ip: request\.ip \}\);/);
    assert.doesNotMatch(routes, /daily-code\/redeem/);
  });

  /* 2026-11-13, the owner: "make drops one claim per network, so a second account on the same
   * connection gets refused" -- after Cpt_Ardian and .DashedWave65606 (one PC, a browser each) took
   * two of every drop's five places for eleven drops running. */
  it('is once per connection: the network is hashed, checked under the drop lock and kept on the claim', async () => {
    const source = await read('src/lib/code-drops.ts');
    assert.match(source, /const network = networkHash\(config, input\.ip\);\s+if \(!network\) return refused\('Your connection could not be checked\. Try again', true\);/);
    // Checked after the drop row is locked, so two claims from one connection cannot both pass.
    const lock = source.indexOf('WHERE code = $1 FOR UPDATE');
    const check = source.indexOf('SELECT 1 FROM discord_code_drop_claims WHERE drop_id = $1 AND network_hash = $2');
    assert.ok(lock > 0 && check > lock && check < source.indexOf('SET claims = claims + 1'));
    assert.match(source, /INSERT INTO discord_code_drop_claims \(id, drop_id, user_id, discord_user_id, prize_minor, wager_minor, network_hash\)/);
  });

  it('needs real deposits in the window, checked before a place is taken, and keeps the code when short', async () => {
    const source = await read('src/lib/code-drops.ts');
    // Deposits only: the /pay to the bot and the sign-in payment, never bonuses, tips or winnings.
    assert.match(source, /WHERE user_id = \$1 AND kind = ANY\(\$2::text\[\]\)\s+AND created_at > now\(\) - make_interval\(hours => \$3\)/);
    assert.match(source, /\[userId, \[\.\.\.DEPOSIT_KINDS\], config\.codeDropDepositWindowHours\]/);
    assert.match(source, /if \(deposited < needed\) return \{ result: refused\(depositRefusal\(config, deposited\), true\), paid: false \};/);
    const rule = source.indexOf('const deposited = await depositedRecently(client, config, user.id);');
    assert.ok(rule > source.indexOf('FOR UPDATE') && rule < source.indexOf('SET claims = claims + 1'));
    const stats = await read('src/lib/admin-stats.ts');
    assert.match(stats, /export const DEPOSIT_KINDS = \['cash_deposit', 'pay_login_deposit'\] as const;/);
    // The window says so before a code is typed, and offers the deposit.
    const routes = await read('src/routes/discord-rewards.ts');
    assert.match(routes, /codeDropDeposit: await codeDropDepositStatus\(db, config, userId\),/);
    const page = await read('../../DONUTDROP FRONTEND/Donut Drop/assets/js/redeem-code.js');
    assert.match(page, /if \(rule && !rule\.met\) \{\s+paintHead\(host, 'Deposit to unlock codes\.'\);/);
    assert.match(page, /document\.getElementById\('depositBtn'\)\?\.click\(\);/);
  });

  it('asks Cloudflare whether a person solved the challenge before anything is claimed, while Turnstile is on', async () => {
    const routes = await read('src/routes/discord-rewards.ts');
    const handler = routes.slice(routes.indexOf("'/v1/discord/codes/redeem'"));
    assert.match(handler, /if \(config\.turnstileEnabled\) \{\s+if \(!body\.turnstileToken\) throw new AppError\(400, 'CHALLENGE_REQUIRED'/);
    assert.ok(handler.indexOf('await verifyTurnstile(config, body.turnstileToken, request.ip);') < handler.indexOf('return redeemCodeDrop('));
    // The window draws the same widget as the sign-in card, and waits for a passed one.
    const page = await read('../../DONUTDROP FRONTEND/Donut Drop/assets/js/redeem-code.js');
    assert.match(page, /<div class="auth__challenge" id="rdmChallenge" hidden><\/div>/);
    assert.match(page, /const ready = \(\) => complete\(typed\) && \(!challengeRequired \|\| Boolean\(challengeToken\)\);/);
    assert.match(page, /token \? \{ code: typed, turnstileToken: token \} : \{ code: typed \}/);
  });

  it('copies the figures onto a drop when it is minted, so a change never touches a posted code', async () => {
    const source = await read('src/lib/code-drops.ts');
    assert.match(source, /INSERT INTO discord_code_drops\s+\(id, slot_start, code, prize_minor, max_claims, wager_multiplier, expires_at\)/);
    assert.match(source, /ON CONFLICT \(slot_start\) DO NOTHING/);
    assert.match(source, /const prize = BigInt\(drop\.prize_minor\);/);
  });
});

describe('the bot', () => {
  it('asks for the drop, posts it once, and reports the message, through signed internal routes', async () => {
    const routes = await read('src/routes/community-bot.ts');
    assert.match(routes, /'\/internal\/v1\/community\/code-drops\/tick'/);
    assert.match(routes, /'\/internal\/v1\/community\/code-drops\/message'/);
    const tick = routes.slice(routes.indexOf("'/internal/v1/community/code-drops/tick'"));
    assert.match(tick, /verifyCommunityBotSignature\(request, config\);\s+parseWith\(watchSchema, request\.body\);\s+return codeDropTick\(db, config\);/);
    const source = await read('src/lib/code-drops.ts');
    assert.match(source, /UPDATE discord_code_drops SET announced_at = now\(\)\s+WHERE slot_start = \$1 AND announced_at IS NULL/);
    assert.match(source, /UPDATE discord_code_drops SET announced_at = NULL WHERE id = \$1 AND message_id IS NULL/);
  });

  it('has no way to claim a code', async () => {
    const routes = await read('src/routes/community-bot.ts');
    assert.doesNotMatch(routes, /redeemCodeDrop|codes\/redeem/);
  });
});

describe('the migration', () => {
  it('only adds two tables, with the limit and the one-claim rules in the schema itself', async () => {
    const sql = await read('../../packages/db/migrations/092_code_drops.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER TABLE/i);
    assert.match(sql, /CREATE TABLE discord_code_drops \(/);
    assert.match(sql, /slot_start timestamptz NOT NULL UNIQUE,/);
    assert.match(sql, /code varchar\(8\) NOT NULL UNIQUE CHECK \(code ~ '\^\[A-HJ-NP-Z2-9\]\{8\}\$'\)/);
    assert.match(sql, /CHECK \(claims BETWEEN 0 AND max_claims\)/);
    assert.match(sql, /CREATE TABLE discord_code_drop_claims \(/);
    assert.match(sql, /UNIQUE \(drop_id, user_id\),\s+UNIQUE \(drop_id, discord_user_id\)/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE discord_code_drops TO donut_api_runtime;/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE discord_code_drop_claims TO donut_api_runtime;/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v92\(\) RETURNS boolean/);
  });

  it('094 adds the network to a claim, one per drop, and nothing else', async () => {
    const sql = await read('../../packages/db/migrations/094_code_drop_networks.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|^\s*UPDATE /im);
    assert.match(sql, /ALTER TABLE discord_code_drop_claims ADD COLUMN network_hash bytea;/);
    assert.match(sql, /CREATE UNIQUE INDEX discord_code_drop_claims_network_idx\s+ON discord_code_drop_claims \(drop_id, network_hash\)\s+WHERE network_hash IS NOT NULL;/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v94\(\) RETURNS boolean/);
  });
});
