/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4
 * Hallmark · component: share image (stats card) · genre: modern-minimal · theme: project system
 * (obsidian ladder --lx-1/--lx-2 + gold --lx-gold, Archivo 900 + Figtree) · tone: luxury, restrained
 * no glow, no gradient text, no italics, no icon-tile grid; icons inline (one set, Lucide); Geist
 */
import { Resvg } from '@resvg/resvg-js';
import { DONUT } from './card-art.js';
import { STAT_LABELS, type PlayerStats, type StatKey, type StatValue } from './player-stats.js';
import { statIcon } from './stat-icons.js';
import { CARD_THEME, escapeXml, measureText, renderOptions } from './win-card.js';

/**
 * The stats card: the picture /stats answers with in Discord.
 *
 * The owner, 2026-11-17: "a photo whould be better", "make sure the stat photos have a watermark too",
 * then "it looks ass and the text from donutsmp /stats is useless ... more premium", then "font is ass
 * and make it so theres actual icons for money etc and the players skins takes up too much of the
 * space". So: the player's face, small, beside their name; money as the one gold figure, shards and
 * playtime beside it; fighting and building as a ruled list; an icon (one set, Lucide) on every
 * figure; Geist throughout, the wordmark alone in the site's Archivo. Flat, on the site's obsidian
 * ladder, no glow. The watermark is the DonutLuxe donut as a faint monogram over the whole ground, so
 * no crop comes away without it, with the wordmark at the top and the address at the foot.
 */

export const STATS_CARD_WIDTH = 1200;
export const STATS_CARD_HEIGHT = 675;

const { GOLD, INK, MUTED, DISPLAY, DISPLAY_WEIGHT } = CARD_THEME;
/* The card's face: Geist (assets/fonts, OFL), one family from 500 to 800. The wordmark alone keeps the
 * site's Archivo, because it is the logo. */
const FACE = 'Geist';

/** A small colour beside each figure, on its icon only: gold stays money's alone. */
const ACCENT: Record<StatKey, string> = {
  money: GOLD,
  shards: '#b98cff',
  kills: '#ff5c5c',
  deaths: '#9096a0',
  playtime: '#7fd8ff',
  blocksPlaced: '#3fbf86',
  blocksBroken: '#ff9f43',
};
// The site's obsidian ladder (assets/css/luxe.css): the page, a raised panel, a hairline.
const PAGE = '#121216';
const PANEL = '#1c1c22';
const RULE = '#2a2a32';

export interface StatsCard {
  /** The name as the server spelled it, or as the member typed it. */
  readonly player: string;
  readonly stats: PlayerStats;
  /** The player's skin as a PNG, when it could be fetched; the figure is cut from it. */
  readonly skinPng?: Buffer | undefined;
  readonly fetchedAt: Date;
}

