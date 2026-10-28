import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  compactMoney,
  measureText,
  multiplierText,
  renderWinCard,
  winCardSvg,
} from '../src/lib/win-card.js';

/* The win card is drawn on the server from the round the database holds, in the link preview's own
 * clothes: the site's fonts (assets/fonts) and the pixel donut, generated from the frontend's art
 * (scripts/card-art.mjs). */

const crash = { gameName: 'Crash', wagerMinor: 230_000n, payoutMinor: 12_466_000n };

/** Every piece of text on the card, in order. */
const texts = (svg: string) =>
  [...svg.matchAll(/<(?:text|tspan)[^>]*>([^<]+)</g)].map((match) => match[1]!.replace(/&#215;/g, '×'));

describe('the card art', () => {
  it('is generated from the frontend files as they are now', async () => {
    const script = new URL('../../../scripts/card-art.mjs', import.meta.url).href;
    const { build, OUTPUT } = (await import(script)) as { build: () => string; OUTPUT: string };
    assert.equal(await readFile(OUTPUT, 'utf8'), build(), 'run node scripts/card-art.mjs');
  });
});

describe('the figures on a card', () => {
  it('writes amounts the way the site does', () => {
    assert.equal(compactMoney(950n), '$950');
    assert.equal(compactMoney(12_400n), '$12.4K');
    assert.equal(compactMoney(230_000n), '$230K');
    assert.equal(compactMoney(12_400_000n), '$12.4M');
    assert.equal(compactMoney(650_000_000n), '$650M');
    assert.equal(compactMoney(1_023_997_495n), '$1.02B');
    assert.equal(compactMoney(2_000_000_000_000n), '$2T');
  });

  it('writes the multiplier rounded down to the hundredth, without trailing zeros', () => {
    assert.equal(multiplierText(100n, 500n), '5×');
    assert.equal(multiplierText(230_000n, 12_466_000n), '54.2×');
    assert.equal(multiplierText(3n, 10n), '3.33×');
    assert.equal(multiplierText(0n, 10n), '');
  });
});

describe('the card', () => {
  it('says the game, the win, the multiplier and the bet, and nothing about who', () => {
    assert.deepEqual(texts(winCardSvg(crash)), ['Donut', 'Luxe', 'Won on Crash', '$12.5M', '54.2×', '$230K bet']);
  });

  /* 2026-10-28: the first card printed the player's name ("AriaStar8 bet $230K") and an "18+".
   * The site masks names wherever a stranger looks, and a card is posted to strangers. */
  it('has no name on it to print, and no age line', () => {
    const svg = winCardSvg({ ...crash, playerName: 'AriaStar8' } as typeof crash);
    assert.doesNotMatch(svg, /AriaStar8/);
    assert.doesNotMatch(svg, /18\+/);
  });

  it('sets the figure smaller rather than letting it run into the donut', () => {
    const svg = winCardSvg({ gameName: 'Case Battles', wagerMinor: 1_500_000_000n, payoutMinor: 988_000_000_000n });
    const amount = /font-size="(\d+)" fill="#ffaa00">(\$[^<]+)</.exec(svg);
    assert.ok(amount, 'the figure is on the card');
    assert.ok(measureText(amount[2]!, 'Archivo', 900, Number(amount[1])) <= 650);
  });

  it('escapes what it prints', () => {
    assert.match(winCardSvg({ ...crash, gameName: '<Slots & Co>' }), /Won on &#60;Slots &#38; Co&#62;/);
  });

  it('is a 1200 by 630 PNG, small enough to send to every preview that asks', () => {
    const png = renderWinCard(crash);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('latin1', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), CARD_WIDTH);
    assert.equal(png.readUInt32BE(20), CARD_HEIGHT);
    assert.ok(png.length < 300_000, `${png.length} bytes`);
  });
});
