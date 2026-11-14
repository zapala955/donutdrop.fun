import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { createFairRoll, generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import { flipCoin } from '../src/lib/coinflip.js';
import { crashPoint } from '../src/lib/crash.js';
import { diceRoll } from '../src/lib/dice.js';
import { FAIR_SOURCES } from '../src/lib/fair-rounds.js';
import { limboResult } from '../src/lib/limbo.js';
import { rouletteResult } from '../src/lib/roulette.js';

/*
 * The Provably Fair page (2026-11-14). The owner: "rewrite https://donutluxe.com/fairness and also it
 * shows upgrader bets only for some reason" -- the page asked the upgrader's own history. It now reads
 * every seeded game (GET /v1/fairness/rounds), and checks a round in the player's browser: the
 * revealed seed against the hash given before the bet, and, for the single-draw games, the result
 * itself. These pin the list, and that the browser's arithmetic is the server's, digit for digit.
 */

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative);
const read = (file: string) => readFile(file, 'utf8');

interface Replay {
  sha256Hex(text: string): Promise<string>;
  hmacHex(serverSeed: string, message: string): Promise<string>;
  diceRoll(digest: string): number;
  limboResultX100(digest: string): number;
  rollPpm(digest: string): number;
  roulettePocket(digest: string): number;
  crashPointX100(digest: string, edgeBps: number): number;
  coinflipSide(digest: string): string;
}
const loadReplay = async () => (await import(pathToFileURL(front('assets/js/fair-replay.js')).href)) as Replay;

describe('the page checks a round in the browser, with the server\'s own arithmetic', () => {
  it('agrees with the games on 3,000 random seeds: the hash, the digest, dice, limbo, the roll, roulette, crash and coinflip', async () => {
    const replay = await loadReplay();
    for (let i = 0; i < 3_000; i += 1) {
      const serverSeed = generateServerSeed();
      const clientSeed = randomBytes(randomInt(4, 24)).toString('base64url');
      const nonce = randomInt(0, 2_000_000);
      assert.equal(await replay.sha256Hex(serverSeed), hashServerSeed(serverSeed));
      const digest = await replay.hmacHex(serverSeed, `${clientSeed}:${nonce}`);
      assert.equal(digest, createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`, 'utf8').digest('hex'));
      assert.equal(replay.diceRoll(digest), diceRoll(serverSeed, clientSeed, nonce), 'dice');
      assert.equal(replay.limboResultX100(digest), limboResult(serverSeed, clientSeed, nonce), 'limbo');
      assert.equal(replay.rollPpm(digest), createFairRoll(serverSeed, clientSeed, nonce).rollPpm, 'upgrader roll');
      const roundId = randomUUID();
      const spin = await replay.hmacHex(serverSeed, `${roundId}:0`);
      assert.equal(replay.roulettePocket(spin), rouletteResult(serverSeed, roundId).result, 'roulette');
      const edge = [0, 100, 500, 1000][i % 4]!;
      assert.equal(replay.crashPointX100(spin, edge), crashPoint(serverSeed, roundId, edge).crashPointX100, 'crash');
      const opponent = randomBytes(8).toString('hex');
      const flip = await replay.hmacHex(serverSeed, `coinflip:${clientSeed}:${opponent}`);
      assert.equal(replay.coinflipSide(flip), flipCoin(serverSeed, clientSeed, opponent).side, 'coinflip');
    }
  });

  it('asks the server nothing to check a round', async () => {
    const replay = await read(front('assets/js/fair-replay.js'));
    assert.doesNotMatch(replay, /api\.|fetch\(|\/v1\//);
    assert.match(replay, /crypto\.subtle\.digest\('SHA-256'/);
    assert.match(replay, /crypto\.subtle\.importKey\('raw', encoder\.encode\(serverSeed\), \{ name: 'HMAC', hash: 'SHA-256' \}/);
  });
});

describe('the rounds it lists', () => {
  it('come from every seeded game, not the upgrader alone', async () => {
    const tables = FAIR_SOURCES.map((source) => source.from.split(' ')[0]);
    for (const table of [
      'dice_bets', 'limbo_bets', 'upgrader_rounds', 'case_rounds', 'plinko_bets', 'fishing_casts', 'derby_races',
      'mines_games', 'tower_games', 'chicken_games', 'ice_fishing_games', 'blackjack_hands', 'slots_spins',
      'crash_bets', 'roulette_bets', 'coinflip_games', 'mines_duel_games', 'battle_players',
    ]) {
      assert.ok(tables.includes(table), `${table} is missing`);
    }
    const page = await read(front('assets/js/fair.js'));
    assert.doesNotMatch(page, /upgradeHistory/);
    assert.match(page, /\/v1\/fairness\/rounds/);
  });

  it('are only rounds whose seed has been revealed, the player\'s own, paged by time', async () => {
    const lib = await read(path.join(repo, 'services/api-gateway/src/lib/fair-rounds.ts'));
    assert.match(lib, /const conditions = \[source\.where, `\$\{source\.reveal\} IS NOT NULL`/);
    for (const source of FAIR_SOURCES) assert.match(source.where, /\$1/, `${source.key} is not limited to the player`);
    const routes = await read(path.join(repo, 'services/api-gateway/src/routes/fairness.ts'));
    assert.match(routes, /'\/v1\/fairness\/rounds',\s*\{ preHandler: guards\.authenticate/);
    const app = await read(path.join(repo, 'services/api-gateway/src/app.ts'));
    assert.match(app, /await registerFairnessRoutes\(app, db, config\);/);
  });
});