const trim = (x: number) => {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** 1.2K, 3.45M, 1.02B: what a count reads as when it is too long to print whole. */
function compact(value: number): string {
  if (value >= 1e12) return `${trim(value / 1e12)}T`;
  if (value >= 1e9) return `${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}K`;
  return Math.round(value).toLocaleString('en-US');
}

/** Seconds as the largest two units: 12d 4h, 5h 30m, 42m. */
export function playtimeText(seconds: number): string {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days.toLocaleString('en-US')}d ${hours}h` : `${days.toLocaleString('en-US')}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A figure as the card prints it: from the number when there is one, else as the server wrote it. */
export function statText(key: StatKey, stat: StatValue | undefined): string {
  if (!stat) return '—';
  if (stat.value === null) return stat.display;
  if (key === 'money') return `$${compact(stat.value)}`;
  if (key === 'playtime') return playtimeText(stat.value);
  return stat.value >= 1e6 ? compact(stat.value) : Math.round(stat.value).toLocaleString('en-US');
}

/** The width and height a PNG says it has, from its header. */
function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The player's face, cut from their skin (the front of the head and the hat over it), pixel-sharp. */
function faceSvg(card: StatsCard, x: number, y: number, size: number): string {
  const tile = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="20" fill="${PANEL}"/>`;
  const box = card.skinPng ? pngSize(card.skinPng) : undefined;
  if (!card.skinPng || !box || box.width !== 64 || (box.height !== 64 && box.height !== 32)) {
    const initial = card.player.replace(/^\./, '').charAt(0).toUpperCase() || '?';
    return (
      tile +
      `<text x="${x + size / 2}" y="${y + size / 2 + 22}" text-anchor="middle" font-family="${FACE}" font-weight="800" font-size="62" fill="${MUTED}">${escapeXml(initial)}</text>`
    );
  }
  const href = `data:image/png;base64,${card.skinPng.toString('base64')}`;
  const image = `<image href="${href}" x="0" y="0" width="${box.width}" height="${box.height}" image-rendering="optimizeSpeed"/>`;
  const crop = (left: number) =>
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${left} 8 8 8" preserveAspectRatio="none">${image}</svg>`;
  return (
    `<defs><clipPath id="face"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="20"/></clipPath></defs>` +
    tile +
    `<g clip-path="url(#face)">${crop(8)}${crop(40)}</g>`
  );
}

/** The largest size, down to `min`, that sets `text` inside `width`. */
function fitSize(text: string, family: string, weight: number, max: number, min: number, width: number): number {
  let size = max;
  while (size > min && measureText(text, family, weight, size) > width) size -= 2;
  return size;
}

/** The donut at `scale` card pixels per sprite pixel; in one colour when `mono` is given. */
function donutSvg(x: number, y: number, scale: number, opacity = 1, mono?: string): string {
  const rects = DONUT.rects
    .map(([rx, ry, w, h, colour]) => `<rect x="${rx}" y="${ry}" width="${w}" height="${h}" fill="${mono ?? colour}"/>`)
    .join('');
  return `<g transform="translate(${x} ${y}) scale(${scale})" shape-rendering="crispEdges" opacity="${opacity}">${rects}</g>`;
}

/** The donut repeated in a half-drop grid across the card, one pale tone: the watermark. */
function monogram(): string {
  const scale = 2.5; // 40 px a donut
  const across = 132;
  const down = 96;
  const marks: string[] = [];
  for (let row = 0; row * down < STATS_CARD_HEIGHT + down; row += 1) {
    for (let col = -1; col * across < STATS_CARD_WIDTH + across; col += 1) {
      marks.push(`<use href="#mark" x="${col * across + (row % 2) * (across / 2)}" y="${row * down - 20}"/>`);
    }
  }
  const rects = DONUT.rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('');
  return (
    `<defs><g id="mark" transform="scale(${scale})" shape-rendering="crispEdges">${rects}</g></defs>` +
    `<g fill="${INK}" opacity="0.035">${marks.join('')}</g>`
  );
}

/** One row of the ruled list: icon and name left, the figure right, a hairline under it. */
function row(key: StatKey, stat: StatValue | undefined, x: number, baseline: number, width: number, rule: boolean): string {
  const label = STAT_LABELS[key];
  const labelX = x + 40;
  const labelWidth = measureText(label, FACE, 500, 24);
  const value = statText(key, stat);
  const size = fitSize(value, FACE, 700, 32, 22, width - (labelX - x) - labelWidth - 28);
  return (
    statIcon(key, x, baseline - 23, 26, ACCENT[key]) +
    `<text x="${labelX}" y="${baseline}" font-family="${FACE}" font-weight="500" font-size="24" fill="${MUTED}">${escapeXml(label)}</text>` +
    `<text x="${x + width}" y="${baseline}" text-anchor="end" font-family="${FACE}" font-weight="700" font-size="${size}" fill="${stat ? INK : MUTED}" letter-spacing="-0.5">${escapeXml(value)}</text>` +
    (rule ? `<rect x="${x}" y="${baseline + 23}" width="${width}" height="1.5" fill="${RULE}"/>` : '')
  );
}

/** The card as SVG. Exported so its text can be checked without decoding a picture. */
export function statsCardSvg(card: StatsCard): string {
  const margin = 64;
  const width = STATS_CARD_WIDTH - margin * 2;

  // The head: the face, the name beside it, the wordmark right.
  const faceSize = 116;
  const nameX = margin + faceSize + 32;
  const brandSize = 30;
  const brandWidth = Math.ceil(measureText('DonutLuxe', DISPLAY, DISPLAY_WEIGHT, brandSize));
  // The name alone beside the face (the owner: "remove the donutsmp text ... to make the ign bigger"),
  // centred on it.
  const nameSize = fitSize(card.player, FACE, 700, 80, 36, STATS_CARD_WIDTH - margin - nameX - brandWidth - 80);
  const nameBaseline = margin + Math.round(faceSize / 2 + nameSize * 0.36);

  // Money, the one gold figure; shards and playtime beside it, a size down, in the same voice.
  const ruleY = margin + faceSize + 34;
  const moneyLabel = ruleY + 62;
  const sideWidth = 236;
  const sideX = STATS_CARD_WIDTH - margin - sideWidth * 2;
  const money = statText('money', card.stats.money);
  const moneySize = fitSize(money, FACE, 800, 104, 56, sideX - margin - 40);
  const moneyBaseline = moneyLabel + 22 + 83;
  const side = (['shards', 'playtime'] as const)
    .map((key, index) => {
      const x = sideX + index * sideWidth;
      const value = statText(key, card.stats[key]);
      const size = fitSize(value, FACE, 700, 64, 28, sideWidth - 24);
      return (
        statIcon(key, x, moneyLabel - 23, 26, ACCENT[key]) +
        `<text x="${x + 38}" y="${moneyLabel}" font-family="${FACE}" font-weight="500" font-size="24" fill="${MUTED}">${STAT_LABELS[key]}</text>` +
        `<text x="${x - 2}" y="${moneyBaseline}" font-family="${FACE}" font-weight="700" font-size="${size}" fill="${card.stats[key] ? INK : MUTED}" letter-spacing="-1">${escapeXml(value)}</text>`
      );
    })
    .join('');

  // Fighting and building: two columns of two, ruled between rows.
  const gap = 64;
  const column = (width - gap) / 2;
  const listTop = moneyBaseline + 106;
  const step = 74;
  const columns: StatKey[][] = [
    ['kills', 'deaths'],
    ['blocksPlaced', 'blocksBroken'],
  ];
  const list = columns
    .flatMap((keys, col) =>
      keys.map((key, index) =>
        row(key, card.stats[key], margin + col * (column + gap), listTop + index * step, column, index < keys.length - 1),
      ),
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${STATS_CARD_WIDTH}" height="${STATS_CARD_HEIGHT}" viewBox="0 0 ${STATS_CARD_WIDTH} ${STATS_CARD_HEIGHT}">` +
    `<rect width="${STATS_CARD_WIDTH}" height="${STATS_CARD_HEIGHT}" fill="${PAGE}"/>` +
    // The watermark: the donut as a monogram, small and faint, repeated over the whole ground, so no
    // crop of the card comes away without it.
    monogram() +
    faceSvg(card, margin, margin, faceSize) +
    `<text x="${nameX}" y="${nameBaseline}" font-family="${FACE}" font-weight="700" font-size="${nameSize}" fill="${INK}" letter-spacing="-2">${escapeXml(card.player)}</text>` +
    // The wordmark, as the site sets it: the donut, Donut in white, Luxe in gold.
    donutSvg(STATS_CARD_WIDTH - margin - brandWidth - 42, margin + faceSize / 2 - 18, 2.25) +
    `<text x="${STATS_CARD_WIDTH - margin}" y="${margin + faceSize / 2 + 11}" text-anchor="end" font-family="${DISPLAY}" font-weight="${DISPLAY_WEIGHT}" font-size="${brandSize}"><tspan fill="${INK}">Donut</tspan><tspan fill="${GOLD}">Luxe</tspan></text>` +
    `<rect x="${margin}" y="${ruleY}" width="${width}" height="1.5" fill="${RULE}"/>` +
    statIcon('money', margin, moneyLabel - 24, 28, GOLD) +
    `<text x="${margin + 42}" y="${moneyLabel}" font-family="${FACE}" font-weight="500" font-size="24" fill="${MUTED}">Money</text>` +
    `<text x="${margin - 4}" y="${moneyBaseline}" font-family="${FACE}" font-weight="800" font-size="${moneySize}" fill="${
      card.stats.money ? GOLD : MUTED
    }" letter-spacing="-3">${escapeXml(money)}</text>` +
    side +
    `<rect x="${margin}" y="${listTop - 58}" width="${width}" height="1.5" fill="${RULE}"/>` +
    list +
    `<text x="${STATS_CARD_WIDTH - margin}" y="${STATS_CARD_HEIGHT - 36}" text-anchor="end" font-family="${FACE}" font-weight="600" font-size="20" fill="${MUTED}">donutluxe.com</text>` +
    '</svg>'
  );
}

export function renderStatsCard(card: StatsCard): Buffer {
  return new Resvg(statsCardSvg(card), renderOptions()).render().asPng();
}

/* ── The skin ──────────────────────────────────────────────────────────────────────────────────
 * From the skin the server showed on the /stats menu's head when the bot could read it, else from
 * Mojang by name (Java names only: a Bedrock player has no Java profile). Only ever Mojang's own
 * hosts, two and a half seconds each, kept for a while; a card without a skin is still a card. */

const skins = new Map<string, { png: Buffer | null; at: number }>();
const SKIN_KEEP_MS = 30 * 60_000;
const MAX_SKIN_BYTES = 64 * 1024;

function remember(key: string, png: Buffer | null): Buffer | null {
  if (skins.size > 300) skins.delete(skins.keys().next().value as string);
  skins.set(key, { png, at: Date.now() });
  return png;
}

async function fetchPng(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_500), redirect: 'error' });
  if (!response.ok) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_SKIN_BYTES || !pngSize(body)) return null;
  return body;
}

