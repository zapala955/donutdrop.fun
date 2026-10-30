import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { pickRtpSlot } from '../src/worker.js';

/* 2026-10-28: logins kept landing on a region that was restarting, because the server puts a player
 * back where they logged out. The owner asked for an /rtp on every join to move the bot off it, and
 * for the bot to respawn by itself if wherever it lands kills it. */

const source = async () =>
  (await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

describe('the /rtp menu', () => {
  it('takes the overworld by its label', () => {
    assert.equal(
      pickRtpSlot([
        { slot: 11, name: 'grass_block', label: 'Overworld' },
        { slot: 13, name: 'netherrack', label: 'Nether' },
        { slot: 15, name: 'end_stone', label: 'The End' },
      ]),
      11,
    );
    assert.equal(pickRtpSlot([{ slot: 4, name: 'compass', label: 'Random teleport: OVERWORLD' }]), 4);
  });

  it('falls back to a grass block, but never one labelled for the nether or the end', () => {
    assert.equal(pickRtpSlot([{ slot: 2, name: 'grass_block', label: 'Grass Block' }]), 2);
    assert.equal(pickRtpSlot([{ slot: 2, name: 'grass_block', label: 'Nether' }]), undefined);
    assert.equal(pickRtpSlot([{ slot: 2, name: 'grass_block', label: 'The End' }]), undefined);
  });

  it('takes nothing from a menu it does not recognise', () => {
    assert.equal(pickRtpSlot([]), undefined);
    assert.equal(
      pickRtpSlot([
        { slot: 13, name: 'netherrack', label: 'Nether' },
        { slot: 15, name: 'end_stone', label: 'End' },
      ]),
      undefined,
    );
  });
});

describe('the /rtp on joining', () => {
  it('is sent once per session, shortly after spawning', async () => {
    const text = await source();
    const spawn = text.slice(text.indexOf("bot.once('spawn', () => {"));
    const body = spawn.slice(0, spawn.indexOf("bot.on('windowOpen'"));
    assert.match(body, /this\.teleporting = true;/);
    assert.match(body, /this\.randomTeleport\(bot, connectionController\);\s*\}, RTP_AFTER_SPAWN_MS\);/);
    // The first /bal now waits for the teleport rather than going at a fixed eight seconds.
    assert.doesNotMatch(body, /this\.balanceSoon\(8_000\);/);
    const rtp = text.slice(text.indexOf('private randomTeleport('));
    const rtpBody = rtp.slice(0, rtp.indexOf('\n  }\n'));
    assert.equal(rtpBody.match(/this\.sendCommand\(bot, '\/rtp'\);/g)?.length, 1);
  });

  it('holds back the balance and every job until the teleport has settled', async () => {
    const text = await source();
    const rtp = text.slice(text.indexOf('private randomTeleport('));
    const rtpBody = rtp.slice(0, rtp.indexOf('\n  }\n'));
    assert.match(rtpBody, /this\.teleporting = false;\s*this\.balanceSoon\(0\);\s*\}, RTP_SETTLE_MS\);/);
    const gate = text.slice(text.indexOf('private captureJobClaimState()'));
    assert.match(gate.slice(0, 3000), /this\.teleporting\s*\? 'teleporting'/);
    const balance = text.slice(text.indexOf('private requestBalance()'));
    assert.match(
      balance.slice(0, 800),
      /if \(this\.pendingPayout \|\| this\.payoutPreparing \|\| this\.transferring \|\| this\.teleporting\) \{/,
    );
    // A session that ends mid-teleport does not leave the next one held.
    const end = text.slice(text.indexOf("bot.once('end', (reason) => {"));
    assert.match(end.slice(0, 2500), /this\.awaitingAnswer = false;\n\s*this\.teleporting = false;/);
  });
});

describe('dying', () => {
  it('is logged, and the respawn asked for again until the bot has health', async () => {
    const text = await source();
    assert.match(text, /bot\.on\('death', \(\) => \{[\s\S]{0,200}this\.respawnUntilAlive\(bot, connectionController, 1\);/);
    const retry = text.slice(text.indexOf('private respawnUntilAlive('));
    const body = retry.slice(0, retry.indexOf('\n  }\n'));
    assert.match(body, /if \(bot\.health > 0\) \{/);
    assert.match(body, /bot\.respawn\(\);\s*this\.respawnUntilAlive\(bot, connectionController, attempt \+ 1\);/);
    assert.match(body, /\}, RESPAWN_RETRY_MS\);/);
  });

  it('claims no job while dead', async () => {
    const text = await source();
    const gate = text.slice(text.indexOf('private captureJobClaimState()'));
    assert.match(gate.slice(0, 3000), /bot\.health <= 0\s*\? 'dead'/);
  });
});
