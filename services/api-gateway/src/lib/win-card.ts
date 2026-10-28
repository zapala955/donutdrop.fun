import { deflateSync } from 'node:zlib';
import { DONUT, GLYPHS, WORDMARK, type Sprite } from './card-art.js';

/**
 * The win card: the 1200 x 630 picture a shared win previews as in Discord, X and the rest.
 *
 * Drawn here, from the round as the database holds it, and never in the browser: a card the client
 * drew could say anything, and it would go out under the site's name. The server has no canvas and
 * no fonts and needs neither, because the card is pixel art like the rest of the site -- the game's
 * own bitmap font and the donut and wordmark sprites (card-art.ts, generated from the frontend's
 * files), every one of them whole rectangles on an integer grid. So this paints rectangles into a
 * plain RGB buffer and writes it out as a PNG with nothing but zlib.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

type Rgb = readonly [number, number, number];

const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

// The site's own palette (assets/css/luxe.css).
const BG_TOP = rgb('#0b0f13');
const BG_BOTTOM = rgb('#06080a');
const GOLD = rgb('#ffd700');
const GOLD_DEEP = rgb('#a35f00');
const IVORY = rgb('#fff3b0');
const TEXT = rgb('#ecedf0');
const MUTED = rgb('#a2a4ab');
const RULE = rgb('#1b2128');

/** What a card shows: one settled win, as it was when it was shared. */
export interface WinCard {
  readonly gameName: string;
  readonly playerName: string;
  readonly wagerMinor: bigint;
  readonly payoutMinor: bigint;
}

