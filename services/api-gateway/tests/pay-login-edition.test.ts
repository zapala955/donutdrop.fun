import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MINECRAFT_USERNAME_PATTERN } from '../src/lib/minecraft-username.js';

/* 2026-10-27: the sign-in card had an "I play Bedrock" checkbox that put a dot before the name.
 * Players ticked it without reading (or missed it on Bedrock), the login waited for ".steve" while
 * "Steve" paid, and it expired with their payment spent. The payment now decides the edition. */

const repo = path.resolve(import.meta.dirname, '../../..');
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');

describe('signing in by payment, Java or Bedrock', () => {
  it('matches the payment to the login without the Bedrock dot, and keeps the payer\'s real name', async () => {
    const source = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const fn = source.slice(source.indexOf('async function processPaymentObserved'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // The amount still has to match: it is the one-time secret.
    assert.match(body, /AND ltrim\(normalized_username, '\.'\) = ltrim\(lower\(\$2\), '\.'\) AND pay_amount = \$3/);
    assert.doesNotMatch(body, /AND normalized_username = lower\(\$2\)/);
    // The account signed in is the one that paid: the status request resolves it from this name.
    // Cast, or PostgreSQL deduces varchar and text for the one parameter and refuses the statement;
    // postgres.integration.test.ts runs it against a real server.
    assert.match(body, /SET observed_payment_at = now\(\), requested_username = \$2::text,\s+normalized_username = lower\(\$2::text\)/);
  });

  it('asks nobody which edition they play, and takes a name with or without the dot', async () => {
    const app = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js');
    assert.doesNotMatch(app, /id="linkBedrock"|#linkBedrock/);
    const rule = /const MINECRAFT_NAME = (\/.+\/);/.exec(app)?.[1];
    assert.equal(rule, String(MINECRAFT_USERNAME_PATTERN), 'the card and the server accept the same names');
    // What was typed is what is sent: no dot added or taken away on the way.
    assert.match(app, /const username = typedName\(\);/);
  });
});
