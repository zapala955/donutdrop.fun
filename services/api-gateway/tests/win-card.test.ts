import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  compactMoney,
  encodePng,
  multiplierText,
  renderWinCard,
  textWidth,
} from '../src/lib/win-card.js';

/* The win card is drawn on the server from the round the database holds, as pixel art: the game's
 * font and the brand sprites, generated from the frontend's own files (scripts/card-art.mjs). */

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
    assert.equal(multiplierText(100n, 500n), '5x');
    assert.equal(multiplierText(230_000n, 12_466_000n), '54.2x');
    assert.equal(multiplierText(3n, 10n), '3.33x');
    assert.equal(multiplierText(0n, 10n), '');
  });

  it('measures text in font pixels, a pixel between glyphs', () => {
    assert.equal(textWidth('', 1), 0);
    // 'W' is five pixels wide; two of them with the gap between are eleven.
    assert.equal(textWidth('WW', 1), 11);
    assert.equal(textWidth('WW', 4), 44);
  });
});

function chunks(png: Buffer): { type: string; body: Buffer; crcOk: boolean }[] {
  const out = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    out.push({ type, body, crcOk: crc === crc32(png.subarray(offset + 4, offset + 8 + length)) });
    offset += 12 + length;
  }
  return out;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('the card itself', () => {
  it('encodes a PNG any reader can open', () => {
    const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const png = encodePng(2, 2, pixels);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    assert.deepEqual(parts.map((part) => part.type), ['IHDR', 'IDAT', 'IEND']);
    assert.ok(parts.every((part) => part.crcOk), 'every chunk carries its CRC');
    const raw = inflateSync(parts[1]!.body);
    assert.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it('is 1200 by 630, and carries the win in gold', () => {
    const png = renderWinCard({
      gameName: 'Crash',
      playerName: 'Steve',
      wagerMinor: 230_000n,
      payoutMinor: 12_466_000n,
    });
    const parts = chunks(png);
    const header = parts[0]!.body;
    assert.equal(header.readUInt32BE(0), CARD_WIDTH);
    assert.equal(header.readUInt32BE(4), CARD_HEIGHT);
    assert.equal(header[9], 2, 'RGB');
    assert.ok(parts.every((part) => part.crcOk));
    const raw = inflateSync(Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.body)));
    assert.equal(raw.length, (CARD_WIDTH * 3 + 1) * CARD_HEIGHT);
    // The headline's gold (#ffd700) is on the card.
    let gold = 0;
    for (let i = 0; i + 2 < raw.length; i += 1) {
      if (raw[i] === 0xff && raw[i + 1] === 0xd7 && raw[i + 2] === 0x00) gold += 1;
    }
    assert.ok(gold > 1000, `expected the gold headline, found ${gold} gold pixels`);
    // Small enough to send to every preview that asks.
    assert.ok(png.length < 200_000, `${png.length} bytes`);
  });

  it('draws a name the font has no glyph for, rather than failing', () => {
    assert.doesNotThrow(() =>
      renderWinCard({ gameName: 'Slots ★', playerName: '.Ünïcode', wagerMinor: 1n, payoutMinor: 9n }),
    );
  });
});
