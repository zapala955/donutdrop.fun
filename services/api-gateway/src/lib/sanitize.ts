import { z } from 'zod';

/**
 * Free-text input hygiene.
 *
 * Every string a human types and another human later reads passes through here. Length and
 * trimming alone are not enough: a field constrained only by `.min().max()` still accepts null
 * bytes, C0/C1 control characters, and Unicode direction overrides.
 *
 * WHY EACH RULE EXISTS
 * --------------------
 * NUL and control characters. A NUL truncates the string in anything that later touches C — a
 * logger, a search index, a downstream shell. Control characters corrupt terminal output and let
 * an operator's console be rewritten by data they are only trying to read.
 *
 * Bidirectional overrides (U+202A-U+202E, U+2066-U+2069). These reorder how text RENDERS without
 * changing what it contains: an item name carrying U+202E renders with everything after it
 * reversed, so the stored text and the displayed text differ. The reader sees one name, the
 * ledger records another. Nothing legitimate in a display name needs them.
 *
 * (The character is described rather than written here on purpose — pasting a live override into
 * a comment reorders the comment.)
 *
 * Zero-width characters (U+200B-U+200D, U+FEFF). Invisible, so two names that look identical can
 * be distinct rows — the basis of impersonation in any list of names.
 *
 * NFC normalization, applied BEFORE validation. The same visible character has several encodings;
 * normalizing first means the length check counts what a reader sees, and two spellings of one
 * name compare equal instead of sitting side by side in a leaderboard.
 *
 * The order matters: normalize, then reject. Validating before normalizing would let a composed
 * sequence slip past a check that its normalized form would have failed.
 */

/* Checked by code point, not by a literal character class.
 *
 * The first cut of this wrote the ranges as a regex, and the escape sequences were resolved into
 * REAL control and zero-width characters sitting invisibly in this file. It worked, and it was
 * unreadable and unreviewable — the bytes that decide what gets rejected could not be seen by
 * anyone auditing them. Numeric comparisons say exactly the same thing and stay legible in a
 * diff, a terminal, and a code review.
 */
function isControl(code: number): boolean {
  // C0 minus tab, newline and carriage return, plus DEL and the C1 block.
  if (code <= 0x08) return true;
  if (code === 0x0b || code === 0x0c) return true;
  if (code >= 0x0e && code <= 0x1f) return true;
  return code >= 0x7f && code <= 0x9f;
}

function isBidiOverride(code: number): boolean {
  // LRE, RLE, PDF, LRO, RLO and the four isolate controls.
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function isZeroWidth(code: number): boolean {
  // ZWSP, ZWNJ, ZWJ and the byte-order mark.
  return (code >= 0x200b && code <= 0x200d) || code === 0xfeff;
}

function scan(value: string): { control: boolean; bidi: boolean; zeroWidth: boolean } {
  const found = { control: false, bidi: false, zeroWidth: false };
  // Iterating the string yields whole code points, so astral characters are not split into
  // surrogate halves and mistaken for something else.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (isControl(code)) found.control = true;
    else if (isBidiOverride(code)) found.bidi = true;
    else if (isZeroWidth(code)) found.zeroWidth = true;
  }
  return found;
}

export function containsUnsafeCharacters(value: string): boolean {
  const found = scan(value);
  return found.control || found.bidi || found.zeroWidth;
}

/**
 * A bounded, normalized, control-free string.
 *
 * Rejects rather than strips. Silently removing characters changes what the user submitted
 * without telling them, and an operator who typed a name with a stray character should be told
 * so rather than discovering later that the record does not say what they wrote.
 */
export function safeText(min: number, max: number) {
  return z
    .string()
    // Normalize first so the length bounds count rendered characters, not encoding artefacts.
    .transform((value) => value.normalize('NFC').trim())
    .refine((value) => value.length >= min, {
      message: `Must be at least ${min} characters`,
    })
    .refine((value) => value.length <= max, {
      message: `Must not exceed ${max} characters`,
    })
    // A byte length cap as well: a string of astral-plane characters passes a character count and
    // can still overflow a column measured in bytes.
    .refine((value) => Buffer.byteLength(value, 'utf8') <= max * 4, {
      message: 'Value is too large',
    })
    .refine((value) => !scan(value).control, {
      message: 'Must not contain control characters or null bytes',
    })
    .refine((value) => !scan(value).bidi, {
      message: 'Must not contain bidirectional override characters',
    })
    .refine((value) => !scan(value).zeroWidth, {
      message: 'Must not contain zero-width characters',
    });
}

