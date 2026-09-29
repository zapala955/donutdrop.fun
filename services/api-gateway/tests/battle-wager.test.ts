import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const route = () =>
  readFile(path.resolve(import.meta.dirname, '../src/routes/battles.ts'), 'utf8');

describe('battle wagers', () => {
  it('never counts a stake that can still be refunded', async () => {
    const source = await route();
    /* takeSeat runs on host and join, and a seat can be left with a full refund until the battle
     * runs. Recording the wager there let host-and-leave farm rakeback, VIP, referral milestones
     * and wager-requirement credit on money that was always handed back. */
    const takeSeat = source.slice(source.indexOf('async function takeSeat('));
    assert.doesNotMatch(takeSeat, /recordWager\(/);
    // Leaving still refunds, so it must stay outside anything that records a wager.
    const leave = source.slice(source.indexOf("'/v1/battles/:code/leave'"), source.indexOf('async function takeSeat('));
    assert.doesNotMatch(leave, /recordWager\(/);
  });

  it('counts each human seat once, when the battle settles', async () => {
    const source = await route();
    const settle = source.slice(source.indexOf('async function settleBattle('), source.indexOf('/* ─────────────────────────── REST'));
    // After the idempotency guard, so a replayed settlement records nothing.
    assert.ok(settle.indexOf("if (battle.status === 'settled') return;") < settle.indexOf('recordWager('));
    assert.match(settle, /if \(seat\.is_bot \|\| !seat\.user_id \|\| stake <= 0n\) continue;/);
    assert.match(settle, /const reference = deterministicUuid\('battle_wager', battleId, seat\.seat\);/);
    // A seat counted at join time before the fix is not counted again.
    assert.match(settle, /SELECT 1 FROM wager_events WHERE source = 'case' AND reference_id = \$1/);
    assert.match(settle, /recordWager\(client, config, seat\.user_id, stake, 'case', reference, \['cases_opened'\]\)/);
    assert.equal(source.split('recordWager(').length - 1, 1);
  });
});
