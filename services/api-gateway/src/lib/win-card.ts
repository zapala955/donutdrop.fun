import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import { DONUT } from './card-art.js';

/**
 * The win card: the 1200 x 630 picture a shared win previews as in Discord, X and the rest.
 *
 * Drawn here, from the round as the database holds it, and never in the browser: a card the client
 * drew could say anything, and it would go out under the site's name. It wears the site's own link
 * preview (assets/img/brand/og-image.png) -- the charcoal ground, the pixel donut in a warm glow,
 * Archivo Black with the money in gold, Figtree for everything else, the rounded chips -- with the
 * win where the tagline was. Who won is the masked name ("A********"), as the live feed shows it:
 * the site masks names everywhere a stranger looks, and a card is posted to strangers.
 *
 * Hallmark · component: share card · theme: project system (og-image) · no italics, no gradient text
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// The link preview's palette (og-image.png) and the site's gold (assets/css/luxe.css).
const PAPER = '#121217';
const GOLD = '#ffaa00';
const INK = '#ffffff';
const MUTED = '#8b8f9a';
const CHIP = '#1b1b22';
const CHIP_EDGE = '#2c2c36';

// The renderer finds a face by its family and weight, not by the family's full name ("Archivo Black").
const DISPLAY = 'Archivo';
const DISPLAY_WEIGHT = 900;
const BODY = 'Figtree';

/** What a card shows: one settled win, as it was when it was shared. */
export interface WinCard {
  readonly gameName: string;
  /** Masked ("A********"), as the site shows a player to a stranger: never the real name. */
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

/** The multiplier as the history shows it, rounded down to the hundredth, without trailing zeros: 54.2×. */
export function multiplierText(wagerMinor: bigint, payoutMinor: bigint): string {
  if (wagerMinor <= 0n) return '';
  const hundredths = (payoutMinor * 100n) / wagerMinor;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}×`;
}

/* The fonts sit beside the package (assets/fonts), which is two levels up from this file in the
 * source tree and three in the build, so they are looked for rather than assumed. */
function fontFiles(): string[] {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 5; level += 1) {
    const fonts = path.join(directory, 'assets', 'fonts');
    if (existsSync(fonts)) {
      return ['archivo-900.ttf', 'figtree-600.ttf', 'figtree-700.ttf'].map((file) => path.join(fonts, file));
    }
    directory = path.dirname(directory);
  }
  throw new Error('the win card fonts are missing: services/api-gateway/assets/fonts');
}

let options: ResvgRenderOptions | undefined;
function renderOptions(): ResvgRenderOptions {
  options ??= {
    font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: BODY },
    fitTo: { mode: 'original' },
  };
  return options;
}

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`;

/** How wide a line of text sets, in pixels, measured by the renderer with the card's own fonts. */
export function measureText(text: string, family: string, weight: number, size: number): number {
  const svg = `${svgOpen}<text x="0" y="${size}" font-family="${family}" font-weight="${weight}" font-size="${size}">${escapeXml(text)}</text></svg>`;
  return new Resvg(svg, renderOptions()).getBBox()?.width ?? 0;
}

/** A rounded chip, as on the link preview: its SVG, and how far it reaches. */
function chip(text: string, x: number, y: number): { svg: string; width: number } {
  const size = 30;
  const height = 60;
  const width = Math.ceil(measureText(text, BODY, 700, size)) + 52;
  const svg =
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${CHIP}" stroke="${CHIP_EDGE}" stroke-width="2"/>` +
    `<text x="${x + width / 2}" y="${y + 41}" text-anchor="middle" font-family="${BODY}" font-weight="700" font-size="${size}" fill="${INK}">${escapeXml(text)}</text>`;
  return { svg, width };
}

/** The card as SVG. Exported so its text can be checked without decoding a picture. */
export function winCardSvg(card: WinCard): string {
  const left = 72;
  // The figure gets the room left of the donut, and steps down until it fits there.
  const amount = compactMoney(card.payoutMinor);
  let amountSize = 176;
  while (amountSize > 96 && measureText(amount, DISPLAY, DISPLAY_WEIGHT, amountSize) > 650) amountSize -= 8;

  // Who and where, on one line, smaller rather than into the donut for a long game name.
  const who = `${card.playerName} won on ${card.gameName}`;
  let whoSize = 40;
  while (whoSize > 26 && measureText(who, BODY, 600, whoSize) > 650) whoSize -= 2;

  // The text block, centred top to bottom: the site's name, who and where, the figure, the chips.
  const nameY = 134;
  const gameY = 262;
  const amountY = gameY + 32 + Math.round(amountSize * 0.74);
  const chipsY = 468;
  const multiplier = chip(multiplierText(card.wagerMinor, card.payoutMinor), left, chipsY);
  const bet = chip(`${compactMoney(card.wagerMinor)} bet`, left + multiplier.width + 14, chipsY);

  // The donut, as on the link preview: big, pixel-sharp, in a warm glow.
  const scale = 21;
  const donutSize = DONUT.width * scale;
  const donutX = CARD_WIDTH - 72 - donutSize;
  const donutY = Math.round((CARD_HEIGHT - donutSize) / 2);
  const glowX = donutX + donutSize / 2;
  const glowY = CARD_HEIGHT / 2;
  const donut = DONUT.rects
    .map(([x, y, w, h, colour]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colour}"/>`)
    .join('');

  return (
    svgOpen +
    `<defs><radialGradient id="glow" cx="${glowX}" cy="${glowY}" r="380" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${GOLD}" stop-opacity="0.16"/>` +
    `<stop offset="0.55" stop-color="${GOLD}" stop-opacity="0.05"/>` +
    `<stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${PAPER}"/>` +
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>` +
    `<g transform="translate(${donutX} ${donutY}) scale(${scale})" shape-rendering="crispEdges">${donut}</g>` +
    // The site's name, as the link preview sets it: Donut in white, Luxe in gold.
    `<text x="${left}" y="${nameY}" font-family="${DISPLAY}" font-weight="${DISPLAY_WEIGHT}" font-size="46"><tspan fill="${INK}">Donut</tspan><tspan fill="${GOLD}">Luxe</tspan></text>` +
    `<text x="${left}" y="${gameY}" font-family="${BODY}" font-weight="600" font-size="${whoSize}" fill="${MUTED}">` +
    `<tspan fill="${INK}">${escapeXml(card.playerName)}</tspan> won on ${escapeXml(card.gameName)}</text>` +
    `<text x="${left - 4}" y="${amountY}" font-family="${DISPLAY}" font-weight="${DISPLAY_WEIGHT}" font-size="${amountSize}" fill="${GOLD}">${escapeXml(amount)}</text>` +
    multiplier.svg +
    bet.svg +
    '</svg>'
  );
}

export function renderWinCard(card: WinCard): Buffer {
  return new Resvg(winCardSvg(card), renderOptions()).render().asPng();
}
