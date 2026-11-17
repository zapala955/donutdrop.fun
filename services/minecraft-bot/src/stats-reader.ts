/**
 * Reads DonutSMP's /stats.
 *
 * The owner, 2026-11-17: "make sure it gets the stats by running /stats on donutsmp". The stats bot
 * runs `/stats <player>` and keeps everything the server sends back for a few seconds: a menu's title
 * and every item in it (name and lore), the chat lines, and a dialog's text if the server answers with
 * one (DonutSMP moved some answers into menus and dialogs with 26.3). This turns that into the seven
 * figures the card shows. It does not assume where on the menu a figure sits or how the server words
 * it: a figure is found by its label (Money, Shards, Kills, ...) wherever it appears, as "Label: value"
 * on one line or as an item named for the figure with the value in its lore.
 */

export const STAT_KEYS = ['money', 'shards', 'kills', 'deaths', 'playtime', 'blocksPlaced', 'blocksBroken'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export interface StatValue {
  /** As the server wrote it, cleaned of colour codes and icons: "$1.24B", "41d 7h". */
  readonly display: string;
  /** As a number: dollars, seconds of playtime, or a count. Null when it does not read as one. */
  readonly value: number | null;
}
export type PlayerStats = Partial<Record<StatKey, StatValue>>;

export interface StatsItem {
  readonly slot: number;
  readonly name: string;
  readonly lore: readonly string[];
}

export interface StatsCapture {
  title?: string;
  items: StatsItem[];
  chat: string[];
  dialog: string[];
}

export type StatsReading =
  | { outcome: 'found'; stats: PlayerStats; shownName?: string }
  | { outcome: 'not_found' }
  | { outcome: 'unreadable' };

/** Text as a person reads it: no § colour codes, no private-use icon glyphs or emoji, single spaces. */
export function cleanText(text: string): string {
  return text
    .replace(/§[0-9a-fk-orx]/gi, '')
    .replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\u2000-\u200B\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXCLUDE_MONEY = /spent|made|earn|sell|sold|shop|bounty|worth|sent|received|paid|pay/;

/** Which figure a label names, if any. */
export function statKeyFor(label: string): StatKey | undefined {
  const text = cleanText(label).toLowerCase();
  if (!text || text.length > 40) return undefined;
  if (/\bshards?\b/.test(text)) return 'shards';
  if (/play ?time|time played|time online|online time/.test(text)) return 'playtime';
  if (/\bplaced\b|blocks? place/.test(text)) return 'blocksPlaced';
  if (/\bbroken\b|\bbroke\b|\bmined\b|blocks? (broken|break|mined)/.test(text)) return 'blocksBroken';
  if (/\bdeaths?\b|\bdied\b/.test(text)) return 'deaths';
  if (/\bkills?\b/.test(text) && !/\bmobs?\b|entit|animal|monster/.test(text)) return 'kills';
  if (/\b(money|balance|bal|cash)\b/.test(text) && !EXCLUDE_MONEY.test(text)) return 'money';
  return undefined;
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mil: 1e6, million: 1e6,
  b: 1e9, bil: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
  q: 1e15, quadrillion: 1e15,
};

/** "$1.24B" -> 1240000000, "18,450" -> 18450, "12.5k" -> 12500. Null when there is no figure in it. */
export function parseAmount(text: string): number | null {
  const match = cleanText(text).match(/(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(quadrillion|trillion|billion|million|thousand|bil|mil|[kmbtq])?(?![a-z])/i);
  if (!match) return null;
  const digits = match[1]!.replace(/,/g, '');
  const base = Number(digits);
  if (!Number.isFinite(base)) return null;
  const scale = match[2] ? (SCALE[match[2].toLowerCase()] ?? 1) : 1;
  const value = base * scale;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(y|yr|yrs|year|years)$/, 365 * 86_400],
  [/^(w|wk|wks|week|weeks)$/, 7 * 86_400],
  [/^(d|day|days)$/, 86_400],
  [/^(h|hr|hrs|hour|hours)$/, 3_600],
  [/^(m|min|mins|minute|minutes)$/, 60],
  [/^(s|sec|secs|second|seconds)$/, 1],
];

/** "41d 7h 3m" or "2 days, 5 hours" -> seconds. Null when no part of it carries a unit. */
export function parseDuration(text: string): number | null {
  let total = 0;
  let found = false;
  for (const match of cleanText(text).toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const unit = UNIT_SECONDS.find(([pattern]) => pattern.test(match[2]!));
    if (!unit) continue;
    total += Number(match[1]) * unit[1];
    found = true;
  }
  return found ? Math.round(total) : null;
}

/** A figure from the text after its label, or undefined when there is no figure in it. */
function valueOf(key: StatKey, raw: string): StatValue | undefined {
  const display = cleanText(raw).replace(/^[:\s»>|\-–]+/, '').slice(0, 40).trim();
  if (!display || !/\d/.test(display)) return undefined;
  if (key === 'playtime') {
    const seconds = parseDuration(display);
    // A bare number of hours ("312") is the one other way playtime is written.
    return { display, value: seconds ?? null };
  }
  return { display, value: parseAmount(display) };
}

const NOT_FOUND = /not found|could ?n'?o?t find|never (joined|played|been)|has ?n'?o?t (joined|played)|does ?n'?o?t exist|doesn'?t exist|no (such )?player|unknown player|invalid player|is not a player|player .*(not|never)/i;
const INSTRUCTION = /click|press|right-?click|left-?click|to view|to open|to see|back|close|page/i;
const LABELLED = /^(.{1,40}?)\s*(?::|：|»|➜|→|=|\|| - | – )\s*(.+)$/;

/** Turns what /stats showed into the figures, or says the player does not exist, or that it could not tell. */
export function readStats(capture: StatsCapture, player: string): StatsReading {
  const stats: PlayerStats = {};
  const take = (key: StatKey | undefined, raw: string) => {
    if (!key || stats[key]) return;
    const value = valueOf(key, raw);
    if (value) stats[key] = value;
  };

  const items = [...capture.items].sort((a, b) => a.slot - b.slot);
  for (const item of items) {
    const name = cleanText(item.name);
    const lore = item.lore.map(cleanText).filter((line) => line && !INSTRUCTION.test(line));
    // "Label: value" on any line of the item.
    for (const line of [name, ...lore]) {
      const labelled = line.match(LABELLED);
      if (labelled) take(statKeyFor(labelled[1]!), labelled[2]!);
    }
    // An item named for the figure, its value the first figure in its lore.
    const named = statKeyFor(name);
    if (named && !stats[named]) {
      const line = lore.find((candidate) => /\d/.test(candidate) && !LABELLED.test(candidate)) ?? lore.find((candidate) => /\d/.test(candidate));
      if (line) take(named, line.match(LABELLED)?.[2] ?? line);
    }
    // "1,234 Kills": the figure before its label.
    for (const line of [name, ...lore]) {
      const trailing = line.match(/^([$]?\s*[\d.,]+\s*[kmbtq]?)\s+([a-z][a-z ]{2,30})$/i);
      if (trailing) take(statKeyFor(trailing[2]!), trailing[1]!);
    }
  }
  for (const line of [...capture.dialog, ...capture.chat].map(cleanText)) {
    const labelled = line.match(LABELLED);
    if (labelled) take(statKeyFor(labelled[1]!), labelled[2]!);
  }

  if (STAT_KEYS.some((key) => stats[key])) {
    const shownName = shownNameIn([capture.title ?? '', ...items.map((item) => item.name), ...capture.dialog, ...capture.chat], player);
    return { outcome: 'found', stats, ...(shownName ? { shownName } : {}) };
  }
  const said = [capture.title ?? '', ...capture.chat, ...capture.dialog].map(cleanText);
  if (said.some((line) => NOT_FOUND.test(line))) return { outcome: 'not_found' };
  return { outcome: 'unreadable' };
}

/** The player's name as the server spelled it, if it shows it anywhere (a menu's title, a head). */
function shownNameIn(texts: string[], player: string): string | undefined {
  const wanted = player.toLowerCase();
  for (const text of texts) {
    for (const token of cleanText(text).split(/[^A-Za-z0-9_.]+/)) {
      const name = token.replace(/'s$/i, '');
      if (name.toLowerCase() === wanted && /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/.test(name)) return name;
    }
  }
  return undefined;
}

/**
 * A player-head's skin, from anywhere inside an item: the texture property is base64 JSON naming the
 * skin's URL on Mojang's texture host. Only that host is accepted.
 */
export function skinUrlIn(value: unknown, depth = 0): string | undefined {
  if (depth > 12 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    if (!/^eyJ[A-Za-z0-9+/=]{20,}$/.test(value)) return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: unknown } } };
      const url = decoded.textures?.SKIN?.url;
      return typeof url === 'string' && /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{20,80}$/.test(url)
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    const found = skinUrlIn(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** What is kept of the capture for checking the reader against the real menu: bounded, plain text. */
export function trimCapture(capture: StatsCapture): StatsCapture {
  return {
    ...(capture.title ? { title: cleanText(capture.title).slice(0, 300) } : {}),
    items: capture.items.slice(0, 80).map((item) => ({
      slot: item.slot,
      name: cleanText(item.name).slice(0, 300),
      lore: item.lore.slice(0, 40).map((line) => cleanText(line).slice(0, 300)),
    })),
    chat: capture.chat.slice(0, 40).map((line) => cleanText(line).slice(0, 500)),
    dialog: capture.dialog.slice(0, 60).map((line) => cleanText(line).slice(0, 500)),
  };
}
