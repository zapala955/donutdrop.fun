import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* 2026-10-24: creators in media test mode opened the invite page, which minted a code for their
 * play-money twin. They shared that link, real players signed up under the twin, and two $50M
 * bonuses and every commission after them landed in play money. A twin is never anybody's inviter:
 * the page shows the creator's own programme, and a twin's code binds the creator behind it. */

const source = async (relative: string) =>
  (await readFile(path.resolve(import.meta.dirname, '../src', relative), 'utf8')).replace(
    /\r\n/g,
    '\n',
  );

describe('a creator in media test mode', () => {
  it("sees and shares their own invite code, never the twin's", async () => {
    const routes = await source('routes/referrals.ts');
    const dashboard = routes.slice(routes.indexOf("app.get('/v1/referrals',"));
    const handler = dashboard.slice(0, dashboard.indexOf('ensureReferralCode'));
    assert.match(handler, /const userId = requireUserId\(accountId\(request\.authUser\)\);/);
  });

  it("binds a twin's code, typed in or signed up with, to the creator behind it", async () => {
    for (const file of ['routes/referrals.ts', 'routes/auth.ts']) {
      const text = await source(file);
      assert.match(
        text,
        /SELECT coalesce\(u\.demo_of, c\.user_id\) AS user_id[\s\S]{0,120}FROM referral_codes c JOIN users u ON u\.id = c\.user_id\s+WHERE c\.code = \$1/,
        file,
      );
      // The old lookup handed back whoever owned the row, twin or not.
      assert.doesNotMatch(text, /SELECT (c\.)?user_id[^]{0,80}FROM referral_codes( c)?\s+WHERE (c\.)?code = \$1/, file);
    }
  });
});
