import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('the invite signup bonus', () => {
  it('pays a live invite $10M at signup in place of the ordinary bonus, which everybody else still gets', async () => {
    const auth = await read('services/api-gateway/src/routes/auth.ts');
    // Bound and not voided for sharing the inviter's network: that is an invite.
    assert.match(auth, /invited = Boolean\(bound\.rowCount\) && !standing\.sharedNetwork;/);
    // The invite bonus, at its own multiplier; else the ordinary one, unchanged.
    assert.match(
      auth,
      /if \(rewardable && invited && config\.referralSignupBonusMinor > 0n\) \{[\s\S]{0,500}const bonusWager = requirementFor\(config\.referralSignupBonusMinor, config\.referralSignupBonusWagerMultiplier\);\s*await creditWallet\(client, row\.id, config\.referralSignupBonusMinor, 'signup_bonus', row\.id\);\s*await addWagerRequirement\(client, row\.id, bonusWager\);[\s\S]{0,300}'UPDATE referrals SET signup_bonus_minor = \$2 WHERE referee_id = \$1',\s*\[row\.id, config\.referralSignupBonusMinor\.toString\(\)\],\s*\);\s*\} else if \(rewardable && config\.signupBonusMinor > 0n\) \{\s*await creditWallet\(client, row\.id, config\.signupBonusMinor, 'signup_bonus', row\.id\);\s*await addWagerRequirement\(\s*client,\s*row\.id,\s*requirementFor\(config\.signupBonusMinor, config\.signupBonusWagerMultiplier\),/,
    );
  });

  /* Not counted toward the inviter's milestone since 2026-11-09. Until 11-14 by a fixed $100M bucket
   * (migration 089); since then by the owner's rule "make sure they have to wager 100m with their
   * own deposited money": each bet counts by the share of the balance that is the invitee's own. */
  it('is not counted toward the inviter\'s milestone: only bets made with deposited money count (2026-11-14)', async () => {
    const [lib, migration, routes, referrals] = await Promise.all([
      read('services/api-gateway/src/lib/referrals.ts'),
      read('packages/db/migrations/095_referral_own_money.sql'),
      read('services/api-gateway/src/routes/referrals.ts'),
      front('assets/js/referrals.js'),
    ]);
    // The share: all bonus at the bonus; each later deposit leaves balance-before / balance-after of it.
    assert.match(lib, /AND t\.seq > \(SELECT min\(b\.seq\) FROM wallet_transactions b WHERE b\.user_id = \$1 AND b\.kind = 'signup_bonus'\)/);
    assert.match(lib, /share = \(share \* \(after - BigInt\(row\.amount_minor\)\)\) \/ after;/);
    assert.match(lib, /own = \(counted \* \(PPM - bonusShare\)\) \/ PPM;\s*\}\s*const wageredAfter = BigInt\(referral\.wagered_minor\) \+ own;/);
    assert.doesNotMatch(lib, /signup_bonus_wager_left_minor/);
    // The migration marks the $10M invites, recounts those in progress without lowering anybody,
    // and retires the bucket.
    assert.match(migration, /ADD COLUMN signup_bonus_minor bigint NOT NULL DEFAULT 0/);
    assert.match(migration, /WHERE t\.user_id = r\.referee_id AND t\.kind = 'signup_bonus' AND t\.amount_minor = 10000000/);
    assert.match(migration, /WHERE r\.referee_id = c\.referee_id AND c\.own_minor > r\.wagered_minor;/);
    assert.match(migration, /UPDATE referrals SET signup_bonus_wager_left_minor = 0/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v95\(\) RETURNS boolean/);
    // The inviter is told what counts, in as many words, on the page and on each invite.
    assert.match(routes, /ownMoneyOnly: BigInt\(row\.signup_bonus_minor\) > 0n,/);
    assert.match(referrals, /return state\.promotions\?\.referralSignupBonus \? ' of their own deposited money' : '';/);
    assert.match(referrals, /\$\{invite\.ownMoneyOnly \? 'own money wagered' : 'wagered'\}/);
    assert.doesNotMatch(referrals, /Clearing their bonus|'Not counted'/);
  });

  it('is a live setting, $10M at 10x by default, and public for a visitor', async () => {
    const [settings, config, promotions] = await Promise.all([
      read('services/api-gateway/src/lib/runtime-settings.ts'),
      read('services/api-gateway/src/config.ts'),
      read('services/api-gateway/src/routes/promotions.ts'),
    ]);
    for (const key of ['referralSignupBonusMinor', 'referralSignupBonusWagerMultiplier']) {
      assert.match(settings, new RegExp(`  ${key}: \\{`), key);
    }
    assert.match(config, /REFERRAL_SIGNUP_BONUS_MINOR: nonNegativeBigintString\.default\('10000000'\)/);
    assert.match(config, /REFERRAL_SIGNUP_BONUS_WAGER_MULTIPLIER: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(100\)\.default\(10\)/);
    assert.match(promotions, /referralSignupBonus:\s*config\.referralsEnabled && config\.referralSignupBonusMinor > 0n/);
  });

  it('is what a referral link shows: the sign-in window, the lobby banner and the invite page', async () => {
    const [app, referrals] = await Promise.all([front('assets/js/app.js'), front('assets/js/referrals.js')]);
    assert.match(app, /const invite = state\.promotions\?\.referralSignupBonus;\s*const code = \$\('#linkRef', body\)/);
    assert.match(app, /referral\.addEventListener\('input', paintBonus\);/);
    assert.match(app, /const invite = signedOut && pendingReferralCode\(\) \? state\.promotions\?\.referralSignupBonus : null;/);
    assert.match(referrals, /\['Your friend gets', `\$\{money\(Number\(invite\.amountMinor\)\)\} signup bonus`\]/);
  });
});