async function skinUrlFromMojang(player: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(player)) return null;
  const profile = await fetch(`https://api.mojang.com/users/profiles/minecraft/${player}`, {
    signal: AbortSignal.timeout(2_500),
    redirect: 'error',
  });
  if (profile.status !== 200) return null;
  const { id } = (await profile.json()) as { id?: unknown };
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null;
  const session = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {
    signal: AbortSignal.timeout(2_500),
    redirect: 'error',
  });
  if (session.status !== 200) return null;
  const { properties } = (await session.json()) as { properties?: { name?: unknown; value?: unknown }[] };
  const textures = properties?.find((property) => property.name === 'textures')?.value;
  if (typeof textures !== 'string') return null;
  const decoded = JSON.parse(Buffer.from(textures, 'base64').toString('utf8')) as {
    textures?: { SKIN?: { url?: unknown } };
  };
  const url = decoded.textures?.SKIN?.url;
  return typeof url === 'string' ? url : null;
}

/** The player's skin as a PNG, or undefined: from `skinUrl` (Mojang's texture host only) or by name. */
export async function playerSkin(
  player: string,
  skinUrl: string | null,
  isSkinUrl: (url: string) => boolean,
): Promise<Buffer | undefined> {
  const key = skinUrl ?? `name:${player.toLowerCase()}`;
  const kept = skins.get(key);
  if (kept && Date.now() - kept.at < SKIN_KEEP_MS) return kept.png ?? undefined;
  try {
    const url = skinUrl ?? (await skinUrlFromMojang(player));
    if (!url || !isSkinUrl(url)) return remember(key, null) ?? undefined;
    return remember(key, await fetchPng(url.replace(/^http:/, 'https:'))) ?? undefined;
  } catch {
    return remember(key, null) ?? undefined;
  }
}
