/* ticker.js — the Live Feed.
 *
 * Three kinds of event share one chronological stream, newest first:
 *
 *   case      a crate was opened — what it cost, what it paid.
 *   upgrade   an upgrader round settled — stake in, payout out.
 *   faction   a wager was credited to a team in the running war.
 *
 * Wins AND losses. A feed that showed only wins would be a highlight reel, and on a gambling site
 * that misrepresents the odds to whoever is watching it to decide whether to play.
 *
 * ── why this is not a drawer any more ──
 * This was `position: fixed; bottom: 12px` at 46vh: a floating panel welded over the bottom of
 * every page, covering the hero, the stats row and roughly half the viewport, with a Hide button
 * to get it out of the way. A feed is ambient information. Ambient information does not get to
 * occupy the foreground of every route and make the player dismiss it before they can read the
 * page they actually asked for. It now sits in the document flow at the foot of the main column,
 * scrolls past like everything else, and carries its own internal scroller so a long feed cannot
 * push the page down a screen.
 *
 * Nothing here is rendered with innerHTML beyond the static shell. Every value on a row is a
 * server-supplied string — a masked player name, a crate name, a team name — and each one goes in
 * with textContent, so a name cannot carry markup regardless of what the sanitizer upstream did
 * or did not catch.
 */
import { state, bus, refreshActivity } from './store.js';
import { $, el } from './util.js';
import { API_BASE_URL } from './api.js';

const REFRESH_MS = 8000;
const MAX_ROWS = 40;

/* Hex colours arrive from the factions table. The DB constrains the format, but a value that
 * reaches a style property is treated as untrusted regardless: anything that is not exactly six
 * hex digits is dropped rather than written. */
const HEX = /^#[0-9a-f]{6}$/i;

let root = null;
let timer = 0;

export function initTicker(mount) {
  root = mount || document.getElementById('tickerRoot');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';

  root.innerHTML = `
    <section class="feed" aria-label="Live feed">
      <header class="feed__head">
        <span class="feed__dot" aria-hidden="true"></span>
        <h2 class="feed__title">Live Feed</h2>
        <span class="feed__sub">Every settled round, win or lose</span>
      </header>
      <div class="feed__cols" aria-hidden="true">
        <span>Game</span><span>Player</span><span>Time</span>
        <span>Wager</span><span>Mult</span><span>Result</span>
      </div>
      <div class="feed__rows" id="feedRows" role="table" aria-label="Recent rounds"></div>
    </section>`;

  paint();
  bus.addEventListener('change', (event) => {
    if (['activity', 'ready', 'case-open', 'upgrade'].includes(event.detail)) paint();
  });

  /* Polled, because the backend has no realtime channel. Paused while the tab is hidden so a
   * backgrounded page stops asking. */
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    refreshActivity().catch(() => undefined);
  };
  timer = window.setInterval(tick, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
}

