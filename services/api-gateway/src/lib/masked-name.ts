/**
 * How a player's name is shown to anyone who is not that player.
 *
 * Defined once, in SQL, because the mask is only worth anything if every route agrees on it. It
 * lived inline in the activity feed and nowhere else, so the feed masked names while the battle
 * lobby, the battle fairness panel and the duel arena printed them in full — and a player only has
 * to open one of those to undo the masking everywhere else.
 *
 * ── WHY THE LENGTH IS FIXED ──
 *
 * The first version padded to the real length, so `q9w` read as `q**` and `AnvilAndy` as `A********`.
 * That keeps rows visually distinct, which is why it was written that way, and it leaks the one
 * thing the mask is for. A name's length is a strong identifier on a server where the same few
 * hundred people play: combined with the first letter and a bit of context it often names somebody
 * outright, and it is exactly the detail that lets a watcher follow one player across the feed.
 *
 * Eight stars for everyone, whatever the name. `q9w` and `AnvilAndy` both read as `x********`, and
 * the only thing that survives is the initial.
 *
 * ── WHAT THIS IS NOT ──
 *
 * It is not anonymity against someone reading the API. Masking happens in the query, so these
 * routes never emit the real name at all — but the same account is still named in full anywhere it
 * has to be: your own profile, a chat line you are about to tip, the admin console. This closes the
 * public surfaces, which is where an uninvolved spectator does their looking.
 */

/** The number of asterisks every masked name carries, whatever its real length. */
export const MASK_WIDTH = 8;

/**
 * A SQL expression masking the given column.
 *
 * Takes the column rather than a table alias so a query with two of them — a duel has a host and an
 * opponent — reads as two obviously identical masks rather than one helper applied twice in ways a
 * reader has to check.
 */
export function maskedName(column: string): string {
  return `left(${column}, 1) || repeat('*', ${MASK_WIDTH})`;
}