/**
 * A non-negative integer amount of minor currency units, as a decimal string.
 *
 * Money never travels as a JavaScript number. Above 2^53 a double silently stops representing
 * integers exactly, and these balances reach ten figures — the figure sent would not be the
 * figure meant. A digit string parsed into a BigInt is exact at every magnitude.
 *
 * The regex is the whole guard: it admits no sign, no decimal point, no exponent, and no
 * whitespace, which rules out negatives, fractions, `NaN`, `Infinity`, and `1e9` in one pass
 * rather than trying to detect each afterwards.
 */
export function minorUnits({ allowZero = false, max }: { allowZero?: boolean; max: bigint }) {
  const pattern = allowZero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/;
  return z
    .string()
    .regex(pattern, 'Must be a whole number of minor units')
    /* The pattern is re-tested here, and that repetition is load-bearing.
     *
     * Zod runs every refinement even after an earlier check has failed, so on input like "1.5" or
     * "abc" this callback still executes — and BigInt() THROWS on a string it cannot parse. That
     * exception escapes validation entirely and surfaces as a 500 instead of a 400, which is an
     * unhandled error path any caller can trigger with a one-character payload.
     *
     * Guarding on the pattern first means the conversion only ever runs on something already
     * known to be convertible, and a malformed amount is rejected as the bad request it is. */
    .refine((value) => !pattern.test(value) || BigInt(value) <= max, {
      message: 'Value exceeds the supported range',
    });
}

/* ─────────── markup, for text that other people will read ───────────
 *
 * Every renderer on this site writes chat with textContent, so an injected tag is already inert
 * before it reaches a DOM. This is the second layer, and it exists because the first one is a
 * property of the code rather than of the data: one future `innerHTML +=` in one component is all
 * it takes for stored markup to become executed markup, and the stored rows would already be full
 * of payloads waiting for it. Refusing the payload at the door means that mistake has nothing to
 * detonate.
 *
 * WHAT IS REFUSED, AND WHAT IS NOT
 * --------------------------------
 * A bare `<` is allowed. "5 < 10" and "<3" are things people type, and a chat that rejects them is
 * broken in a way users notice constantly while gaining nothing: a lone angle bracket is not a
 * tag. What is refused is a TAG-SHAPED sequence — `<` immediately followed by a letter, a slash,
 * a bang or a question mark — which covers <script>, <img …>, <svg/onload>, </b>, <!-- -->, and
 * the XML declaration, with no false positives on arithmetic.
 *
 * Dangerous URL schemes are refused outright. `javascript:` and `data:text/html` are live vectors
 * anywhere a string is later used as a link, and nothing legitimate in a chat message needs them.
 * The pattern tolerates the whitespace and comment tricks used to break up a scheme, because
 * browsers tolerate them too.
 */
const TAG_SHAPED = /<[A-Za-z/!?]/;
const DANGEROUS_SCHEME = /(?:javascript|vbscript|livescript)\s*:/i;
const DANGEROUS_DATA = /data\s*:\s*(?:text\/html|image\/svg\+xml|application\/xhtml)/i;

export function containsMarkup(value: string): boolean {
  return TAG_SHAPED.test(value)
    || DANGEROUS_SCHEME.test(value)
    || DANGEROUS_DATA.test(value);
}

/**
 * Free text that will be shown to other people.
 *
 * safeText plus a refusal of markup and script-bearing URL schemes. Used for chat; anything else
 * that renders one account's typing inside another account's page should use it too.
 */
export function safePublicText(min: number, max: number) {
  return safeText(min, max)
    .refine((value) => !TAG_SHAPED.test(value), {
      message: 'Must not contain HTML tags',
    })
    .refine((value) => !DANGEROUS_SCHEME.test(value) && !DANGEROUS_DATA.test(value), {
      message: 'Must not contain script or data URLs',
    });
}
