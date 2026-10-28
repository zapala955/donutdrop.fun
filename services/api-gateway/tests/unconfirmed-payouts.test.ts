import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeUnconfirmedPayout } from '../src/lib/unconfirmed-payouts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = async (relative: string) =>
  (await readFile(path.join(here, '..', relative), 'utf8')).replace(/\r\n/g, '\n');

const judge = (tracked: bigint, readingLow: bigint, amount: bigint, readingStep = 1n) =>
  judgeUnconfirmedPayout({ tracked, readingLow, readingStep, amount });

/* Every unanswered payout of 2026-10-28, with the books and the first /bal after it. All five were
 * settled by hand as unpaid, and the balance agreed every time. */
describe('reading an unanswered payout off the next /bal', () => {
  it('calls the real cases of 10-28 unpaid', () => {
    // .AHMETXD3957, 1M at 11:12: $1,848 of small payments arrived while the bot was out.
    assert.equal(judge(439_028_146n, 439_029_994n, 1_000_000n), 'not_paid');
    // cpvptuurtje1, 289,172 at 11:35: $1,252 arrived meanwhile.
    assert.equal(judge(437_968_537n, 437_969_789n, 289_172n), 'not_paid');
    // _mapz, 9,389,747 at 12:15: the books and the balance matched to the dollar.
    assert.equal(judge(455_629_833n, 455_629_833n, 9_389_747n), 'not_paid');
    // .JaskiratS3745, 13,000 at 12:34.
    assert.equal(judge(560_106_810n, 560_106_810n, 13_000n), 'not_paid');
  });

  it('calls it paid when the balance is the books less the payout', () => {
    assert.equal(judge(459_750_439n, 450_360_692n, 9_389_747n), 'paid');
    // With a few hundred dollars of unbooked deposits on top.
    assert.equal(judge(37_371_906n, 37_312_606n, 60_000n), 'paid');
  });

  it('leaves anything that fits neither to an operator', () => {
    // Halfway between: some other money moved too.
    assert.equal(judge(100_000_000n, 95_000_000n, 10_000_000n), 'unclear');
    // A missed 100M receipt would make a paid 1M payout look like neither.
    assert.equal(judge(100_000_000n, 199_000_000n, 1_000_000n), 'unclear');
    // The tolerance is capped: a 9.4M payout is not "unpaid" when the balance is 1M over the books.
    assert.equal(judge(455_629_833n, 456_629_833n, 9_389_747n), 'unclear');
    // A quarter of a small payout: 13,000 tolerates 3,250 and no more.
    assert.equal(judge(560_106_810n, 560_110_060n, 13_000n), 'not_paid');
    assert.equal(judge(560_106_810n, 560_110_061n, 13_000n), 'unclear');
  });

  it('never decides from an abbreviated balance', () => {
    assert.equal(judge(1_200_000_000n, 1_200_000_000n, 9_389_747n, 10_000_000n), 'unclear');
  });
});

describe('the teller sweeper', () => {
  it('decides an unanswered payout before it corrects anything, and corrects nothing while one is open', async () => {
    const source = await read('src/lib/teller-sweeper.ts');
    const tick = source.slice(source.indexOf('const tick = async'), source.indexOf('const timer = setInterval'));
    const open = tick.indexOf('const open = await openUnconfirmedPayouts(client, teller.id);');
    const drift = tick.indexOf('const drift = reading.correctedTo - reading.tracked;');
    assert.ok(open > 0 && drift > open, 'the open payouts must be looked at before the drift correction');
    const gate = tick.slice(open, drift);
    // Any open payout returns before the correction, decided or not.
    assert.match(gate, /if \(open\.length > 0\) \{/);
    assert.match(gate, /if \(open\.length !== 1 \|\| !only \|\| !only\.readingAfter\) return undefined;/);
    assert.match(gate, /if \(verdict === 'unclear'\) return undefined;/);
    assert.match(gate, /return \{ botId: teller\.id, payout: only, verdict, reading \};/);
    // The verdict is applied in a transaction of its own, after the one holding the bot row.
    assert.match(tick, /if \(decided\) \{\s*await db\.transaction\(\(client\) =>\s*settleUnconfirmedPayout\(/);
  });
});

describe('settling an unanswered payout', () => {
  it('only touches a withdrawal still waiting for an operator, and settles it as the buttons do', async () => {
    const source = await read('src/lib/unconfirmed-payouts.ts');
    const settle = source.slice(source.indexOf('export async function settleUnconfirmedPayout('));
    assert.match(settle, /SELECT status, error_code FROM cash_withdrawals WHERE id = \$1 FOR UPDATE/);
    assert.match(
      settle,
      /if \(!row \|\| row\.status !== 'manual_review' \|\| row\.error_code !== 'PAYOUT_UNCONFIRMED'\) return;/,
    );
    // Paid: marked paid and booked on the bot under the job, like a confirmed payout.
    assert.match(settle, /reason: 'withdrawal',\s*referenceId: payout\.jobId \?\? payout\.withdrawalId,/);
    // Not paid: the one refund path, which cannot run twice.
    assert.match(settle, /await refundWithdrawal\(client, payout\.withdrawalId, 'BALANCE_SHOWS_NOT_PAID'\);/);
    assert.match(settle, /action: `cash_withdrawal\.auto_resolve\.\$\{verdict\}`/);
  });

  it('waits only for evidence taken after the payout went unanswered, and not forever', async () => {
    const source = await read('src/lib/unconfirmed-payouts.ts');
    assert.match(source, /b\.observed_balance_at > w\.updated_at AS reading_after/);
    assert.match(source, /w\.status = 'manual_review' AND w\.error_code = 'PAYOUT_UNCONFIRMED'/);
    assert.match(source, /w\.updated_at > now\(\) - make_interval\(mins => \$2::integer\)/);
    assert.match(source, /export const UNCONFIRMED_EVIDENCE_WINDOW_MINUTES = 30;/);
  });
});
