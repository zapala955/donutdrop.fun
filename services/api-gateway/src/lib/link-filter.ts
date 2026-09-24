/**
 * link-filter.ts — refusing links in public chat, including the ways people write them to get past
 * a filter that only looks for dots.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE WHOLE DIFFICULTY IS FALSE POSITIVES, NOT FALSE NEGATIVES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A filter that blocks a bit too much gets switched off within a week, and a filter that is off
 * blocks nothing. The dangerous rule is the obvious one — "a word, a space, then a TLD" — because
 * `in`, `me`, `gg`, `at`, `is`, `it`, `so`, `to`, `am`, `us`, `no` and `be` are all real
 * top-level domains, and all of them are words people type in chat every few minutes. Written
 * naively that rule refuses "let me know in chat", "nice gg" and "he is at spawn".
 *
 * So nothing here matches on a TLD alone. Each rule asks how much deliberate effort went into the
 * separator, and only spends the wide TLD list where that effort is unmistakable:
 *
 *   * `example.com` — a dot with no spaces around it is a domain. Wide list.
 *   * `example(dot)com`, `example [.] com` — nobody brackets a full stop by accident. Wide list.
 *   * `example . com` — a spaced dot happens at the end of sentences ("lost it all . in the end"),
 *     so this gets the short list only.
 *   * `blabla com` — a bare space is the weakest signal there is, so it gets the short list only.
 *   * `discord gg/abc` — a slash after the TLD puts it beyond doubt whatever the separator was.
 *     This is the rule that catches the short, word-like TLDs the space rule has to let through,
 *     and it carries its own list with the English words taken out of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ON THE SERVER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * assets/js/profanity.js says it plainly about itself: it is display hygiene, not moderation.
 * Anything enforced in the browser is enforced by the attacker's browser. This runs before the
 * insert, so a refused message is never stored and never fans out over the live feed.
 */

/* Zero-width and invisible characters -- the cheapest way to break a word up mid-domain.
 *
 * Built from code points rather than written as a character class, because two of them (U+2028
 * and U+2029) ARE line terminators in JavaScript source: pasted in literally they end the regex
 * mid-expression and the file stops parsing. Numbers cannot do that. */
