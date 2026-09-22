import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * Two bots: a teller the players can see, and a vault they cannot.
 *
 * The entire point of the split is that the account holding the float is never named anywhere a
 * player can reach it. Most of what is asserted here is therefore about where a username is
 * allowed to come from, which is not something a unit test of one function can see.
 */
describe('the vault never introduces itself', () => {
  /* Three endpoints answer with a bot username: the deposit screen, the login card and the
   * withdrawal it arrives from. Each has to ask for the teller BY ROLE. Picking "whichever bot is
   * online" would put the vault's name on a deposit screen the first time the teller blinked. */
  it('asks for a teller by role everywhere a username reaches a player', async () => {
    for (const file of [
      'services/api-gateway/src/routes/cash-deposits.ts',
      'services/api-gateway/src/routes/auth-pay.ts',
      'services/api-gateway/src/routes/cash-withdrawals.ts',
    ]) {
      const source = await read(file);
      assert.match(source, /pickBot\(\w+, config, 'teller'\)/, `${file} does not ask for a teller`);
      /* And none of them may still be hand-rolling the "any online bot" query the role lookup
       * replaced, because that query cannot tell the two accounts apart. */
      assert.doesNotMatch(
        source,
        /FROM bot_accounts\s+WHERE id = ANY\(\$1::uuid\[\]\) AND status = 'online'/,
        `${file} still selects a bot without filtering on its role`,
      );
    }
  });

  it('only ever sends the vault username to another bot, never to a browser', async () => {
    const bots = await read('services/api-gateway/src/lib/bots.ts');
    // findVaultBot is the only way to reach the vault, and only job payloads consume it.
    const consumers = await Promise.all([
      read('services/api-gateway/src/routes/cash-withdrawals.ts'),
      read('services/api-gateway/src/lib/bots.ts'),
    ]);
    assert.match(bots, /export async function findVaultBot/);
    for (const source of consumers) {
      const uses = source.split('findVaultBot').length - 1;
      if (!uses) continue;
      // Every use feeds a bot_jobs payload. A reply body would name it in a response instead.
      assert.match(source, /bot_jobs/, 'the vault was looked up outside a job payload');
    }
  });
});

describe('where a withdrawal takes its money from', () => {
  const route = () => read('services/api-gateway/src/routes/cash-withdrawals.ts');

  /* The single-bot deployment is the one every existing installation is running today, and it has
   * to keep working untouched the moment this ships -- before anybody has created a second
   * Minecraft account. */
  it('pays directly when no vault is provisioned, exactly as before', async () => {
    const source = await route();
    const queue = source.slice(source.indexOf('export async function queueWithdrawalJob'));
    assert.match(queue, /if \(!vault\) \{\s*await payPlayerDirectly\(\);\s*return;\s*\}/);
  });

  it('pays from the float without waking the vault when the float covers it', async () => {
    const source = await route();
    const queue = source.slice(source.indexOf('export async function queueWithdrawalJob'));
    assert.match(queue, /if \(held >= amount\)/);
    assert.match(queue, /funding = 'float'/);
  });

  /* The teller's row is read for a decision about money, so two withdrawals arriving together
   * must not both conclude the float covers them. */
  it('locks the teller before reading the balance it is about to spend', async () => {
    const source = await route();
    const queue = source.slice(source.indexOf('export async function queueWithdrawalJob'));
    const read_ = queue.indexOf('FROM bot_accounts WHERE id = $1 FOR UPDATE');
    const decide = queue.indexOf('if (held >= amount)');
    assert.ok(read_ > 0, 'the teller balance is read without a row lock');
    assert.ok(decide > read_, 'the float decision is made before the row is locked');
  });

  /* The release covers the payout AND puts the teller back on its float, so a run of withdrawals
   * does not mean a trip to the vault for every one of them. */
  it('releases enough to pay out and restore the float', async () => {
    const source = await route();
    assert.match(source, /const release = amount \+ config\.tellerFloatTargetMinor - held;/);
  });

  /* A queued job waits for its bot. That is what turns "the vault is offline" into a delay rather
   * than a refusal, and the player's balance is already debited by this point. */
  it('queues the release whether or not the vault is online', async () => {
    const source = await route();
    const queue = source.slice(source.indexOf('export async function queueWithdrawalJob'));
    assert.match(queue, /findVaultBot/);
    assert.doesNotMatch(queue, /status = 'online'/);
    assert.match(queue, /status = 'awaiting_vault'/);
  });

  it('delays the player hop behind the vault hop rather than firing both at once', async () => {
    const source = await route();
    const chain = source.slice(source.indexOf('queueWithdrawalPayoutAfterRelease'));
    assert.match(chain, /available_at\) *\n?.*VALUES.*now\(\) \+ \(\$5::integer \* interval '1 second'\)/s);
    assert.match(chain, /config\.withdrawalHopDelaySeconds/);
    // The player hop only exists once the vault hop has actually confirmed.
    assert.match(chain, /WHERE id = \$1 AND status = 'awaiting_vault'/);
  });
});

