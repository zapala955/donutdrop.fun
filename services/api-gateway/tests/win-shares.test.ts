import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ROUND_GAMES, ROUND_SOURCES, roundSql } from '../src/lib/player-rounds.js';
import {
  isLinkPreview,
  isShareable,
  newShareId,
  SHARE_ID_PATTERN,
  shareDescription,
  shareLandingPath,
  sharePageHtml,
  shareTitle,
  shareUrl,
  type WinShare,
} from '../src/lib/win-shares.js';

const read = async (relative: string) =>
  (await readFile(new URL(relative, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const share: WinShare = {
  id: 'K7P2QXAB',
  game: 'crash',
  gameName: 'Crash',
  playerName: 'S********',
  wagerMinor: 230_000n,
  payoutMinor: 12_466_000n,
  referralCode: 'ABC123',
};

describe('which wins can be shared', () => {
  /* 2026-10-28: it began as 5x or $10M of profit; the owner asked for every bet in the history. */
  it('takes any win', () => {
    assert.equal(isShareable(100n, 101n), true);
    assert.equal(isShareable(100n, 500n), true);
    assert.equal(isShareable(100_000_000n, 100_000_001n), true);
  });

  it('never takes a loss, a push or a free round', () => {
    assert.equal(isShareable(100n, 0n), false);
    assert.equal(isShareable(100n, 100n), false);
    assert.equal(isShareable(0n, 50_000_000n), false);
  });

  it('is offered unasked, after the round, only for a big win', async () => {
    const browser = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/share.js');
    assert.match(browser, /const MIN_MULTIPLIER = 5;/);
    assert.match(browser, /const MIN_PROFIT = 10_000_000;/);
    assert.match(browser, /export function isWorthOffering\(wager, payout\) \{/);
    const winfx = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/winfx.js');
    assert.match(winfx, /if \(isWorthOffering\(row\.wager, row\.payout\)/);
  });
});

describe('a share link', () => {
  it('has an id the schema accepts and a screenshot can be retyped from', async () => {
    for (let i = 0; i < 200; i += 1) assert.match(newShareId(), SHARE_ID_PATTERN);
    const migration = await read('../../../packages/db/migrations/080_win_shares.sql');
    assert.match(migration, /CHECK \(id ~ '\^\[A-HJ-NP-Z2-9\]\{8\}\$'\)/);
    assert.doesNotMatch('K7P2QX0B', SHARE_ID_PATTERN, 'no zero');
    assert.doesNotMatch('K7P2QXIB', SHARE_ID_PATTERN, 'no I');
  });

  it('gives link previews the card and sends people on to the site', () => {
    assert.equal(isLinkPreview('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), true);
    assert.equal(isLinkPreview('Twitterbot/1.0'), true);
    assert.equal(isLinkPreview('WhatsApp/2.23.20.0'), true);
    assert.equal(isLinkPreview('facebookexternalhit/1.1'), true);
    assert.equal(
      isLinkPreview('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'),
      false,
    );
    assert.equal(isLinkPreview(undefined), false);
  });

  it('lands a person on the invite, with the share for the banner', () => {
    assert.equal(shareLandingPath(share), '/?ref=ABC123&win=K7P2QXAB');
    assert.equal(shareLandingPath({ ...share, referralCode: null }), '/?win=K7P2QXAB');
  });

  /* The masked name is on the card only: in the preview's title and text the stars read badly
   * (2026-10-28). */
  it('previews as the win, with the card as its picture and nobody named', () => {
    assert.equal(shareTitle(share), '$12.5M win on Crash');
    assert.equal(shareDescription(share), '54.2× on a $230K bet. Join DonutLuxe with this invite.');
    assert.equal(shareDescription({ ...share, referralCode: null }), '54.2× on a $230K bet. DonutLuxe, the DonutSMP casino.');
    const html = sharePageHtml(share, 'https://donutluxe.com');
    assert.doesNotMatch(html, /S\*{8}/);
    /* Versioned, the picture AND the link: Discord keeps the title it read the first time it saw a
     * URL, and the first version's title had the player's real name in it. */
    assert.match(html, /<meta property="og:image" content="https:\/\/donutluxe\.com\/w\/K7P2QXAB\.png\?v=4" \/>/);
    assert.match(html, /<meta property="og:url" content="https:\/\/donutluxe\.com\/w\/K7P2QXAB\?v=4" \/>/);
    assert.equal(shareUrl(share, 'https://donutluxe.com'), 'https://donutluxe.com/w/K7P2QXAB?v=4');
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    assert.match(html, /<meta property="og:title" content="\$12\.5M win on Crash" \/>/);
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
  });

  it('escapes whatever it is given', () => {
    const html = sharePageHtml({ ...share, gameName: '"><script>alert(1)</script>' }, 'https://donutluxe.com');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&#34;&#62;&#60;script&#62;/);
  });

  /* 2026-10-28: the first version put the player's real name on the card, in the preview's title and
   * in the share the landing page reads. It is masked now, by the live feed's own SQL. */
  it('hands out the player only as the masked name', async () => {
    const routes = await read('../src/routes/shares.ts');
    const columns = /const SHARE_COLUMNS = `([^`]+)`;/.exec(routes)?.[1];
    assert.equal(columns, "id, game, ${maskedName('player_name')} AS player, wager_minor, payout_minor, referral_code");
    // player_name appears in the masked select and in the insert, and is read nowhere else.
    assert.deepEqual(
      [...routes.matchAll(/player_name/g)].length,
      [...routes.matchAll(/maskedName\('player_name'\)|INSERT INTO win_shares \(id, user_id, game, round_id, player_name/g)].length,
    );
  });
});

describe('the round a card is made from', () => {
  it('is read from the same sources as the history, by its id', () => {
    const sql = roundSql('crash');
    assert.match(sql, /= \$2::uuid/);
    // The slot machines are one source keyed by a column, so the game is a parameter there.
    assert.match(sql, /= \$3::text/);
    const named = ROUND_SOURCES.filter((source) => source.game !== null && source.game !== 'crash');
    for (const source of named) assert.ok(!sql.includes(source.from), `${source.game} is not read for a crash round`);
  });

  it('can be built for every game the history knows', () => {
    for (const game of Object.keys(ROUND_GAMES)) assert.ok(roundSql(game).includes('$2::uuid'), game);
  });

  it('comes from the database, never from the request', async () => {
    const routes = await read('../src/routes/shares.ts');
    assert.match(routes, /const createSchema = z\.object\(\{ game: z\.enum\(ROUND_GAME_KEYS\), id: z\.uuid\(\) \}\)\.strict\(\);/);
    assert.match(routes, /await client\.query<\{ wager: string; payout: string \}>\(roundSql\(game\), \[userId, roundId, game\]\)/);
    // Play money is never shared, whether the session says so or the account does.
    assert.match(routes, /if \(request\.authUser\?\.demoOf\) \{/);
    assert.match(routes, /if \(account\.demo\) throw new AppError\(409, 'SHARE_TEST_MODE'/);
  });
});
