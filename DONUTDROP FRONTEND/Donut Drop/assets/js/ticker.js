/* ticker.js — the Live Feed, as the redesign preview's "Live bets" (2026-11-20).
 *
 * A table under every page: the game, the player, the time, the bet, the multiplier and what it
 * paid, with four lists: every bet, the high rollers ($50M and up), the lucky wins (10x and up)
 * and, signed in, your own. All four are the same stream filtered, so nothing here asks the
 * server for more than the feed already holds, and a round held back while its animation plays
 * stays held back in every list.
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
import { linkPlayer } from './player-link.js';
import { $, el } from './util.js';
import { API_BASE_URL } from './api.js';

// Recovery-only fallback; normal updates are pushed by the shared live-event stream.
const REFRESH_MS = 30_000;
const MAX_ROWS = 10;
const HIGH_ROLLER = 50_000_000;
const LUCKY = 10;
const TABS = [['all', 'All bets'], ['high', 'High rollers'], ['lucky', 'Lucky wins'], ['mine', 'My bets']];
let tab = 'all';

/* Each game's lobby sprite, so a row reads as its game at a glance. */
const ART = {
  case: 'game-crates.svg', upgrade: 'game-upgrader.svg', roulette: 'game-roulette.svg', blackjack: 'game-blackjack.svg',
  crash: 'game-crash.svg', mines: 'game-mines.svg', tower: 'game-tower.svg', chicken: 'chicken.svg', plinko: 'game-plinko.svg',
  dice: 'dice.svg', limbo: 'game-limbo.svg', stocks: 'game-stocks.svg', fishing: 'game-fishing.svg',
  icefishing: 'game-ice-fishing.svg', derby: 'game-derby.svg', slots: 'game-ore-rush.svg', coinflip: 'game-coinflip.svg',
  minesduel: 'game-mines-duel.svg', battle: 'game-battles.svg',
};

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
    <section class="lxbets" aria-labelledby="feedTitle">
      <div class="lxbets__head">
        <h2 class="lxbets__title" id="feedTitle"><span class="lxbets__dot" aria-hidden="true"></span>Live bets</h2>
        <div class="lxbets__tabs" role="tablist" aria-label="Bet lists">
          ${TABS.map(([code, label]) => `<button class="lxbets__tab" role="tab" type="button" data-btab="${code}" aria-selected="${code === tab}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="lxbets__wrap">
        <table class="lxbtable">
          <thead><tr><th scope="col">Game</th><th scope="col" class="c-user">Player</th><th scope="col" class="c-time">Time</th><th scope="col" class="r c-bet">Bet</th><th scope="col" class="r">Multiplier</th><th scope="col" class="r">Payout</th></tr></thead>
          <tbody id="feedRows"></tbody>
        </table>
      </div>
    </section>`;
  for (const button of root.querySelectorAll('[data-btab]')) {
    button.addEventListener('click', () => {
      tab = button.dataset.btab;
      for (const other of root.querySelectorAll('[data-btab]')) other.setAttribute('aria-selected', String(other === button));
      paint();
    });
  }

  paint();
  bus.addEventListener('change', (event) => {
    if (['activity', 'ready', 'case-open', 'upgrade'].includes(event.detail)) paint();
  });

  /* A slow recovery poll remains in case a browser or intermediary cannot hold the live stream.
   * The normal path is event-driven and makes no request while the feed is idle. */
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
  const mine = root.querySelector('[data-btab="mine"]');
  if (mine) mine.hidden = !state.authenticated;
  if (tab === 'mine' && !state.authenticated) tab = 'all';

  const plays = (state.activities || []).filter(inTab).slice(0, MAX_ROWS);
  rows.innerHTML = '';

  if (!plays.length) {
    const empty = el('tr', 'lxbrow lxbrow--empty');
    const note = el('td');
    note.colSpan = 6;
    note.textContent = tab === 'mine' ? 'No bets of yours yet. Your next round shows up here.' : 'No bets in this list yet.';
    empty.append(note);
    rows.appendChild(empty);
    return;
  }
  for (const play of plays) rows.appendChild(buildRow(play));
}

function inTab(play) {
  if (tab === 'all') return true;
  if (play.kind === 'faction') return false;
  const wager = Number(play.wagerMinor ?? play.wager_minor ?? 0);
  const payout = Number(play.payoutMinor ?? play.payout_minor ?? 0);
  if (tab === 'high') return wager >= HIGH_ROLLER;
  if (tab === 'lucky') return wager > 0 && payout / wager >= LUCKY;
  return Boolean(state.user?.id) && (play.playerId ?? play.player_id) === state.user.id;
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

  const row = el('tr', 'lxbrow');
  row.dataset.won = won ? '1' : '0';
  row.append(
    gameCell(play),
    playerCell(play),
    cell('c-time', clock(play.createdAt ?? play.created_at)),
    cell('r c-bet', dollars(wager)),
    cell('r', `${multiple.toFixed(2)}×`),
  );
  /* A round that paid back exactly its stake neither won nor lost: it reads as a plain $0. */
  const swing = cell(`r ${won ? 'pos' : 'neg'}`, dollars(Math.abs(delta), won ? '+' : delta < 0 ? '−' : ''));
  row.append(swing);
  return row;
}

/* ─────────── a team contribution ─────────── */
function buildContribution(play) {
  const amount = Number(play.wagerMinor ?? play.wager_minor ?? 0);

  const row = el('tr', 'lxbrow lxbrow--team');
  // The faction's own colour, but only if it really is a hex triplet.
  const accent = play.accent ?? play.color;
  if (typeof accent === 'string' && HEX.test(accent)) row.style.setProperty('--team', accent);

  const game = gameCell(play);
  const badge = el('i', 'lxbrow__team');
  badge.textContent = play.sourceName ?? play.source_name ?? 'Team';
  game.appendChild(badge);

  row.append(
    game,
    playerCell(play),
    cell('c-time', clock(play.createdAt ?? play.created_at)),
    cell('r c-bet', dollars(amount)),
    /* No multiple and no result: a contribution is a wager credited to a side, not a round that
     * settled. Printing 0.00× here would read as a total loss, which is a different event. */
    cell('r neg', '—'),
    cell('r neg', 'contributed'),
  );
  return row;
}

/* ─────────── bits ─────────── */
function cell(className, text) {
  const node = el('td', className);
  node.textContent = text;
  return node;
}

/** $480K, +$33.6K, −$140M: the preview's figures. */
function dollars(value, sign = '') {
  return `${sign}$${compact(value).toUpperCase()}`;
}

/** The game: its lobby sprite and its name. */
function gameCell(play) {
  const kind = play.kind || '';
  const node = cell('', '');
  const chip = el('span', 'lxgcell');
  chip.dataset.kind = kind || 'other';
  const icon = document.createElement('img');
  icon.alt = '';
  icon.loading = 'lazy';
  const source = play.sourceName || play.source_name;
  const file = kind === 'slots' && source === 'Ocean Monument' ? 'game-monument.svg' : ART[kind] || 'game-battles.svg';
  icon.src = `assets/img/items/${file}`;
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
  const node = cell('c-user', '');
  const name = play.player || '???';
  const head = el('span', 'feedav');
  const playerId = play.playerId ?? play.player_id;
  const paintInitial = () => {
    const initial = el('i');
    initial.textContent = name.replace(/^\./, '').slice(0, 1).toUpperCase() || '?';
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
  const you = Boolean(state.user?.id) && playerId === state.user.id;
  label.textContent = you ? 'You' : name;
  if (you) label.classList.add('you');
  node.append(head, label);
  linkPlayer(playerId, name, head, label);
  return node;
}

function gameLabel(play) {
  const kind = play.kind || '';
  if (kind === 'case') return 'Case-Opening';
  if (kind === 'upgrade') return 'Upgrader';
  if (kind === 'roulette') return 'Roulette';
  if (kind === 'blackjack') return 'Blackjack';
  if (kind === 'crash') return 'Crash';
  if (kind === 'mines') return 'Mines';
  if (kind === 'tower') return 'Tower';
  if (kind === 'chicken') return 'Chicken';
  if (kind === 'plinko') return 'Plinko';
  if (kind === 'dice') return 'Dice';
  if (kind === 'limbo') return 'Limbo';
  if (kind === 'stocks') return 'Stocks';
  if (kind === 'fishing') return 'Fishing';
  if (kind === 'icefishing') return 'Ice Fishing';
  if (kind === 'derby') return 'Mob Derby';
  // Both machines report as slots; the row carries which one (Ore Rush or Ocean Monument).
  if (kind === 'slots') return play.sourceName || play.source_name || 'Ore Rush';
  if (kind === 'coinflip') return 'Coinflip';
  if (kind === 'minesduel') return 'Mines Duel';
  return play.sourceName || play.source_name || 'Round';
}

function clock(value) {
  const at = value ? new Date(value) : new Date();
  if (Number.isNaN(at.getTime())) return '--:--';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/* 588.28k / 1.42m / 5.9m — the feed's own compact form, uppercased with a "$" by dollars(). */
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
