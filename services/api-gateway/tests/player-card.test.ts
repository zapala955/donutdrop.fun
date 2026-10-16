import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');

describe('the player card behind a chat avatar', () => {
  it('is public, rate-limited and cached, and never says whether a player is up or down', async () => {
    const insights = await read('services/api-gateway/src/routes/insights.ts');
    assert.match(insights, /'\/v1\/players\/:id\/card',\n    \{ config: \{ rateLimit: \{ max: 30, timeWindow: '1 minute' \} \} \}/);
    assert.match(insights, /if \(cached && Date\.now\(\) - cached\.at < CARD_TTL_MS\) return cached\.body;/);
    const card = insights.slice(insights.indexOf('export interface PlayerCard'), insights.indexOf('}\n', insights.indexOf('export interface PlayerCard')));
    assert.deepEqual(
      [...card.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]),
      ['playerId', 'joinedAt', 'staff', 'vip', 'wageredMinor', 'bets', 'favouriteGame', 'biggestWin', 'bestMultiplier'],
    );
    const body = insights.slice(insights.indexOf('async function playerCard'), insights.indexOf('function requireUserId'));
    for (const forbidden of ['wallet_transactions', 'user_wallets', 'net', 'minecraft_username']) {
      assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`), `the card reads ${forbidden}`);
    }
    // Test twins are nobody to look up, and the biggest win is a win: more back than staked.
    assert.match(body, /WHERE u\.id = \$1 AND \$\{notDemoPredicate\('u'\)\}/);
    assert.match(body, /wins AS \(SELECT \* FROM rounds WHERE payout > wager AND wager > 0\)/);
  });

  it('reads every game the wins board does', async () => {
    const insights = await read('services/api-gateway/src/routes/insights.ts');
    const rounds = insights.slice(insights.indexOf('async function playerCard'), insights.indexOf('function requireUserId'));
    for (const table of ['case_rounds', 'upgrader_rounds', 'roulette_bets', 'blackjack_hands', 'crash_bets', 'mines_games', 'tower_games', 'chicken_games', 'plinko_bets', 'coinflip_games', 'mines_duel_games', 'battle_players']) {
      assert.ok(rounds.includes(`FROM ${table}`), table);
    }
  });

  it('opens from the head and the name, and draws the server text as text', async () => {
    const chat = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js');
    assert.doesNotMatch(chat, /openTipSheet/);
    assert.match(chat, /avatar\.addEventListener\('click', open\);/);
    assert.match(chat, /who\.addEventListener\('click', open\);/);
    assert.match(chat, /api\.get\(`\/v1\/players\/\$\{encodeURIComponent\(userId\)\}\/card`\)/);
    const card = chat.slice(chat.indexOf('/* ═════════════════════════ the player card'), chat.indexOf('/* ═════════════════════════ rendering'));
    // el()'s third argument is innerHTML; nothing on the card goes through it.
    assert.doesNotMatch(card, /\bel\('[a-z]+', '[^']*', /);
    assert.match(card, /if \(!grid\.isConnected\) return;/);
  });
});
