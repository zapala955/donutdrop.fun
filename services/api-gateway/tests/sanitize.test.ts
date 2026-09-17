import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { containsUnsafeCharacters, minorUnits, safeText } from '../src/lib/sanitize.js';

/* Built with String.fromCodePoint rather than literals so this file stays readable and cannot
 * itself be reordered or truncated by the characters it is testing. */
const NUL = String.fromCodePoint(0x00);
const BELL = String.fromCodePoint(0x07);
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const C1 = String.fromCodePoint(0x0085);

const MAX = 9_223_372_036_854_775_807n;

describe('free-text sanitization', () => {
  const field = safeText(3, 32);

  it('accepts ordinary text, including non-ASCII names', () => {
    for (const value of ['Nether Vault', 'Crate #3', 'Café Crate', 'Ünterwelt', '龍のケース']) {
      assert.equal(field.safeParse(value).success, true, `rejected ${value}`);
    }
  });

  it('rejects null bytes and control characters', () => {
    for (const value of [`Crate${NUL}`, `Crate${BELL}`, `Crate${C1}`, `a${NUL}b`]) {
      assert.equal(field.safeParse(value).success, false, `accepted ${JSON.stringify(value)}`);
      assert.equal(containsUnsafeCharacters(value), true);
    }
  });

  it('rejects bidirectional overrides that make stored and displayed text differ', () => {
    assert.equal(field.safeParse(`Netherite${RLO}kcolB`).success, false);
    assert.equal(field.safeParse(`${LRI}spoof`).success, false);
    assert.equal(containsUnsafeCharacters(`x${RLO}y`), true);
  });

  it('rejects zero-width characters that let two identical-looking names coexist', () => {
    assert.equal(field.safeParse(`Admin${ZWSP}`).success, false);
    assert.equal(field.safeParse(`Ad${ZWSP}min`).success, false);
    assert.equal(field.safeParse(`Ad${BOM}min`).success, false);
    /* A LEADING or trailing BOM is a different case: String.prototype.trim treats U+FEFF as
     * whitespace, so it is removed before the check ever runs. The result is the clean name, which
     * is the right outcome — the character is gone either way. */
    assert.equal(field.parse(`${BOM}Admin`), 'Admin');
  });

  it('normalizes to NFC before measuring length, so bounds count what a reader sees', () => {
    // "é" as e + combining acute is two code units; NFC folds it to one.
    const decomposed = 'Cafe' + String.fromCodePoint(0x0301);
    const parsed = field.parse(decomposed);
    assert.equal(parsed, 'Café');
    assert.equal(parsed.length, 4);
  });

  it('trims, then enforces the minimum against the trimmed value', () => {
    assert.equal(field.parse('  Nether Vault  '), 'Nether Vault');
    // "  a  " trims to one character, under the minimum of three
    assert.equal(field.safeParse('  a  ').success, false);
  });

  it('enforces both a character bound and a byte bound', () => {
    assert.equal(field.safeParse('x'.repeat(32)).success, true);
    assert.equal(field.safeParse('x'.repeat(33)).success, false);
  });

  it('leaves tab, newline and carriage return alone: they are not control injection', () => {
    // safeText trims them at the edges; the point is that they do not trip the control check.
    assert.equal(containsUnsafeCharacters('a\tb'), false);
    assert.equal(containsUnsafeCharacters('a\nb'), false);
    assert.equal(containsUnsafeCharacters('a\r\nb'), false);
  });
});

describe('money boundary guards', () => {
  const amount = minorUnits({ max: MAX });
  const withZero = minorUnits({ allowZero: true, max: MAX });

  it('accepts whole minor-unit strings at every magnitude', () => {
    for (const value of ['1', '25000', '1000000000', '9223372036854775807']) {
      assert.equal(amount.safeParse(value).success, true, `rejected ${value}`);
    }
  });

  it('rejects every shape that is not a plain non-negative integer', () => {
    for (const value of [
      '-1', '-0', '1.5', '0.1', '1e9', '1E9', 'NaN', 'Infinity', '-Infinity',
      '0x10', '1_000', ' 1', '1 ', '+1', '', 'abc', '1,000', '١٢٣',
    ]) {
      assert.equal(amount.safeParse(value).success, false, `accepted ${JSON.stringify(value)}`);
    }
  });

  it('rejects a leading zero, which is how two spellings of one amount get in', () => {
    assert.equal(amount.safeParse('01').success, false);
    assert.equal(amount.safeParse('000').success, false);
  });

  it('rejects zero unless zero was explicitly allowed', () => {
    assert.equal(amount.safeParse('0').success, false);
    assert.equal(withZero.safeParse('0').success, true);
  });

  it('rejects anything past the database range rather than silently wrapping', () => {
    assert.equal(amount.safeParse('9223372036854775808').success, false);
    assert.equal(amount.safeParse('99999999999999999999999').success, false);
  });

  it('stays exact above 2^53, where a double would not', () => {
    const beyondDouble = '9007199254740993';
    assert.equal(amount.safeParse(beyondDouble).success, true);
    // The string survives intact; parsing it as a number would not round-trip.
    assert.equal(BigInt(amount.parse(beyondDouble)).toString(), beyondDouble);
    assert.notEqual(String(Number(beyondDouble)), beyondDouble);
  });
});

describe('sanitizer source hygiene', () => {
  it('contains no literal control, bidi or zero-width characters of its own', async () => {
    /* The first version of this module wrote its ranges as regex escapes that were resolved into
     * real invisible characters in the file. It worked and was unreviewable. This asserts the
     * source stays legible. */
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/lib/sanitize.ts'),
      'utf8',
    );
    const offending: string[] = [];
    for (const character of source) {
      const code = character.codePointAt(0) ?? 0;
      const isControl =
        code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) ||
        (code >= 0x7f && code <= 0x9f);
      const isBidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
      const isZeroWidth = (code >= 0x200b && code <= 0x200d) || code === 0xfeff;
      if (isControl || isBidi || isZeroWidth) offending.push('U+' + code.toString(16));
    }
    assert.deepEqual(offending, []);
  });
});
