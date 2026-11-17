import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  cleanText,
  parseAmount,
  parseDuration,
  readStats,
  skinUrlIn,
  statKeyFor,
  trimCapture,
  type StatsCapture,
} from '../src/stats-reader.js';
import { dialogTexts, fullProfileButton, mentionsPlayer } from '../src/worker.js';

/* The owner, 2026-11-17: "make sure it gets the stats by running /stats on donutsmp". The reader does
 * not know in advance how DonutSMP lays /stats out, so it is held here to every shape a server
 * plausibly uses: a menu with each figure an item (value in the lore), "Label: value" lines, a chat
 * answer, a dialog, and the ways a server says a player does not exist. */

const capture = (overrides: Partial<StatsCapture>): StatsCapture => ({ items: [], chat: [], dialog: [], ...overrides });

describe('reading /stats', () => {
  it('reads a menu with each figure an item and its value in the lore', () => {
    const reading = readStats(
      capture({
        title: "teexs's Stats",
        items: [
          { slot: 4, name: 'teexs', lore: [] },
          { slot: 10, name: '§6 Money', lore: ['§f$1.24B', '§7Click to view'] },
          { slot: 11, name: '§d Shards', lore: ['§f18,450'] },
          { slot: 12, name: '§c Kills', lore: ['§f2,317'] },
          { slot: 13, name: '§7 Deaths', lore: ['§f941'] },
          { slot: 14, name: '§b Playtime', lore: ['§f41d 7h 3m'] },
          { slot: 15, name: '§a Blocks Placed', lore: ['§f384,120'] },
          { slot: 16, name: '§6 Blocks Broken', lore: ['§f1.9M'] },
          { slot: 22, name: '§c Mobs Killed', lore: ['§f55,000'] },
          { slot: 23, name: '§e Money Spent On Shop', lore: ['§f$9.9B'] },
        ],
      }),
      'teexs',
    );
    assert.equal(reading.outcome, 'found');
    if (reading.outcome !== 'found') return;
    assert.deepEqual(reading.stats, {
      money: { display: '$1.24B', value: 1_240_000_000 },
      shards: { display: '18,450', value: 18_450 },
      kills: { display: '2,317', value: 2_317 },
      deaths: { display: '941', value: 941 },
      playtime: { display: '41d 7h 3m', value: 41 * 86_400 + 7 * 3_600 + 3 * 60 },
      blocksPlaced: { display: '384,120', value: 384_120 },
      blocksBroken: { display: '1.9M', value: 1_900_000 },
    });
    assert.equal(reading.shownName, 'teexs');
  });

  it('reads "Label: value" lines, in lore or in chat, and ignores mobs killed and money spent', () => {
    const fromLore = readStats(
      capture({
        items: [
          {
            slot: 13,
            name: 'Player Stats',
            lore: ['Money: $52.3M', 'Shards » 120', 'Kills: 7', 'Mob Kills: 900', 'Deaths: 3', 'Play Time: 2 days, 5 hours', 'Placed: 10,000', 'Mined: 12k'],
          },
        ],
      }),
      'Steve',
    );
    assert.equal(fromLore.outcome, 'found');
    if (fromLore.outcome !== 'found') return;
    assert.equal(fromLore.stats.money?.value, 52_300_000);
    assert.equal(fromLore.stats.shards?.value, 120);
    assert.equal(fromLore.stats.kills?.value, 7);
    assert.equal(fromLore.stats.deaths?.value, 3);
    assert.equal(fromLore.stats.playtime?.value, 2 * 86_400 + 5 * 3_600);
    assert.equal(fromLore.stats.blocksPlaced?.value, 10_000);
    assert.equal(fromLore.stats.blocksBroken?.value, 12_000);

    const fromChat = readStats(capture({ chat: ['--- Stats for .Bedrock_Guy ---', 'Balance: $3,000', 'Kills: 0', 'Money spent: $50'] }), '.bedrock_guy');
    assert.equal(fromChat.outcome, 'found');
    if (fromChat.outcome !== 'found') return;
    assert.deepEqual(fromChat.stats.money, { display: '$3,000', value: 3_000 });
    assert.deepEqual(fromChat.stats.kills, { display: '0', value: 0 });
    assert.equal(fromChat.shownName, '.Bedrock_Guy');
  });

  it('reads the dialog DonutSMP really sends (2026-11-17)', () => {
    const reading = readStats(
      capture({ dialog: ['View Full Profile', 'Back', 'teexs', 'teexs', 'Money: $ 679', 'Kills: 2', 'Deaths: 5', 'Playtime: 2h 15m'] }),
      'teexs',
    );
    assert.equal(reading.outcome, 'found');
    if (reading.outcome !== 'found') return;
    assert.deepEqual(reading.stats, {
      money: { display: '$ 679', value: 679 },
      kills: { display: '2', value: 2 },
      deaths: { display: '5', value: 5 },
      playtime: { display: '2h 15m', value: 2 * 3_600 + 15 * 60 },
    });
  });

  it('reads a dialog the same way', () => {
    const reading = readStats(capture({ dialog: ['teexs', 'Money: $10K', 'Deaths: 12'] }), 'teexs');
    assert.equal(reading.outcome, 'found');
    if (reading.outcome === 'found') assert.equal(reading.stats.deaths?.value, 12);
  });

  it('says when the player does not exist, and when it could not tell', () => {
    for (const line of ['Player not found.', "That player doesn't exist!", 'nobody has never joined the server', 'Could not find player x']) {
      assert.equal(readStats(capture({ chat: [line] }), 'x_y_z').outcome, 'not_found', line);
    }
    assert.equal(readStats(capture({ chat: ['You need to wait another 0.25 seconds'] }), 'abc').outcome, 'unreadable');
    assert.equal(readStats(capture({}), 'abc').outcome, 'unreadable');
  });
});

