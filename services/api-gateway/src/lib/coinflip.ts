import { createHmac } from 'node:crypto';

/**
 * coinflip.ts — the rules of a 1v1 coinflip, with no database and no network in them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PLAYER AGAINST PLAYER, SO THE HOUSE HAS NO SIDE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Two stakes go into one pot and one player takes it. The house does not bet, cannot lose and
 * charges no edge on the result; it is paid a rake on the pot, exactly like a skill duel, and the
 * pot split is the duel's `splitPot` so the two PvP modes cannot disagree about rounding.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHO CAN INFLUENCE THE COIN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The result is HMAC-SHA256 keyed by the server seed over both players' client seeds:
 *
 *     digest = HMAC_SHA256(serverSeed, "coinflip:" + hostClientSeed + ":" + opponentClientSeed)
 *     side   = digest[0] < 128 ? "heads" : "tails"
 *
 * The server seed is generated and its hash published when the host opens the game, before anyone
 * else has seen it, so the server cannot pick a seed after the fact. The host's seed and side are
 * fixed at creation; the opponent's seed is supplied when they join, so the opponent's choice
 * changes the digest — but they are choosing blind, because the server seed is only revealed once
 * the coin has landed. Nobody can steer the result, and anyone can recompute it from the reveal.
 *
 * One byte against 128 is an exact 50/50: half of the 256 byte values land on each side, with no
 * modulo bias to argue about.
 */

export type CoinSide = 'heads' | 'tails';

export const COIN_SIDES: readonly CoinSide[] = Object.freeze(['heads', 'tails']);

export interface FlipResult {
  readonly side: CoinSide;
  /** The full digest, hex, so the verification panel can show the byte the side was read from. */
  readonly digestHex: string;
}

export function flipCoin(
  serverSeed: string,
  hostClientSeed: string,
  opponentClientSeed: string,
): FlipResult {
  const digest = createHmac('sha256', serverSeed)
    .update(`coinflip:${hostClientSeed}:${opponentClientSeed}`)
    .digest();
  return { side: digest[0]! < 128 ? 'heads' : 'tails', digestHex: digest.toString('hex') };
}

export function otherSide(side: CoinSide): CoinSide {
  return side === 'heads' ? 'tails' : 'heads';
}

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AGAINST THE HOUSE (2026-11-20)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The owner: "just make coinflip a normal coinflip game". One player, one stake, heads or tails,
 * settled in one request like Dice (routes/coinflip-house.ts). The coin is read the same way as
 * above, from the message every seeded house game signs:
 *
 *     digest = HMAC_SHA256(serverSeed, clientSeed + ":" + nonce)
 *     side   = digest[0] < 128 ? "heads" : "tails"
 *
 * so the fairness page checks it with the reading it already has. A call that matches the coin pays
 * the stake times HOUSE_FLIP_PAYOUT_BPS / 10,000, floored: 1.8x.
 */
export const HOUSE_FLIP_PAYOUT_BPS = 18_000;

export function houseFlip(serverSeed: string, clientSeed: string, nonce: number): FlipResult {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest();
  return { side: digest[0]! < 128 ? 'heads' : 'tails', digestHex: digest.toString('hex') };
}

/** What a winning call pays, floored. */
export function houseFlipPayout(stakeMinor: bigint): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  return (stakeMinor * BigInt(HOUSE_FLIP_PAYOUT_BPS)) / 10_000n;
}
