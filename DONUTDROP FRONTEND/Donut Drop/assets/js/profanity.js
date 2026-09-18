/**
 * Display-name masking for the chat rail.
 *
 * Every name rendered in chat shows its first character and nothing else: `Notch` reads as
 * `N****`. That covers an offensive username without needing to decide which usernames are
 * offensive — there is no word list to evade, no leetspeak to see through, and no innocent name
 * wrongly flagged.
 *
 * WHY THIS RUNS IN THE RENDERER AND NOT ON THE SERVER
 * --------------------------------------------------
 * The obvious place for this is the API, masking `author` before it leaves the building. That is
 * wrong here, and the reason is worth writing down so nobody "fixes" it later: the client sends
 * `message.author` straight back to the server as the lookup key for tipping and for the admin
 * timeout endpoints, which resolve it against `normalized_username`. A masked name resolves to no
 * user, so masking that field server-side silently breaks moderation and tipping — precisely for
 * the accounts most likely to need moderating.
 *
 * The real name therefore has to travel. Display is the only layer where the two uses separate,
 * so masking happens at the point of render and `message.author` is left untouched for the calls
 * that need it, for the mc-heads avatar URL, and for the staff moderation menu.
 *
 * The mask is character-for-character, so a chat row never reflows when a name is masked and two
 * speakers with different name lengths stay visibly different.
 */

/**
 * Masks a display name down to its first character.
 *
 * Iterating with the spread operator yields whole code points, so a name whose first character is
 * an astral one is not cut in half into a broken surrogate.
 *
 * A one-character name is returned as-is: there is nothing after the first letter to hide, and
 * padding it to a fixed width would invent length the name does not have.
 */
export function censorName(value) {
  if (!value) return '';
  const characters = [...String(value)];
  if (characters.length <= 1) return characters.join('');
  return characters[0] + '*'.repeat(characters.length - 1);
}
