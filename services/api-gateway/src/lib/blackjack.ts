import { createHmac } from 'node:crypto';

/**
 * Blackjack: the rules, the cards and the arithmetic. No database, no wallet -- routes/blackjack.ts
 * owns those, so everything here can be tested exhaustively and replayed by anybody verifying a
 * hand from its revealed seed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES, AND WHERE THE EDGE COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Ordinary blackjack gives the house about one per cent. This table is priced at the site's ten,
 * and gets there through the one number every player reads before they play: WHAT A WIN PAYS.
 * A won hand returns 1.8x what was on it -- the stake back and 80% on top -- where a standard
 * table returns 2x. Everything else is the familiar game, ties included.
 *
 *   a win pays .................. 1.8x the amount on the table (stake back + 80%)
 *   blackjack pays .............. 2.5x the stake (3:2)
 *   a tie ....................... pushes: the whole amount on the table comes back
 *   dealer ...................... hits soft 17, peeks for blackjack
 *   double ...................... on any first two cards, one more card
 *   split, insurance, surrender . not offered
 *   deck ........................ infinite: every card is its own draw from all 52 faces
 *
 * Under those rules the house edge against PERFECT play is 9.87% (exact infinite-deck
 * calculation, reproduced in tests/blackjack.test.ts). Anything short of perfect play costs the
 * player more, as it does at every blackjack table. (Until 2026-09-25 the edge came from the
 * dealer winning ties at even-money payouts; the operator asked for ties to push instead.)
 */
export const BLACKJACK_HOUSE_EDGE_BPS = 987;

/** Total returned per unit on the table, in basis points: 18,000 is 1.8x. */
export const WIN_RETURN_BPS = 18_000n;
/** Total returned per unit staked on a natural: 25,000 is 2.5x, which is 3:2. */
export const BLACKJACK_RETURN_BPS = 25_000n;

export const BLACKJACK_RULES = Object.freeze({
  tiesPush: true,
  winPays: '1.8x',
  blackjackPays: '2.5x',
  dealerHitsSoft17: true,
  doubleOnAnyTwo: true,
  split: false,
  insurance: false,
  infiniteDeck: true,
});

export type BlackjackOutcome =
  | 'blackjack' // natural 21 against no dealer blackjack: 2.5x the stake
  | 'win' // beat the dealer, or the dealer busted: 1.8x what was on the table
  | 'push' // equal totals, blackjack against blackjack included: the table comes back
  | 'lose' // the dealer's total was higher
  | 'bust' // the player went over 21
  | 'dealer_blackjack'; // the dealer's natural, found on the peek

/** Card positions in the committed sequence. Everything after the fourth is drawn in play order. */
export const DEAL_ORDER = Object.freeze({ player: [0, 2], dealer: [1, 3], next: 4 });

/**
 * The card at `position` in a hand's sequence, as a face 0..51 (rank = face % 13, suit =
 * floor(face / 13); rank 0 is the ace, 9..12 are 10 J Q K).
 *
 * Every card is a separate HMAC of the committed server seed, so the whole sequence is fixed the
 * moment the hand is dealt -- before the player's first decision, and before the server knows
 * what those decisions will be. Same construction as the upgrader's roll, with the position
 * appended: `HMAC-SHA256(serverSeed, "${clientSeed}:${nonce}:${position}")`, first 52 bits as a
 * fraction of one, times 52.
 */
export function drawCard(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  position: number,
): number {
  if (!/^[a-f0-9]{64}$/.test(serverSeed)) throw new TypeError('serverSeed must be 64 hex chars');
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new RangeError('nonce must be >= 0');
  if (!Number.isInteger(position) || position < 0 || position > 63) {
    throw new RangeError('position must be 0..63');
  }
  const digest = createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${position}`, 'utf8')
    .digest('hex');
  const sample = Number.parseInt(digest.slice(0, 13), 16) / 4_503_599_627_370_496;
  return Math.floor(sample * 52);
}

/** A face's blackjack value: aces count 11 until that would bust the hand. */
export function cardValue(face: number): number {
  const rank = face % 13;
  if (rank === 0) return 11;
  return rank >= 9 ? 10 : rank + 1;
}

export interface HandTotal {
  total: number;
  /** An ace is still being counted as 11. */
  soft: boolean;
}

export function handTotal(faces: readonly number[]): HandTotal {
  let total = 0;
  let aces = 0;
  for (const face of faces) {
    total += cardValue(face);
    if (face % 13 === 0) aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function isBlackjack(faces: readonly number[]): boolean {
  return faces.length === 2 && handTotal(faces).total === 21;
}

/** The dealer draws to 16 and on soft 17. */
export function dealerShouldHit(faces: readonly number[]): boolean {
  const { total, soft } = handTotal(faces);
  return total < 17 || (total === 17 && soft);
}

/** Whether the dealer's up card obliges a peek: an ace or anything worth ten. */
export function dealerPeeks(upCard: number): boolean {
  return cardValue(upCard) >= 10;
}

/**
 * The result of a finished hand where neither side had a natural. `playerFaces` must not be
 * bust -- a bust is settled the moment it happens and the dealer never plays.
 */
export function compareHands(
  playerFaces: readonly number[],
  dealerFaces: readonly number[],
): 'win' | 'push' | 'lose' {
  const player = handTotal(playerFaces).total;
  const dealer = handTotal(dealerFaces).total;
  if (dealer > 21 || player > dealer) return 'win';
  return player === dealer ? 'push' : 'lose';
}

/**
 * What is paid back for a finished hand, stake included. `stakeMinor` is the ORIGINAL stake; a
 * doubled hand has twice that on the table. Fractions are rounded down to the whole dollar.
 */
export function payoutFor(outcome: BlackjackOutcome, stakeMinor: bigint, doubled: boolean): bigint {
  const onTable = doubled ? stakeMinor * 2n : stakeMinor;
  switch (outcome) {
    case 'blackjack':
      return (stakeMinor * BLACKJACK_RETURN_BPS) / 10_000n;
    case 'win':
      return (onTable * WIN_RETURN_BPS) / 10_000n;
    case 'push':
      return onTable;
    case 'lose':
    case 'bust':
    case 'dealer_blackjack':
      return 0n;
  }
}