describe('the parts', () => {
  it('cleans colour codes, icon glyphs and emoji', () => {
    assert.equal(cleanText('§6§l Money  §r💰'), 'Money');
    assert.equal(cleanText('  18,450  '), '18,450');
  });

  it('names a figure by its label, and nothing else', () => {
    assert.equal(statKeyFor('Money'), 'money');
    assert.equal(statKeyFor('Balance'), 'money');
    assert.equal(statKeyFor('Money Made From Sell'), undefined);
    assert.equal(statKeyFor('Mobs Killed'), undefined);
    assert.equal(statKeyFor('Player Kills'), 'kills');
    assert.equal(statKeyFor('Blocks Mined'), 'blocksBroken');
    assert.equal(statKeyFor('Time Played'), 'playtime');
    assert.equal(statKeyFor('Click to go back'), undefined);
  });

  it('reads amounts and durations as DonutSMP writes them', () => {
    assert.equal(parseAmount('$1.24B'), 1_240_000_000);
    assert.equal(parseAmount('1,234,567'), 1_234_567);
    assert.equal(parseAmount('12.5k'), 12_500);
    assert.equal(parseAmount('3 million'), 3_000_000);
    assert.equal(parseAmount('none'), null);
    assert.equal(parseDuration('41d 7h 3m'), 41 * 86_400 + 7 * 3_600 + 180);
    assert.equal(parseDuration('1 week, 2 hours'), 7 * 86_400 + 7_200);
    assert.equal(parseDuration('312'), null);
  });

  it('takes a skin only from a head texture on Mojang’s own host', () => {
    const texture = (url: string) =>
      Buffer.from(JSON.stringify({ textures: { SKIN: { url } } })).toString('base64');
    const good = 'http://textures.minecraft.net/texture/3b60a1f6d562f52aaebbf1434f1de147933a3affe0e764fa49ea057536623cd3';
    const components = [{ type: 'profile', data: { properties: [{ name: 'textures', value: texture(good) }] } }];
    assert.equal(skinUrlIn(components), good);
    assert.equal(skinUrlIn([{ data: { value: texture('https://evil.example/skin.png') } }]), undefined);
  });

  it('keeps what the server sent, bounded', () => {
    const trimmed = trimCapture(capture({ title: '§6Stats', items: [{ slot: 1, name: 'x'.repeat(900), lore: Array(90).fill('y') }], chat: Array(90).fill('z') }));
    assert.equal(trimmed.title, 'Stats');
    assert.equal(trimmed.items[0]!.name.length, 300);
    assert.equal(trimmed.items[0]!.lore.length, 40);
    assert.equal(trimmed.chat.length, 40);
  });

  it('reads every line of a dialog, NBT or not', () => {
    const nbt = {
      type: 'compound',
      value: {
        title: { type: 'string', value: 'Stats' },
        body: { type: 'list', value: { type: 'compound', value: [{ contents: { type: 'compound', value: { text: { type: 'string', value: 'Kills: 4' } } } }] } },
      },
    };
    assert.deepEqual(dialogTexts(nbt), ['Stats', 'Kills: 4']);
  });
});

