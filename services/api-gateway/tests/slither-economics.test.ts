import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BOOST_BURN_BPS_PER_SECOND,
  createArena,
  splitExtraction,
} from '../src/lib/slither-engine.js';

/*
 * The arena's two rules, as assertions.
 *
 *   1. The only way to gain value is to kill somebody.
 *   2. The house takes 10% on the way out, and boosting burns.
 *
 * Rule 1 is a property of what can put value on the floor, so it is asserted against the code that
 * can: an arena that starts empty and exactly one thing that fills it.
 */

const read = (rel: string) => readFile(path.resolve(import.meta.dirname, rel), 'utf8');
const engine = () => read('../src/lib/slither-engine.ts');

describe('the arena creates nothing', () => {
  it('starts empty, so there is no food to farm', () => {
    const arena = createArena();
    assert.equal(arena.orbs.size, 0);
    assert.equal(arena.snakes.size, 0);
  });

  it('has exactly one thing that puts value on the floor: a death', async () => {
    /* If a second dropOrb call site ever appears, it is a new way to gain value without killing
     * anybody, and it needs to be a deliberate decision rather than a diff nobody read. */
    const source = await engine();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls = code.match(/\bdropOrb\(/g) ?? [];
    /* One definition plus one call. */
    assert.equal(calls.length, 2, 'exactly one dropOrb call site, plus the function itself');
    assert.match(code, /'death',\s*\n?\s*\);/);
  });

  it('knows only one kind of orb', async () => {
    const source = await engine();
    assert.match(source, /export type OrbKind = 'death';/);
  });

  it('burns the boost drain instead of dropping it', async () => {
    /* Boosting used to shed orbs anyone could eat, which is growth without a kill. */
    const source = await engine();
    const fn = source.slice(source.indexOf('function applyBoostDrain'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.doesNotMatch(body, /dropOrb/);
    assert.match(body, /return drain;/);
  });

  it('reports the burn rather than losing it quietly', async () => {
    /* A sink nobody totals is a sink nobody can tune, and it is indistinguishable from a leak. */
    const source = await engine();
    assert.match(source, /readonly burnedMinor: bigint;/);
    assert.match(source, /burnedMinor \+= applyBoostDrain\(snake\)/);
  });
});

describe('the cut', () => {
  it('takes ten percent of what a player carries out', () => {
    const { feeMinor, creditedMinor } = splitExtraction(42_500_000n, 1_000);
    assert.equal(feeMinor, 4_250_000n);
    assert.equal(creditedMinor, 38_250_000n);
  });

  it('still rounds toward the player', () => {
    /* One unit short of a clean split. The house never gains from a rounding it chose. */
    const { feeMinor, creditedMinor } = splitExtraction(9_999n, 1_000);
    assert.equal(feeMinor, 999n);
    assert.equal(creditedMinor, 9_000n);
    assert.equal(feeMinor + creditedMinor, 9_999n);
  });

  it('quotes a burn rate derived from the simulation, not restated beside it', () => {
    /* 25 parts in 100 000 per tick at 20 ticks a second is 0.5% a second. Derived, so the figure
     * on the entry screen cannot drift from the one the pit actually charges. */
    assert.equal(BOOST_BURN_BPS_PER_SECOND, 50);
  });
});

describe('the arena reads as a pit of distinguishable people', () => {
  it('draws the floor and the minimap from one colour source', async () => {
    /* Three surfaces name a snake: its body on the floor, its dot on the minimap, and the label
     * over its head. If any of them derives its own hue, the map teaches the player a mapping and
     * then breaks it at the moment they lean on it — which is worse than having no map. One
     * exported function decides, and everything asks it. */
    const renderer = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/slither-renderer.js');
    const client = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/slither.js');
    assert.match(renderer, /export function snakeColourCss/);
    assert.match(client, /snakeColourCss\(snake\)/);
    /* The minimap must not carry a palette of its own. */
    const map = client.slice(client.indexOf('function paintMinimap'));
    assert.doesNotMatch(map.slice(0, map.indexOf('\n}')), /PLAYER_PALETTE|hsl\(/);
  });

  it('keeps the minimap pointing the same way as the floor', async () => {
    /* The map plots world y straight down the canvas with no flip, which is only correct because
     * the arena's vertex shader negates y on its way to clip space. Flip that shader and every dot
     * on the map mirrors, silently and in the one place a player has no way to notice. */
    const renderer = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/slither-renderer.js');
    assert.match(renderer, /-pixel\.y \/ \(u_viewport\.y \* 0\.5\)/);
  });
});

describe('the entry screen quotes both costs', () => {
  it('sends the fee and the burn to the client', async () => {
    /* The fee used to be deliberately withheld. At 3% that was arguable; at 10% a player is
     * entitled to know before they stake, not after they extract. */
    const source = await read('../src/routes/slither.ts');
    assert.match(source, /cashoutFeeBps: config\.slitherCashoutFeeBps/);
    assert.match(source, /boostBurnBpsPerSecond: BOOST_BURN_BPS_PER_SECOND/);
  });

  it('renders them from the payload rather than hardcoding them', async () => {
    const client = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/slither.js');
    assert.match(client, /board\.cashoutFeeBps/);
    assert.match(client, /board\.boostBurnBpsPerSecond/);
    /* A hardcoded "10%" survives a config change and starts lying the moment the rate moves. */
    const terms = client.slice(client.indexOf("const terms = el('dl'"));
    assert.doesNotMatch(terms.slice(0, 900), /10%|0\.5%/);
  });
});
