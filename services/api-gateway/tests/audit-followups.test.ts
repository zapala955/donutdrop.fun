import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * Follow-ups from the security review. Each one guards a property that is invisible at runtime:
 * the code keeps working when they regress, it just stops protecting anything.
 */

const read = (rel: string) => readFile(path.resolve(import.meta.dirname, rel), 'utf8');
const app = () => read('../src/app.ts');
const social = () => read('../src/routes/social.ts');
const admin = () => read('../src/routes/admin.ts');
const chat = () => read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js');

describe('rate-limit bucket keys', () => {
  it('verifies the cookie signature before using it as a key', async () => {
    /* Reading it raw made every limit on the API bypassable: any attacker-chosen string is a
     * distinct bucket, so a fresh random cookie per request bought a fresh budget each time. */
    const source = await app();
    const fn = source.slice(source.indexOf('keyGenerator(request)'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /request\.unsignCookie\(raw\)/);
    assert.match(body, /unsigned\.valid/);
    /* The hash must be of the UNSIGNED value. Hashing the raw cookie inside the valid branch would
     * pass this file's other assertions and still be keyed on attacker-controlled bytes. */
    assert.match(body, /update\(unsigned\.value\)/);
    assert.doesNotMatch(body, /update\(raw\)/);
  });

  it('falls back to the address when the cookie is absent or unsigned', async () => {
    const source = await app();
    const fn = source.slice(source.indexOf('keyGenerator(request)'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /return 'ip:' \+ request\.ip/);
  });
});

describe('tips', () => {
  it('prefers an id over a name when the caller has one', async () => {
    /* Clicking a head means "that person", not "whoever is called that now". */
    const source = await social();
    assert.match(source, /toUserId: z\.uuid\(\)\.optional\(\)/);
    const handler = source.slice(source.indexOf('const target = body.toUserId'));
    assert.match(handler.slice(0, 400), /WHERE id = \$1 AND status = 'active'/);
  });

  it('still accepts a name, because the typed command only has one', async () => {
    /* `/tip <name> 5m` is a real command and somebody typing a name means whoever holds it. */
    const source = await social();
    assert.match(source, /toUsername: z\.string\(\)/);
    assert.match(source, /normalized_username = lower\(\$1::varchar\) AND status = 'active'/);
  });

  it('sends the id from the avatar path and not from the command', async () => {
    const source = await chat();
    assert.match(source, /\.\.\.\(userId \? \{ toUserId: userId \} : \{\}\)/);
    /* The sheet knows an id; the parsed command deliberately passes none. */
    assert.match(source, /sendTip\(username, amount, undefined, userId\)/);
  });
});

describe('the balance adjustment ceiling', () => {
  it('describes the limit its regex actually imposes', async () => {
    /* The comment claimed a hundred million. The regex allows thirteen digits — just under ten
     * trillion — on the one endpoint where a reader most needs the stated limit to be true. */
    const source = await admin();
    const block = source.slice(
      source.indexOf('const balanceAdjustSchema') - 900,
      source.indexOf('const adminPaySchema'),
    );
    assert.match(block, /\^-\?\[1-9\]\\d\{0,12\}\$/);
    assert.doesNotMatch(block, /hundred million/);
    assert.match(block, /ten trillion/);
  });

  it('still guards the thing that actually matters', async () => {
    /* The ceiling is a typo backstop. The control is that every move is on the ledger and named. */
    const source = await admin();
    const endpoint = source.slice(source.indexOf("'/v1/admin/users/:id/balance'"));
    assert.match(endpoint, /INSERT INTO wallet_transactions/);
    assert.match(endpoint, /appendAudit/);
  });
});