/* The /stats dialog as DonutSMP sent it on 2026-11-17, trimmed to its two buttons. */
const button = (label: string, args: string) => ({
  action: {
    type: 'compound',
    value: {
      id: { type: 'string', value: 'donutdialogues:action' },
      type: { type: 'string', value: 'minecraft:dynamic/custom' },
      additions: { type: 'compound', value: { args: { type: 'string', value: args }, cmd: { type: 'string', value: 'stats' } } },
    },
  },
  width: { type: 'int', value: 200 },
  label: { type: 'compound', value: { color: { type: 'string', value: 'white' }, text: { type: 'string', value: label } } },
});
const liveDialog = {
  dialog: {
    data: {
      type: 'compound',
      value: {
        after_action: { type: 'string', value: 'none' },
        actions: { type: 'list', value: { type: 'compound', value: [button('Back', ''), button('View Full Profile', 'full teexs')] } },
      },
    },
  },
};

describe('the full profile', () => {
  it('finds the View Full Profile button and hands back its id and payload exactly as sent', () => {
    const found = fullProfileButton(liveDialog);
    assert.equal(found?.id, 'donutdialogues:action');
    assert.deepEqual(found?.nbt, {
      type: 'compound',
      value: { args: { type: 'string', value: 'full teexs' }, cmd: { type: 'string', value: 'stats' } },
    });
    assert.equal(fullProfileButton({ dialog: { data: { type: 'compound', value: {} } } }), undefined);
  });

  it('only trusts a profile that names the player asked for', () => {
    // What typing `/stats full teexs` returned: the stats of a player called "full".
    const wrong = capture({ dialog: ['full full', 'View Full Profile', 'Money: $ 55.6M'] });
    assert.equal(mentionsPlayer(wrong, 'teexs'), false);
    assert.equal(mentionsPlayer(capture({ dialog: ["teexs's Profile", 'Shards: 12'] }), 'teexs'), true);
    assert.equal(mentionsPlayer(capture({ dialog: ['.Bedrock_Guy'] }), '.bedrock_guy'), true);
    assert.equal(mentionsPlayer(capture({ dialog: ['teexs2'] }), 'teexs'), false);
  });
});

describe('the stats bot', () => {
  it('runs /stats only in the stats role, holds relogs and manual play for a lookup in flight, and survives', async () => {
    const worker = await readFile(path.join(import.meta.dirname, '../src/worker.ts'), 'utf8');
    assert.match(worker, /this\.statsRole = route\.stats === true;/);
    assert.match(worker, /if \(this\.statsRole\) \{[\s\S]{0,200}this\.schedule\(\(\) => this\.run\(this\.pollStats\(\), 'stats poll'\), STATS_POLL_MS\);/);
    // Plain /stats, then the dialog's own "View Full Profile" button pressed as a client presses it:
    // typed, `/stats full x` reads a player called "full" (seen live 2026-11-17).
    assert.match(worker, /this\.sendCommand\(bot, `\/stats \$\{lookup\.player\}`\)/);
    assert.match(worker, /bot\._client\.write\('custom_click_action', \{ id: button\.id, nbt: button\.nbt \}\);/);
    assert.match(worker, /if \(mentionsPlayer\(full\.capture, lookup\.player\)\) \{/);
    assert.doesNotMatch(worker, /sendCommand\(bot, `\/stats full/, 'the full profile is never typed');
    // The same gate a payout waits for, and no relog or manual-play logout mid-lookup.
    assert.match(worker, /private async pollStats\(\)[\s\S]{0,400}const claimState = this\.captureJobClaimState\(\);/);
    assert.match(worker, /this\.polling \|\|\n\s+this\.statsBusy \|\|/);
    assert.match(worker, /this\.transferring \|\| this\.polling \|\| this\.statsBusy\) return;/);
    // "solves issues like dying": hurt moves away, dying again and again logs in afresh.
    assert.match(worker, /bot\.on\('health', \(\) => this\.escapeIfHurt\(bot, connectionController\)\);/);
    assert.match(worker, /if \(this\.statsRole\) this\.noteStatsDeath\(\);/);
  });
});