/** An amount as the site writes it (assets/js/util.js money): $950, $12.4K, $1.02B. */
export function compactMoney(minor: bigint): string {
  const amount = Math.abs(Math.round(Number(minor)));
  const trim = (x: number) => {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  const sign = minor < 0n ? '-' : '';
  if (amount >= 1e12) return `${sign}$${trim(amount / 1e12)}T`;
  if (amount >= 1e9) return `${sign}$${trim(amount / 1e9)}B`;
  if (amount >= 1e6) return `${sign}$${trim(amount / 1e6)}M`;
  if (amount >= 1e3) return `${sign}$${trim(amount / 1e3)}K`;
  return `${sign}$${amount.toLocaleString('en-US')}`;
}

/** The multiplier, rounded down to the hundredth as the history shows it, without trailing zeros: 54.2x. */
export function multiplierText(wagerMinor: bigint, payoutMinor: bigint): string {
  if (wagerMinor <= 0n) return '';
  const hundredths = (payoutMinor * 100n) / wagerMinor;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}x`;
}

/** A plain RGB picture, painted with whole rectangles. */
class Raster {
  readonly pixels: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = Buffer.alloc(width * height * 3);
  }

  fill(x: number, y: number, width: number, height: number, colour: Rgb): void {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.width, Math.floor(x + width));
    const bottom = Math.min(this.height, Math.floor(y + height));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const at = (row * this.width + column) * 3;
        this.pixels[at] = colour[0];
        this.pixels[at + 1] = colour[1];
        this.pixels[at + 2] = colour[2];
      }
    }
  }

  sprite(sprite: Sprite, x: number, y: number, scale: number): void {
    for (const [rx, ry, rw, rh, colour] of sprite.rects) {
      this.fill(x + rx * scale, y + ry * scale, rw * scale, rh * scale, rgb(colour));
    }
  }

  /** Text in the game's font, with its shadow a font pixel down and right at a quarter of the colour. */
  text(text: string, x: number, y: number, scale: number, colour: Rgb): void {
    const shadow: Rgb = [colour[0] >> 2, colour[1] >> 2, colour[2] >> 2];
    this.glyphs(text, x + scale, y + scale, scale, shadow);
    this.glyphs(text, x, y, scale, colour);
  }

  private glyphs(text: string, x: number, y: number, scale: number, colour: Rgb): void {
    let cursor = x;
    for (const character of printable(text)) {
      const rows = GLYPHS[character]!;
      rows.forEach((row, rowIndex) => {
        for (let column = 0; column < row.length; column += 1) {
          if (row[column] === '#') this.fill(cursor + column * scale, y + rowIndex * scale, scale, scale, colour);
        }
      });
      cursor += ((rows[0]?.length ?? 0) + 1) * scale;
    }
  }
}

/** The text as the font can draw it: anything outside printable ASCII becomes '?'. */
function printable(text: string): string[] {
  return [...text].map((character) => (GLYPHS[character] ? character : '?'));
}

/** How wide `text` is at `scale`, without the trailing gap or the shadow. */
export function textWidth(text: string, scale: number): number {
  const characters = printable(text);
  const units = characters.reduce((sum, character) => sum + (GLYPHS[character]![0]?.length ?? 0) + 1, 0);
  return Math.max(0, units - 1) * scale;
}

/** The largest scale, no larger than `scale`, at which `text` fits in `width`. */
function fitScale(text: string, scale: number, width: number): number {
  let fitted = scale;
  while (fitted > 1 && textWidth(text, fitted) > width) fitted -= 1;
  return fitted;
}

export function renderWinCard(card: WinCard): Buffer {
  const raster = new Raster(CARD_WIDTH, CARD_HEIGHT);

  // The ground: the site's two blacks, top to bottom, in bands a few pixels deep.
  const band = 6;
  for (let y = 0; y < CARD_HEIGHT; y += band) {
    const t = y / (CARD_HEIGHT - band);
    const mix = (i: 0 | 1 | 2) => Math.round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t);
    raster.fill(0, y, CARD_WIDTH, band, [mix(0), mix(1), mix(2)]);
  }
  // A gold frame, inset.
  const inset = 18;
  const edge = 6;
  raster.fill(inset, inset, CARD_WIDTH - inset * 2, edge, GOLD_DEEP);
  raster.fill(inset, CARD_HEIGHT - inset - edge, CARD_WIDTH - inset * 2, edge, GOLD_DEEP);
  raster.fill(inset, inset, edge, CARD_HEIGHT - inset * 2, GOLD_DEEP);
  raster.fill(CARD_WIDTH - inset - edge, inset, edge, CARD_HEIGHT - inset * 2, GOLD_DEEP);

  const left = 72;
  const right = CARD_WIDTH - 72;
  const width = right - left;

  // The brand, top left; the game, top right.
  raster.sprite(DONUT, left, 56, 5);
  raster.sprite(WORDMARK, left + DONUT.width * 5 + 24, 56 + ((DONUT.height - WORDMARK.height) * 5) / 2, 5);
  const gameScale = fitScale(card.gameName, 5, 380);
  raster.text(card.gameName, right - textWidth(card.gameName, gameScale), 76, gameScale, MUTED);

  // The win.
  const headline = `WON ${compactMoney(card.payoutMinor)}`;
  const headlineScale = fitScale(headline, 14, width);
  raster.text(headline, left, 196, headlineScale, GOLD);

  const multiplier = `${multiplierText(card.wagerMinor, card.payoutMinor)} on ${card.gameName}`;
  raster.text(multiplier, left, 344, fitScale(multiplier, 7, width), TEXT);

  const who = `${card.playerName} bet ${compactMoney(card.wagerMinor)}`;
  raster.text(who, left, 424, fitScale(who, 5, width), MUTED);

  // The footer, under a rule.
  raster.fill(left, 504, width, 4, RULE);
  raster.text('donutluxe.com', left, 536, 4, IVORY);
  const small = '18+  Provably fair';
  raster.text(small, right - textWidth(small, 4), 536, 4, MUTED);

  return encodePng(raster.width, raster.height, raster.pixels);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** An 8-bit RGB PNG of the pixels, every row unfiltered: the card is flat colour, which deflates well. */
export function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
