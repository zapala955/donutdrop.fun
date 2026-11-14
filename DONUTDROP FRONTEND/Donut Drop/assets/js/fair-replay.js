/* fair-replay.js — the Provably Fair page's arithmetic, run in the player's own browser.
 *
 * Nothing here asks the server anything: a check that depends on the server being audited is no
 * check. SHA-256 and HMAC-SHA256 are the browser's own (WebCrypto); the formulas are the games' own,
 * line for line (services/api-gateway/src/lib: dice.ts drawFraction/diceRoll, limbo.ts limboResult,
 * @donut/provably-fair createFairRoll, coinflip.ts flipCoin). tests/fairness-page.test.ts runs these
 * against the server's functions on thousands of random seeds, so the page and the house cannot
 * disagree about a round.
 */
const encoder = new TextEncoder();
const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a text, as hex: what a revealed seed must hash to. */
export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** HMAC-SHA256 of `message`, keyed with the server seed (its text, as UTF-8), as hex. */
export async function hmacHex(serverSeed, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

const TWO_POW_52 = 2 ** 52;

/** The draw every game makes from a digest: its first 13 hex digits (52 bits) as a share of 2^52. */
export const fractionOf = (digestHex) => Number.parseInt(digestHex.slice(0, 13), 16) / TWO_POW_52;

/** Dice: the roll, 0..9999 (shown as 0.00..99.99). */
export const diceRoll = (digestHex) => Math.floor(fractionOf(digestHex) * 10_000);

/** Limbo: the drawn multiplier in hundredths, floor(90 * 2^52 / (2^52 - n)), capped at 1,000,000x. */
export function limboResultX100(digestHex) {
  const n = BigInt(Math.round(fractionOf(digestHex) * TWO_POW_52));
  const span = 2n ** 52n;
  const raw = (90n * span) / (span - n);
  return Number(raw > 100_000_000n ? 100_000_000n : raw);
}

/** The upgrader's and the cases' roll, in parts per million of a full turn. */
export const rollPpm = (digestHex) => Math.floor(fractionOf(digestHex) * 1_000_000);

/** Crash: the crash point in hundredths, (10000 - edge) * 2^52 / (100 * (2^52 - h)), from 1.00x to 1,000x. */
export function crashPointX100(digestHex, edgeBps) {
  const h = BigInt(`0x${digestHex.slice(0, 13)}`);
  const span = 2n ** 52n;
  const raw = (BigInt(10_000 - edgeBps) * span) / (100n * (span - h));
  if (raw < 100n) return 100;
  return raw > 100_000n ? 100_000 : Number(raw);
}

/** Roulette: the pocket, 0..36, from the round's own draw (roulette.ts: floor(roll * 37)). */
export const roulettePocket = (digestHex) => Math.floor(fractionOf(digestHex) * 37);

/** Coinflip: heads when the digest's first byte is below 128. */
export const coinflipSide = (digestHex) => (Number.parseInt(digestHex.slice(0, 2), 16) < 128 ? 'heads' : 'tails');
