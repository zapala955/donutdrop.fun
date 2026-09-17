/* util.js — formatting, DOM helpers, shared item markup. */
import { RARITY, PLAYERS, RANKS } from './data.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/* $12.4M / $720K / $9,000 — DonutSMP balances run large.
 *
 * The ladder goes up to T. It previously stopped at B, so a trillion rendered as "$1000B" — which
 * is not wrong so much as unreadable, and the stake box accepts "1t" so the figure is reachable
 * by typing three characters. */
export function money(n) {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(Math.round(n));
  if (a >= 1e12) return sign + '$' + trim(a / 1e12) + 'T';
  if (a >= 1e9) return sign + '$' + trim(a / 1e9) + 'B';
  if (a >= 1e6) return sign + '$' + trim(a / 1e6) + 'M';
  if (a >= 1e3) return sign + '$' + trim(a / 1e3) + 'K';
  return sign + '$' + a.toLocaleString('en-US');
}
function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  // only strip zeros that sit after a decimal point — "240" must stay 240, not 24
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/* ─────────── amount input ───────────
 * Players type "1m", not "1000000". Balances here run to ten figures, so demanding every zero is
 * an invitation to typo one and stake ten times what was meant.
 *
 * Returns null for anything it cannot read, rather than 0 — a field that silently becomes zero
 * when you fat-finger it is how someone stakes nothing and thinks they staked everything.
 * Deliberately rejects negatives and exponent notation: neither is ever a stake a human meant.
 */
const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.trunc(input) : null;
  const raw = String(input ?? '').trim().toLowerCase().replace(/[\s,_$]/g, '');
  if (!raw) return null;

  const match = /^(\d+(?:\.\d+)?)([kmbt])?$/.exec(raw);
  if (!match) return null;

  const [, digits, suffix] = match;
  const base = Number(digits);
  if (!Number.isFinite(base)) return null;

  const scaled = suffix ? base * SUFFIXES[suffix] : base;
  // Beyond this, doubles stop representing whole numbers exactly and the figure shown would not
  // be the figure sent.
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) return null;
  return Math.trunc(scaled);
}

/* The inverse: the shortest string that parseAmount turns back into this exact number, so a field
 * can be re-rendered as "1.5m" without the value drifting on the round trip. */
export function formatAmountInput(value) {
  const n = Math.trunc(Number(value) || 0);
  if (n <= 0) return '0';
  for (const [suffix, scale] of [['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]]) {
    if (n >= scale && n % (scale / 100) === 0) {
      const scaled = n / scale;
      return (Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + suffix;
    }
  }
  return String(n);
}

export const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Weighted draw from a pool of item objects, using rarity weight. */
export function drawItem(items) {
  const total = items.reduce((s, it) => s + RARITY[it.rarity].weight, 0);
  let roll = Math.random() * total;
  for (const it of items) {
    roll -= RARITY[it.rarity].weight;
    if (roll <= 0) return it;
  }
  return items[items.length - 1];
}

export function oddsFor(items) {
  const total = items.reduce((s, it) => s + RARITY[it.rarity].weight, 0);
  return items
    .map((it) => ({ it, p: RARITY[it.rarity].weight / total }))
    .sort((a, b) => a.p - b.p);
}

/* One item tile. `size` drives the art box; used in reels, grids and results. */
export function itemTile(item, opts = {}) {
  const { value = true, sub = null, size = 'md' } = opts;
  const r = RARITY[item.rarity];
  const n = el('div', 'tile tile--' + size);
  n.style.setProperty('--rar', r.color);
  n.dataset.rarity = item.rarity;
  n.innerHTML =
    '<div class="tile__art"><img src="' + item.img + '" alt="" loading="lazy" draggable="false"></div>' +
    '<div class="tile__name">' + item.name + '</div>' +
    (value ? '<div class="tile__val">' + money(item.value) + '</div>' : '') +
    (sub ? '<div class="tile__sub">' + sub + '</div>' : '');
  return n;
}

/* Deterministic-ish fake player identity for feeds and chat. */
export function fakePlayer() {
  const name = pick(PLAYERS);
  const rank = pick(RANKS);
  return { name, rank };
}

/* Mock provably-fair commitment shown before every roll. */
export function fairSeed() {
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[(Math.random() * 16) | 0]).join('');
  return { server: hex(40), client: hex(16), nonce: (Math.random() * 99999) | 0 };
}

/* Pixel-art sprites must never be smoothed; enforce at the element level too. */
export function pixelate(img) {
  img.style.imageRendering = 'pixelated';
  return img;
}

/* ─────────── URL guards ───────────
 *
 * Every image on this site comes from somewhere the client does not control: catalog_items.
 * image_url in the database, a crate's metadata, a drop's art. Those are not "user input" in the
 * way a chat message is, but they are values that arrive over the network and end up in a DOM
 * sink, and that is the only property that matters when deciding whether to trust one.
 *
 * Assigning a property (img.src = value) already makes attribute breakout impossible — the very
 * thing that made the old interpolated `src="${item.img}"` dangerous. This adds the second half:
 * a scheme allowlist, so a stored `javascript:` or `data:text/html` URL cannot be navigated to if
 * that same string is ever put on an <a href> or a CSS url().
 *
 * Relative paths are the normal case and pass through untouched. Anything absolute must be http,
 * https, or a data: URL that really is an image. Everything else collapses to a transparent
 * pixel, so a bad value renders as nothing instead of becoming a vector.
 */
const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function safeImage(url) {
  if (typeof url !== 'string' || url === '') return BLANK_PIXEL;
  // A control character or whitespace inside a scheme is how "java\nscript:" gets past a filter.
  const trimmed = url.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return BLANK_PIXEL;

  // Relative: no scheme and not protocol-relative. The overwhelmingly common case.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//')) return trimmed;

  let parsed;
  try {
    parsed = new URL(trimmed, document.baseURI);
  } catch {
    return BLANK_PIXEL;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  // data: is allowed only when it genuinely declares a raster image type.
  if (parsed.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(trimmed)) {
    return trimmed;
  }
  return BLANK_PIXEL;
}

/**
 * Guards a URL destined for an <a href>.
 *
 * Stricter than safeImage: data: is refused outright, because a data: document navigated to from
 * a link runs in a context the page cannot vouch for.
 */
export function safeHref(url) {
  if (typeof url !== 'string' || url === '') return '#';
  const trimmed = url.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '#';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//')) return trimmed;
  try {
    const parsed = new URL(trimmed, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

/**
 * Digit grouping that does not follow the machine's locale.
 *
 * toLocaleString() with no argument renders 1000000 as "1.000.000" on a German Windows box, which
 * on an English page reading "1 in 1.000.000" looks like a decimal and states odds a thousand
 * times better than the real ones. Every figure on this site is written in English, so the
 * grouping is pinned to match rather than left to the host.
 */
export function grouped(value) {
  const n = Math.round(Number(value) || 0);
  return n.toLocaleString('en-US');
}