describe('the bot money ledger', () => {
  it('books a sweep on both sides, because only one of them reports it', async () => {
    const source = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const book = source.slice(source.indexOf('async function bookInternalTransfer'));
    const sender = book.indexOf("direction: 'out'");
    const recipient = book.indexOf("direction: 'in'");
    assert.ok(sender > 0 && recipient > sender, 'an internal transfer books only one side');
  });

  /* The receiving bot reports the sweep arriving as an ordinary payment. Without this it would be
   * looked up against `users` -- and a bot's in-game name is a real Minecraft name, so if anybody
   * ever signed in with the account the vault runs on, the platform's own float would be credited
   * to them as a deposit. */
  it('refuses to credit a payment that came from one of our own bots', async () => {
    const source = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const handler = source.slice(source.indexOf('async function processCashPaymentObserved'));
    const guard = handler.indexOf('FROM bot_accounts WHERE lower(username) = lower($1)');
    const lookup = handler.indexOf('SELECT id FROM users WHERE normalized_username');
    assert.ok(guard > 0, 'an internal payment is not recognised as internal');
    assert.ok(lookup > guard, 'the player lookup happens before the internal-sender guard');
    assert.match(handler, /'internal_transfer'/);
  });

  it('is append-only in the database, like every other money log here', async () => {
    const migration = await read('packages/db/migrations/044_teller_and_vault_bots.sql');
    assert.match(migration, /CREATE TRIGGER bot_transfers_append_only/);
    assert.match(migration, /EXECUTE FUNCTION reject_mutation\(\)/);
  });

  /* Drift is ordinary: somebody pays the bot by hand, a receipt is missed while it is offline. A
   * CHECK would turn that into a constraint violation inside the settlement of a real payout. */
  it('does not constrain the tracked balance to be positive', async () => {
    const migration = await read('packages/db/migrations/044_teller_and_vault_bots.sql');
    const column = migration.slice(migration.indexOf('tracked_balance_minor'));
    assert.doesNotMatch(column.slice(0, 200), /CHECK \(tracked_balance_minor >= 0\)/);
  });

  it('corrects drift by writing a row rather than overwriting the figure', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const reconcile = admin.slice(admin.indexOf("'/v1/admin/bots/:id/reconcile'"));
    assert.match(reconcile, /reason: 'adjustment'/);
    assert.doesNotMatch(
      reconcile.slice(0, reconcile.indexOf('appendAudit')),
      /SET tracked_balance_minor = \$2/,
      'reconciliation overwrites the balance instead of booking the difference',
    );
  });
});

describe('managing the two bots', () => {
  it('refuses to leave the platform without a teller', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const role = admin.slice(admin.indexOf("'/v1/admin/bots/:id/role'"));
    assert.match(role, /LAST_TELLER/);
    assert.match(role, /WHERE role = 'teller' AND id <> \$1/);
  });

  it('audits a role change with its before and after', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const role = admin.slice(admin.indexOf("'/v1/admin/bots/:id/role'"));
    assert.match(role, /action: 'bot\.role'/);
    assert.match(role, /from: bot\.role, to: body\.role/);
  });

  it('starts every existing deployment as teller-only, which is a working state', async () => {
    const migration = await read('packages/db/migrations/044_teller_and_vault_bots.sql');
    assert.match(migration, /role varchar\(8\) NOT NULL DEFAULT 'teller'/);
  });
});
