import { EmbedBuilder, type ColorResolvable } from 'discord.js';

/**
 * ui.ts — one voice for everything this bot says.
 *
 * Colour carries meaning here and nowhere else decides it: gold is the brand and the default,
 * green confirms, amber warns, red refuses. A handler that picked its own would make "did that
 * work?" a question about shade.
 */
export const COLOR = {
  brand: 0xffaa00,
  good: 0x43c464,
  warn: 0xffd700,
  bad: 0xe0563f,
  quiet: 0x2b2d31,
} as const satisfies Record<string, ColorResolvable>;

export function embed(title: string, description?: string, color: number = COLOR.brand) {
  const built = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) built.setDescription(description);
  return built;
}

export const ok = (title: string, description?: string) => embed(title, description, COLOR.good);
export const warn = (title: string, description?: string) => embed(title, description, COLOR.warn);
export const bad = (title: string, description?: string) => embed(title, description, COLOR.bad);

/**
 * Cuts a string to fit a Discord field without lying about having done so.
 *
 * Discord rejects the whole message when a field is over length, so an untruncated reason from a
 * moderator is not a long embed -- it is no embed, and an action that appears to have failed.
 */
export function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `1h30m`, `45s`, `7d` → seconds. Returns null for anything it cannot read, never a default. */
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(raw)) return null;
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
  let total = 0;
  for (const [, amount, unit] of raw.matchAll(/(\d+)([smhdw])/g)) {
    const scale = units[unit as string];
    if (scale === undefined) return null;
    total += Number(amount) * scale;
    // A duration nobody meant. Discord's own timeout ceiling is 28 days.
    if (total > 400 * 86_400) return null;
  }
  return total > 0 ? total : null;
}

/** Seconds → "1d 3h 20m", for reading back what was just parsed. */
export function humanDuration(seconds: number): string {
  const parts: string[] = [];
  const units: [string, number][] = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  let left = Math.max(0, Math.floor(seconds));
  for (const [suffix, scale] of units) {
    const value = Math.floor(left / scale);
    if (value > 0) parts.push(`${value}${suffix}`);
    left -= value * scale;
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

/** A Discord relative timestamp, which localises itself for every reader. */
export const relative = (when: Date) => `<t:${Math.floor(when.getTime() / 1000)}:R>`;
export const absolute = (when: Date) => `<t:${Math.floor(when.getTime() / 1000)}:f>`;

/**
 * Whole dollars → `$1.5b`, matching how the site writes money.
 *
 * The ledger is denominated in whole dollars despite the `_minor` column names: DonutSMP's own
 * figures arrive in hundredths and are divided down before anything is stored. Passing hundredths
 * in here would render every amount a hundred times too large, which is the kind of mistake that
 * looks like a jackpot.
 */
export function formatMoney(dollars: bigint): string {
  const negative = dollars < 0n;
  const value = negative ? -dollars : dollars;
  const sign = negative ? '-' : '';
  for (const [suffix, scale] of [
    ['t', 1_000_000_000_000n],
    ['b', 1_000_000_000n],
    ['m', 1_000_000n],
    ['k', 1_000n],
  ] as const) {
    if (value >= scale) {
      // One decimal, and only when it says something: "$1.0m" is noise, "$1.5m" is not.
      const whole = value / scale;
      const tenths = ((value % scale) * 10n) / scale;
      return tenths > 0n ? `${sign}$${whole}.${tenths}${suffix}` : `${sign}$${whole}${suffix}`;
    }
  }
  return `${sign}$${value}`;
}
