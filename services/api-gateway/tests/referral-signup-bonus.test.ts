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
      /if \(!existing\.rows\[0\] && invited && config\.referralSignupBonusMinor > 0n\) \{[\s\S]{0,500}await creditWallet\(client, row\.id, config\.referralSignupBonusMinor, 'signup_bonus', row\.id\);\s*await addWagerRequirement\(\s*client,\s*row\.id,\s*requirementFor\(config\.referralSignupBonusMinor, config\.referralSignupBonusWagerMultiplier\),\s*\);\s*\} else if \(!existing\.rows\[0\] && config\.signupBonusMinor > 0n\) \{\s*await creditWallet\(client, row\.id, config\.signupBonusMinor, 'signup_bonus', row\.id\);\s*await addWagerRequirement\(\s*client,\s*row\.id,\s*requirementFor\(config\.signupBonusMinor, config\.signupBonusWagerMultiplier\),/,
    );
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