export function stopTicker() {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

function paint() {
  if (!root?.isConnected) return;
  const rows = $('#feedRows', root);
  if (!rows) return;

  const plays = (state.activities || []).slice(0, MAX_ROWS);
  rows.innerHTML = '';

  if (!plays.length) {
    rows.appendChild(el('p', 'feed__empty', 'No rounds yet. The first play shows up here.'));
    return;
  }
  for (const play of plays) rows.appendChild(buildRow(play));
}

function buildRow(play) {
  return play.kind === 'faction' ? buildContribution(play) : buildRound(play);
}

/* ─────────── a settled round ─────────── */
function buildRound(play) {
  const wager = Number(play.wagerMinor ?? play.wager_minor ?? 0);
  const payout = Number(play.payoutMinor ?? play.payout_minor ?? 0);
  /* The multiple is payout over stake. A zero stake would divide by zero, so it reads as no
   * multiple rather than Infinity. */
  const multiple = wager > 0 ? payout / wager : 0;
  const delta = payout - wager;
  const won = delta > 0;

  const row = el('div', 'feedrow');
  row.setAttribute('role', 'row');
  row.dataset.won = won ? '1' : '0';

  row.append(
    gameCell(play),
    playerCell(play),
    cell('feedrow__t mono', clock(play.createdAt ?? play.created_at)),
    stakeCell(wager),
  );

  const mult = cell('feedrow__mult mono', `${multiple.toFixed(2)}×`);
  /* Three bands, not two. A round that returned less than the stake is a loss even when it paid
   * something, and a big multiple is worth seeing from the other side of the page — so under 1x is
   * red, over 1.5x glows, and the ordinary middle stays quiet. */
  mult.dataset.band = multiple < 1 ? 'down' : multiple > 1.5 ? 'hot' : 'flat';
  mult.dataset.up = multiple > 1 ? '1' : '0';

  const swing = money('feedrow__delta mono', Math.abs(delta), won ? '+' : '−');
  swing.dataset.up = won ? '1' : '0';

  row.append(mult, swing);
  return row;
}

/* ─────────── a team contribution ─────────── */
function buildContribution(play) {
  const amount = Number(play.wagerMinor ?? play.wager_minor ?? 0);

  const row = el('div', 'feedrow feedrow--team');
  row.setAttribute('role', 'row');
  // The faction's own colour, but only if it really is a hex triplet.
  const accent = play.accent ?? play.color;
  if (typeof accent === 'string' && HEX.test(accent)) row.style.setProperty('--team', accent);

  const game = gameCell(play);
  const badge = el('i', 'feedrow__team');
  badge.textContent = play.sourceName ?? play.source_name ?? 'Team';
  game.appendChild(badge);

  row.append(
    game,
    playerCell(play),
    cell('feedrow__t mono', clock(play.createdAt ?? play.created_at)),
    money('feedrow__stake mono', amount),
    /* No multiple and no result: a contribution is a wager credited to a side, not a round that
     * settled. Printing 0.00× here would read as a total loss, which is a different event. */
    cell('feedrow__mult mono feedrow__na', '—'),
    cell('feedrow__delta feedrow__na', 'contributed'),
  );
  return row;
}

/* ─────────── bits ─────────── */
function cell(className, text) {
  const node = el('span', className);
  node.setAttribute('role', 'cell');
  node.textContent = text;
  return node;
}

function money(className, value, sign = '') {
  const node = el('span', className);
  node.setAttribute('role', 'cell');
  node.append(coin(), document.createTextNode(`${sign}${compact(value)}`));
  return node;
}

function coin() {
  const mark = el('i', 'feedrow__coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/**
 * The game, as a badge with a glyph.
 *
 * A bare string in a column is a string somebody has to read; a glyph plus a short label is one a
 * player recognises without reading. The glyph is a character rather than an image so it costs no
 * request and cannot fail to load.
 */
function gameCell(play) {
  const kind = play.kind || '';
  const glyph = kind === 'case' ? '\u{1F4E6}' : kind === 'upgrade' ? '\u26A1' : kind === 'roulette' ? '\u25C9' : '\u2694';
  const node = cell('feedrow__game', '');
  const chip = el('span', 'gamechip');
  chip.dataset.kind = kind || 'other';
  const icon = el('em', 'gamechip__ico');
  icon.textContent = glyph;
  const label = el('span');
  label.textContent = gameLabel(play);
  chip.append(icon, label);
  node.append(chip);
  return node;
}

/**
 * The player, with a head.
 *
 * The name remains masked, while the head is requested from this origin by opaque internal id.
 * This keeps the username out of the image URL and prevents each viewer's browser from telling a
 * third-party avatar service which players appear in the feed.
 */
function playerCell(play) {
  const node = cell('feedrow__who', '');
  const name = play.player || '???';
  const head = el('span', 'feedav');
  const playerId = play.playerId ?? play.player_id;
  const paintInitial = () => {
    const initial = el('i');
    initial.textContent = name.slice(0, 1).toUpperCase();
    head.appendChild(initial);
  };
  if (playerId) {
    const art = document.createElement('img');
    art.alt = '';
    art.loading = 'lazy';
    art.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(playerId)}?s=22`;
    art.addEventListener('error', () => {
      art.remove();
      paintInitial();
    });
    head.appendChild(art);
  } else {
    paintInitial();
  }
  const label = el('span', 'mono');
  label.textContent = name;
  node.append(head, label);
  return node;
}

/** The wager, as a coin chip rather than a bare figure. */
function stakeCell(amount) {
  const node = cell('feedrow__stake', '');
  const chip = el('span', 'coinchip');
  const coin = el('i', 'coinchip__coin');
  coin.setAttribute('aria-hidden', 'true');
  const label = el('b', 'mono');
  /* The module's own compact(), uppercased: it returns `150m` and a chip reads better as `150M`. */
  label.textContent = compact(amount).toUpperCase();
  chip.append(coin, label);
  node.append(chip);
  return node;
}

function gameLabel(play) {
  const kind = play.kind || '';
  if (kind === 'case') return 'Case-Opening';
  if (kind === 'upgrade') return 'Upgrader';
  if (kind === 'roulette') return 'Roulette';
  return play.sourceName || play.source_name || 'Round';
}

function clock(value) {
  const at = value ? new Date(value) : new Date();
  if (Number.isNaN(at.getTime())) return '--:--';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/* 588.28k / 1.42m / 5.9m — the feed's own compact form.
 *
 * Deliberately not money(): this table has a coin glyph in front of every figure, so a currency
 * symbol as well would be saying it twice, and lowercase suffixes keep a dense column quiet. */
function compact(value) {
  const n = Math.abs(Math.round(Number(value) || 0));
  if (n >= 1e12) return trim(n / 1e12) + 't';
  if (n >= 1e9) return trim(n / 1e9) + 'b';
  if (n >= 1e6) return trim(n / 1e6) + 'm';
  if (n >= 1e3) return trim(n / 1e3) + 'k';
  return String(n);
}

function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x.toFixed(2);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