const INVISIBLE_POINTS = [
  0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c,
  0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_POINTS.map((c) => String.fromCodePoint(c)).join('')}]`,
  'g',
);

/* Characters used in place of a dot, same treatment and for the same reason.
 *
 * The homoglyphs matter more than they look: a domain written with an ideographic full stop
 * renders as a domain to a reader and as an unrelated character to a filter checking for ".". */
const DOT_LIKE_POINTS = [
  0x00b7, 0x02d9, 0x0387, 0x05c4, 0x2022, 0x2024, 0x2027, 0x2219, 0x22c5, 0x30fb, 0xff0e, 0xff65,
  0x3002,
];
const DOT_LIKE = new RegExp(
  `[${DOT_LIKE_POINTS.map((c) => String.fromCodePoint(c)).join('')}]`,
  'g',
);

/**
 * TLDs accepted where the separator proves intent.
 *
 * Not the full IANA list on purpose: this is what turns up in chat advertising, and every
 * addition is another chance to refuse a sentence.
 */
const TLD_WIDE = [
  'com',
  'net',
  'org',
  'io',
  'gg',
  'gl',
  'co',
  'me',
  'tv',
  'us',
  'uk',
  'de',
  'ru',
  'eu',
  'fr',
  'nl',
  'pl',
  'br',
  'in',
  'it',
  'es',
  'ca',
  'au',
  'ch',
  'se',
  'no',
  'fi',
  'dk',
  'cz',
  'at',
  'info',
  'biz',
  'site',
  'online',
  'store',
  'shop',
  'club',
  'link',
  'click',
  'top',
  'xyz',
  'icu',
  'cyou',
  'live',
  'app',
  'dev',
  'fun',
  'life',
  'world',
  'space',
  'website',
  'host',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'pw',
  'cc',
  'ws',
  'to',
  'ly',
  'sh',
  'st',
  'is',
  'im',
  'am',
  'be',
];

/**
 * TLDs accepted after nothing but a space or a spaced dot.
 *
 * Short, and it got shorter once it was tested against real sentences. Two-letter TLDs are absent
 * as a class -- there is no two-letter TLD that is not also a word, an abbreviation or a gamer
 * noise -- and so is every longer one that doubles as English. What is left is what nobody types
 * as a word; a domain ending in anything else still has to be written with a dot or a slash, and
 * both of those are caught above.
 */
const TLD_STRICT = ['com', 'net', 'org', 'xyz', 'biz', 'icu', 'cyou', 'gratis'];

/**
 * Words that may sit to the left of one of those without making it a domain.
 *
 * This list exists because the first draft did not have it and refused "this site is so good".
 * `site`, `online`, `store`, `shop`, `info` and `website` were dropped from the list above for
 * the same reason -- all of them are ordinary English words -- but `net` and `org` were worth
 * keeping, and "whats my net profit" is a thing people say in a gambling chat. So rather than
 * lose `net` (and let "myserver net" through), the rule asks what the left-hand word is: a
 * determiner, a pronoun or a bare adjective is not a domain label.
 */
const STOP_LEFT = new Set([
  'the',
  'a',
  'an',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'me',
  'him',
  'them',
  'us',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'am',
  'no',
  'not',
  'any',
  'some',
  'more',
  'most',
  'less',
  'all',
  'every',
  'each',
  'one',
  'two',
  'first',
  'last',
  'next',
  'good',
  'bad',
  'best',
  'worst',
  'free',
  'new',
  'old',
  'big',
  'small',
  'total',
  'gross',
  'safety',
  'what',
  'whats',
  'who',
  'how',
  'why',
  'when',
  'where',
  'and',
  'or',
  'but',
  'so',
  'if',
  'to',
  'in',
  'on',
  'at',
  'of',
  'for',
  'with',
  'from',
  'by',
  'up',
  'down',
  'out',
  'off',
  'very',
  'really',
  'just',
  'only',
  'still',
  'also',
  'too',
  'than',
  'then',
  'got',
  'get',
  'make',
  'made',
]);

/**
 * TLDs accepted when a slash follows them.
 *
 * The short ones are back, because `discord gg/abc` is not a sentence — but the ones that are
 * ordinary English words are still out, since "im in/out" and "he is at/near spawn" are. That is
 * the whole reason this is a third list rather than the wide one.
 */
const TLD_PATH = [
  'com',
  'net',
  'org',
  'gg',
  'gl',
  'ly',
  'io',
  'co',
  'sh',
  'st',
  'cc',
  'tv',
  'me',
  'app',
  'link',
  'click',
  'xyz',
  'info',
  'top',
  'icu',
  'site',
  'online',
  'store',
  'shop',
];

/** Longest first, so `com` cannot win a prefix race against `com`-prefixed entries. */
const alternation = (list: readonly string[]) =>
  list
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');

/** A domain label: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/** `(dot)`, `[dot]`, `{dot}` and the spaced word form — all unmistakably deliberate. */
const DOT_SPELLED =
  '(?:\\s*[([{<]\\s*(?:dot|punto|punkt)\\s*[)\\]}>]\\s*|\\s+(?:dot|punto|punkt)\\s+)';
/** `(.)`, `[.]`, `{.}` — a bracketed full stop, which no sentence contains. */
const DOT_BRACKETED = '(?:\\s*[([{<]\\s*\\.\\s*[)\\]}>]\\s*)';

export interface LinkVerdict {
  /** Which rule caught it. Logged, never echoed back to the sender. */
  readonly rule: 'scheme' | 'domain' | 'spaced-domain' | 'path' | 'ip';
}

/**
 * Folds a message into the form the rules are written against.
 *
 * Invisible characters are dropped rather than replaced: they are only ever there to break a word
 * up, so removing them rejoins the domain instead of leaving two labels.
 */
function normalise(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(DOT_LIKE, '.').toLowerCase();
}

/**
 * Whether a message carries something trying to be a link.
 *
 * Returns the rule that caught it, or null. Nothing throws, so the same call can warn as easily
 * as it can refuse.
 */
export function detectLink(raw: string): LinkVerdict | null {
  const text = normalise(raw);

  /* A scheme is unambiguous, including the spellings used to dodge a filter looking for "http".
   * `\W{0,3}` between the letters covers "h t t p" and "h.t.t.p". */
  if (/\b(?:h\W{0,3}t\W{0,3}t\W{0,3}p|hxxp|ftp|sftp)s?\s*:\s*\/\s*\//.test(text)) {
    return { rule: 'scheme' };
  }
  if (/:\/\//.test(text)) return { rule: 'scheme' };

  // `www` followed by anything is a domain being written, whatever the separator.
  if (new RegExp(`\\bwww\\s*[.\\s]\\s*${LABEL}`).test(text)) return { rule: 'domain' };

  /* Four numbers in a row is not something a sentence does, so this does not need a deliberate
   * separator to be safe. */
  if (/\b\d{1,3}\s*[.\s]\s*\d{1,3}\s*[.\s]\s*\d{1,3}\s*[.\s]\s*\d{1,3}\b/.test(text)) {
    return { rule: 'ip' };
  }

  const wide = alternation(TLD_WIDE);
  const strict = alternation(TLD_STRICT);
  const path = alternation(TLD_PATH);

  // A tight dot — no spaces around it. This is what a real domain looks like.
  if (new RegExp(`\\b${LABEL}\\.(?:${wide})\\b`).test(text)) return { rule: 'domain' };

  // A spelled-out or bracketed dot. The effort is the signal, so the wide list is safe here.
  if (new RegExp(`\\b${LABEL}(?:${DOT_SPELLED}|${DOT_BRACKETED})(?:${wide})\\b`).test(text)) {
    return { rule: 'domain' };
  }

  /* A slash after the TLD. `discord gg/abc` and `bit ly/xyz` land here, and this is what makes the
   * short TLDs catchable without the space rule having to carry them. */
  if (new RegExp(`\\b${LABEL}\\s*[.\\s]\\s*(?:${path})\\s*\\/\\s*\\S`).test(text)) {
    return { rule: 'path' };
  }

  /* A bare space, or a dot with space around it, against the short list only. This is the rule
   * the request was about -- "blabla com" -- and the one with the most to lose, so it is the
   * narrowest one here: the left-hand word is captured and checked, because an ordinary
   * English word in front of the TLD means this was a sentence, not an address. */
  const spaced = new RegExp(`\\b(${LABEL})(?:\\s+|\\s*\\.\\s+|\\s+\\.\\s*)(?:${strict})\\b`, 'g');
  for (const match of text.matchAll(spaced)) {
    if (!STOP_LEFT.has(match[1] ?? '')) return { rule: 'spaced-domain' };
  }

  return null;
}

/**
 * Whether the only link-like thing in the message is this site's own address.
 *
 * An exact host match, so `donutdrop.fun.example.com` is somebody else's domain wearing this one
 * as a label and stays blocked. Subdomains are not accepted either: the site does not use any,
 * and accepting them would turn this into guesswork.
 */
export function isOwnDomainOnly(raw: string, ownHost: string): boolean {
  const host = ownHost
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (!host) return false;

  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* Every mention of this site is cut out, then the message is asked again. If nothing link-like
   * survives, the message was only ever about this site. The trailing boundary is what stops
   * `donutdrop.fun.example.com` being read as this host plus junk. */
  const stripped = normalise(raw)
    .replace(
      new RegExp(
        `(?<![a-z0-9.-])(?:https?:\\/\\/)?(?:www\\.)?${escaped}(?![a-z0-9.-])(?:\\/\\S*)?`,
        'g',
      ),
      ' ',
    )
    .replace(/\s+/g, ' ');
  return detectLink(stripped) === null;
}
