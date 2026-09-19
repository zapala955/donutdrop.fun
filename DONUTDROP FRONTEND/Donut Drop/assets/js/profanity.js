/**
 * Chat text hygiene: name masking, and word masking inside message bodies.
 *
 * WHY THIS RUNS IN THE RENDERER AND NOT ON THE SERVER
 * --------------------------------------------------
 * The obvious place is the API, masking before anything leaves the building. That is wrong for
 * NAMES, and the reason is worth writing down so nobody "fixes" it later: the client sends
 * `message.author` straight back as the lookup key for tipping and for the admin timeout
 * endpoints, which resolve it against `normalized_username`. A masked name resolves to no user,
 * so masking that field server-side silently breaks moderation and tipping — precisely for the
 * accounts most likely to need moderating.
 *
 * Message bodies have no such constraint, and masking them here is the weaker half of the job: it
 * cleans what people see, not what is stored, and anyone reading the API directly still gets the
 * raw row. The stored text is deliberately left intact so moderators can see what was actually
 * said. Treat this as display hygiene, not as moderation.
 */

/* ─────────── names ─────────── */

/**
 * Masks a display name down to its first character and a fixed run of stars: `Notch` and `q9w` both
 * read as `N********` and `q********`.
 *
 * Matches what the server does for every public surface (lib/masked-name.ts), and the two must
 * agree or the client contradicts the mask the API already applied.
 *
 * THE WIDTH IS FIXED ON PURPOSE. This used to pad to the real length, which keeps rows visually
 * distinct and leaks the thing the mask exists to hide: among a few hundred regulars a name's
 * length plus its initial often names somebody outright, and it is what lets a watcher follow one
 * player from line to line. A one-character name is masked too, for the same reason — returning it
 * as-is announced that the name was one character long.
 *
 * Iterating with the spread operator yields whole code points, so a name whose first character is
 * an astral one is not cut in half into a broken surrogate.
 */
const MASK_WIDTH = 8;

export function censorName(value) {
  if (!value) return '';
  const characters = [...String(value)];
  return characters[0] + '*'.repeat(MASK_WIDTH);
}

/* ─────────── message bodies ─────────── */

/* Digits and punctuation that stand in for letters. Only substitutions that actually appear in
 * evasive spellings are listed; mapping every vaguely similar glyph would fold apart words that
 * were never the same. */
const LEET = new Map([
  ['4', 'a'], ['@', 'a'],
  ['8', 'b'],
  ['(', 'c'], ['<', 'c'], ['{', 'c'],
  ['3', 'e'],
  ['6', 'g'], ['9', 'g'],
  ['1', 'i'], ['!', 'i'], ['|', 'i'],
  ['0', 'o'],
  ['5', 's'], ['$', 's'],
  ['7', 't'], ['+', 't'],
  ['2', 'z'],
]);

/** Slurs and hard profanity. Kept deliberately short: this is a display filter, not moderation. */
const DENY = [
  'nigger', 'nigga', 'niglet', 'chink', 'gook', 'spic', 'wetback', 'kike', 'coon',
  'towelhead', 'sandnigger', 'raghead', 'beaner', 'paki', 'abbo', 'wog',
  'faggot', 'fagot', 'fag', 'dyke', 'tranny', 'shemale',
  'retard', 'retarded', 'spastic', 'mongoloid',
  'cunt', 'fuck', 'motherfucker', 'cock', 'pussy', 'whore', 'slut',
  'rape', 'rapist', 'pedo', 'pedophile', 'paedophile',
  'shit', 'bullshit', 'bitch', 'bastard', 'wanker', 'twat', 'asshole', 'arsehole',
  'nazi', 'kkk',
];

/**
 * Ordinary words that contain a denied word once folded.
 *
 * The price of an aggressive matcher. When someone reports a wrongly masked word, the fix is a
 * line here, not a weaker matcher.
 */
const ALLOW = [
  'class', 'classic', 'bass', 'grass', 'pass', 'password', 'passion', 'compass', 'mass',
  'massive', 'assassin', 'assault', 'assist', 'assign', 'associate', 'asset', 'assume',
  'assure', 'embassy', 'glass', 'brass', 'harass', 'bypass', 'surpass', 'chassis',
  'cocktail', 'peacock', 'cockpit', 'cockroach', 'shuttlecock',
  'scrape', 'grape', 'drape', 'therapeutic', 'trapeze',
  'raccoon', 'cocoon', 'tycoon', 'lagoon',
  'pedometer', 'torpedo',
  'packing', 'unpacking', 'repacking',
  'shiitake', 'scunthorpe', 'penistone', 'sussex', 'essex', 'middlesex',
];

