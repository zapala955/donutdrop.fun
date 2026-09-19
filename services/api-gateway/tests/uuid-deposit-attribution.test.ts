import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * Deposits are attributed by Mojang UUID for Java players.
 *
 * The trap these tests exist for is an encoding mismatch. Account identities are stored as
 * `mc:<32 hex>` with no dashes, which is how Mojang's own API returns an id. mineflayer's player
 * list reports the dashed canonical form. Passing that through unchanged produces a lookup key
 * that can never equal a stored identity, and the failure is SILENT: every Java deposit simply
 * stops finding its owner and lands as `unlinked`. Nothing throws, nothing alerts, and the money
 * is only noticed missing when a player complains.
 */

const read = (rel: string) => readFile(path.resolve(import.meta.dirname, rel), 'utf8');
const gateway = () => read('../src/routes/minecraft-in.ts');
const worker = () => read('../../minecraft-bot/src/worker.ts');
const migration = () =>
  read('../../../packages/db/migrations/030_uuid_deposit_attribution.sql');

describe('java deposit attribution', () => {
  it('accepts the payer UUID in the same encoding the identity column stores', async () => {
    /* 32 hex, no dashes. If this ever becomes z.uuid() it will demand the dashed form and the
     * lookup below can never match. */
    const source = await gateway();
    const block = source.slice(source.indexOf('cashPaymentEvent'));
    const schema = block.slice(0, block.indexOf('const botEventSchema'));
    assert.match(schema, /payerUuid/);
    assert.match(schema, /\/\^\[a-f0-9\]\{32\}\$\//);
    assert.doesNotMatch(schema, /payerUuid:\s*normalizedUuid/);
    assert.doesNotMatch(schema, /payerUuid:\s*z\.uuid\(\)/);
  });

  it('emits the payer UUID with its dashes stripped', async () => {
    const source = await worker();
    const fn = source.slice(source.indexOf('private javaUuidFor'));
    const body = fn.slice(0, fn.indexOf('private async reportPayment'));
    assert.match(body, /replaceAll\('-', ''\)/);
    assert.match(body, /\/\^\[0-9a-f\]\{32\}\$\//);
  });

  it('looks the account up by identity, with the name only as a fallback', async () => {
    const source = await gateway();
    const fn = source.slice(source.indexOf('async function processCashPaymentObserved'));
    assert.match(fn, /minecraft_identity = \$1/);
    assert.match(fn, /`mc:\$\{event\.payerUuid\}`/);
    /* The fallback has to survive: the bot cannot always supply a UUID, and a deposit that cannot
     * be attributed by UUID must still reach a linked player rather than being dropped. */
    assert.match(fn, /normalized_username = lower\(\$1\)/);
  });

  it('never attributes a Bedrock payer by UUID', async () => {
    /* A Floodgate player's identity here is `bedrock:<name>`, because the payment receipt cannot
     * see their Floodgate UUID. Matching the player-list one would give a single Bedrock player
     * two identities and therefore two accounts. */
    const source = await worker();
    const fn = source.slice(source.indexOf('private javaUuidFor'));
    const body = fn.slice(0, fn.indexOf('private async reportPayment'));
    assert.match(body, /payer\.startsWith\('\.'\)/);
    assert.match(body, /startsWith\('000000000000000'\)/);
  });

  it('records which key credited the deposit', async () => {
    const source = await gateway();
    assert.match(source, /attributedBy = event\.payerUuid \? 'uuid' : 'username'/);
    const sql = await migration();
    assert.match(sql, /attributed_by/);
    /* A credited receipt must say how it found its owner; anything else may leave it null. */
    assert.match(sql, /status <> 'credited' OR attributed_by IS NOT NULL/);
  });

  it('keeps the UUID optional on the wire', async () => {
    /* The bot and the gateway are separate containers and are briefly different versions during a
     * deploy. A required field would reject every receipt sent by the older side. */
    const source = await gateway();
    const block = source.slice(source.indexOf('cashPaymentEvent'));
    const schema = block.slice(0, block.indexOf('const botEventSchema'));
    assert.match(schema, /\.optional\(\)/);
    const api = await read('../../minecraft-bot/src/api-client.ts');
    /* Omitted rather than sent as null: the request signature covers the canonical body, so an
     * explicit null is a different signed payload from an absent field. */
    assert.match(api, /payerUuid === undefined \? \{\} : \{ payerUuid \}/);
  });
});

describe('uuid encoding, end to end', () => {
  it('a dashed player-list uuid becomes a key that matches a stored identity', () => {
    /* The whole bug, reproduced as arithmetic rather than as prose. */
    const fromPlayerList = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';
    const storedIdentity = 'mc:a0eebc999c0b4ef8bb6d6bb9bd380a11';

    const naive = `mc:${fromPlayerList.toLowerCase()}`;
    assert.notEqual(naive, storedIdentity, 'passing the dashed form through cannot match');

    const correct = `mc:${fromPlayerList.toLowerCase().replaceAll('-', '')}`;
    assert.equal(correct, storedIdentity);
    assert.match(correct, /^mc:[a-f0-9]{32}$/);
  });
});