/**
 * Folds one token into the form the word lists are compared against, alongside an index map:
 * `offsets[i]` is the index in the original token that produced folded character `i`.
 *
 * In-word punctuation is dropped, because "f.u.c.k" is the cheapest evasion there is. Whitespace
 * never reaches here: callers split on it first, so a match can never span two words.
 */
function fold(token) {
  const characters = [];
  const offsets = [];
  let index = 0;
  for (const character of token) {
    const width = character.length;
    const mapped = LEET.get(character.toLowerCase()) ?? character.toLowerCase();
    if (/^[a-z0-9]$/.test(mapped)) {
      characters.push(mapped);
      offsets.push(index);
    }
    index += width;
  }
  return { text: characters.join(''), offsets };
}

/**
 * Turns a list word into a pattern that tolerates repeated letters: "fuck" becomes /f+u+c+k+/.
 *
 * Repetition lives in the PATTERN rather than in the fold. An earlier version collapsed runs on
 * both sides instead, which turns "kkk" into "k" — so every word containing a single k was
 * censored, and "blake123" came back as "bla*e123". It also turns "coon" into "con", which would
 * censor anyone called Conor. /k+k+k+/ still needs three k's and /c+o+o+n+/ still needs two o's.
 */
function patternFor(word) {
  const body = [...word].map((c) => `${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}+`).join('');
  return new RegExp(body, 'g');
}

const compile = (words) => words
  .map((w) => fold(w).text)
  .filter(Boolean)
  .map(patternFor);

const DENY_PATTERNS = compile(DENY);
const ALLOW_PATTERNS = compile(ALLOW);

function spansOf(pattern, folded) {
  const spans = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(folded);
  while (match !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    pattern.lastIndex = match.index + Math.max(match[0].length, 1);
    match = pattern.exec(folded);
  }
  return spans;
}

/**
 * True when [start, end) sits inside an innocent word at the same place.
 *
 * The allowlist word must actually COVER the match, not merely appear in the token: "classfuck"
 * contains "class", but that must not excuse the second half.
 */
function isExcused(folded, start, end) {
  for (const pattern of ALLOW_PATTERNS) {
    for (const span of spansOf(pattern, folded)) {
      if (span.start <= start && span.end >= end) return true;
    }
  }
  return false;
}

/** Masks the denied words inside a single whitespace-delimited token. */
function censorToken(token) {
  const { text, offsets } = fold(token);
  if (!text) return token;

  const spans = [];
  for (const pattern of DENY_PATTERNS) {
    for (const span of spansOf(pattern, text)) {
      if (!isExcused(text, span.start, span.end)) spans.push(span);
    }
  }
  if (spans.length === 0) return token;

  const characters = [...token];
  const positionOf = new Map();
  let unit = 0;
  characters.forEach((character, position) => {
    positionOf.set(unit, position);
    unit += character.length;
  });

  const masked = new Set();
  for (const span of spans) {
    const first = offsets[span.start];
    // Runs to where the NEXT folded character begins, so punctuation dropped from the middle of a
    // match ("f.u.c.k") is masked along with the letters around it.
    const last = span.end < offsets.length ? offsets[span.end] : token.length;
    if (first === undefined) continue;
    for (let u = first; u < last; u += 1) {
      const position = positionOf.get(u);
      if (position !== undefined) masked.add(position);
    }
  }
  return characters.map((c, i) => (masked.has(i) ? '*' : c)).join('');
}

/** True when the text contains a denied word. */
export function containsProfanity(value) {
  if (!value) return false;
  return String(value).split(/(\s+)/).some((t) => t.trim() && censorToken(t) !== t);
}

/**
 * Masks denied words inside a chat message, leaving everything else exactly as typed.
 *
 * Split on whitespace FIRST, so a match can never span two words: without that, dropping in-word
 * punctuation would let "a ss" or "class room" fold into a hit. The separators are kept in the
 * split so the message reassembles with its original spacing.
 *
 * Only the offending letters become asterisks, and the result is the same length as the input, so
 * a chat row never reflows when a word is masked.
 */
export function censorText(value) {
  if (!value) return '';
  return String(value).split(/(\s+)/).map((t) => (t.trim() ? censorToken(t) : t)).join('');
}
