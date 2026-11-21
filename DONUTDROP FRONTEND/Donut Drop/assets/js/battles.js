/* battles.js — the Case Battle lobby and the live arena.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THE REELS STAY IN LOCKSTEP
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * They are never synchronised, because they never need to be.
 *
 * The server settles the entire battle before anything moves and sends one payload: every
 * outcome, plus a wall-clock `startsAt` a couple of seconds in the future and a `roundMs`. This
 * client then renders from a pure function of `Date.now()`:
 *
 *     round   = floor((now - startsAt) / roundMs)
 *     progress= ((now - startsAt) % roundMs) / roundMs
 *
 * Nothing about the animation depends on when a message arrived. A player whose socket delivered
 * the payload 400ms late simply computes a progress of 0.07 instead of 0 and joins the spin
 * already in motion — landing on the same tile at the same instant as everyone else. A player who
 * reloads mid-battle recovers perfectly for the same reason: the fetch returns the same outcomes
 * and the same timestamps, and the maths puts them exactly where the others are.
 *
 * "Fast Roll" is therefore not a local speed-up. The host asks the server, the server broadcasts a
 * new anchor and round length, and every client recomputes the same schedule from the same two
 * numbers. Speeding up locally would desynchronise the table instantly, which is the one thing
 * this design exists to prevent.
 *
 * Every string that reaches the DOM here is written with textContent. Player names, crate names
 * and lobby codes are all server-supplied values.
 */
import { api, API_BASE_URL } from './api.js';
import {
  state, bus, refreshBalance, refreshActivity, refreshCases, normalizeItem, holdLiveFigures,
  showBalance,
} from './store.js';
import { $, el, money, safeImage, grouped, reduceMotion } from './util.js';
import { bezier, span } from './fx.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { navigate, onNavigate } from './routing.js';

/* The winner sits at WIN_AT with the rest of the strip as runway behind it. The reels now span the
 * board's full width, so the runway has to cover half of a wide reel or the strip visibly runs out
 * to the right of the winner as it lands. */
const TILE_COUNT = 40;
const WIN_AT = 26;
const RECONNECT_MS = 2_000;

/* Mirrors of the server's own timing (battle-engine.ts). They are used for exactly one thing:
 * reconstructing a clock for a client that reached the arena without one. The socket's anchor
 * always wins the moment it lands, so these can only ever be a few milliseconds out. */
const ROUND_MS = 6_000;
const START_LEAD_MS = 2_500;

/* The spin, as fractions of one round.
 *
 * Lifted from the solo reel (reel.js) so a battle and a solo open feel like the same machine: a
 * constant-speed race nothing is legible during, a long front-loaded brake that sheds almost all
 * the distance, a crawl that inches the last tile-width at walking pace, and then a beat of dwell
 * ON the winner so it can actually be read before the next round snaps in.
 *
 * The previous curve was a bare `1 - (1 - p) ** 3` across the whole round. That sheds its speed
 * immediately and then asymptotes, which reads as a number being assigned rather than a wheel
 * being stopped by friction — and it left no dwell at all, so the winning tile was replaced at the
 * same instant it arrived.
 *
 * Every one of these is a pure function of progress, so the lockstep invariant this file is built
 * on survives untouched: two clients at the same instant still compute the same offset. */
const P_RACE = 0.22;
const P_BRAKE = 0.62;
const P_LAND = 0.84;
const RACE_END = 0.55;
const BRAKE_END = 0.984;
const BRAKE = bezier(0.04, 0.62, 0.10, 1.00);
const CRAWL = bezier(0.25, 0.55, 0.45, 1.00);

/* View state. Kept in the module rather than the DOM so a repaint driven by a balance change
 * cannot reset which lobby the player was looking at. */
const view = {
  screen: 'lobby',
  code: null,
  battle: null,
  lobbies: [],
  /* Started public battles: `live` still has reels turning and can be watched mid-spin, `recent`
   * has finished. Split by the clock, not by status — both are 'settled' from the first frame. */
  live: [],
  recent: [],
  modes: null,
  draft: { format: '1v1', mode: 'standard', visibility: 'public', allowBots: false, caseIds: [] },
  pool: { query: '', sort: 'price' },
  schedule: null,
  fast: false,
};

let root = null;
let socket = null;
let reconnectTimer = 0;
let frame = 0;
let finishedTimer = 0;

/* ─────────────────────────── holding the wallet still ───────────────────────────
 *
 * A battle is settled — and its winners paid — the instant the last seat fills, seconds before
 * the first reel moves. The server's balance event then moved the wallet pill straight away, so the
 * winner watched their own payout land in the header and then sat through the reels that were
 * supposed to tell them. While the viewer has a seat in a battle whose result has not been shown,
 * the live figures are held; they are released, and refreshed, when the reels stop or the player
 * leaves the page. */
let seatHold = null;

function holdForBattle(battle) {
  if (seatHold || !battle?.seats?.some((seat) => seat.isYou) || isRevealed(battle)) return;
  seatHold = holdLiveFigures();
}

function releaseBattleHold() {
  if (!seatHold) return false;
  seatHold();
  seatHold = null;
  refreshBalance().catch(() => undefined);
  refreshActivity().catch(() => undefined);
  return true;
}

/* Views are hidden, not removed, when the player navigates away — a hold kept past that point
 * would freeze the wallet on every other page until they came back. */
onNavigate(() => {
  if (seatHold && root?.closest('.view')?.hidden) releaseBattleHold();
});

export function mountBattles(node) {
  root = $('#battleRoot', node);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    connect();
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'cases'].includes(event.detail)) {
        /* The lobby keeps its host panel across repaints, so a change that affects the panel —
         * signing in, the crate list arriving — repaints it explicitly. */
        if (view.screen === 'lobby') paintCreator();
        paint();
      }
    });
    if (!state.cases.length) refreshCases().catch(() => undefined);
    api.get('/v1/battles/modes').then((modes) => {
      view.modes = modes;
      if (view.screen === 'lobby') paintCreator();
      paint();
    }).catch(() => undefined);
  }

  // A code in the query string opens that battle directly — this is the private invite link.
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^[A-Z0-9]{6,12}$/.test(code)) openBattle(code);
  else {
    view.screen = 'lobby';
    view.code = null;
    refreshLobbies();
    refreshFinished();
  }
  paint();
}

export function stopBattles() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  releaseBattleHold();
  if (finishedTimer) clearTimeout(finishedTimer);
  finishedTimer = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  if (socket) {
    try { socket.close(); } catch { /* already gone */ }
    socket = null;
  }
}

/* ─────────────────────────── transport ─────────────────────────── */

function socketUrl() {
  const base = API_BASE_URL.replace(/^http/, 'ws');
  return `${base}/v1/battles/live`;
}

function connect() {
  if (socket && socket.readyState <= 1) return;
  try {
    socket = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    if (view.code) send({ type: 'watch', code: view.code });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handle(message);
  });

  /* A dropped socket costs live updates, never money or a result: everything that matters is
   * already settled server-side and readable over REST. So a reconnect quietly refreshes rather
   * than warning the player about something that did not affect them. */
  socket.addEventListener('close', () => scheduleReconnect());
  socket.addEventListener('error', () => {
    try { socket?.close(); } catch { /* already gone */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !root?.isConnected) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
    if (view.code) openBattle(view.code, true);
    else refreshLobbies();
  }, RECONNECT_MS);
}

function send(payload) {
  if (socket?.readyState === 1) {
    try { socket.send(JSON.stringify(payload)); } catch { /* dropped */ }
  }
}

function handle(message) {
  switch (message.type) {
    case 'lobby:created':
    case 'lobby:updated':
      if (view.screen === 'lobby') {
        refreshLobbies();
        /* A lobby that filled has started: it leaves the open list and its reels go live. */
        if (message.battle && message.battle.status !== 'lobby' && lobbyOnScreen()) refreshFinished();
      }
      if (view.code && message.battle?.code === view.code) applyBattle(message.battle);
      break;
    case 'lobby:removed':
      if (view.screen === 'lobby') {
        refreshLobbies();
        if (lobbyOnScreen()) refreshFinished();
      }
      break;
    case 'battle:seat':
      if (message.code === view.code) applyBattle(message.battle);
      break;
    case 'battle:start':
      if (message.code === view.code) {
        applyBattle(message.battle);
        view.schedule = message.battle?.schedule ?? null;
        startAnimation();
      }
      break;
    case 'battle:speed':
      if (message.code === view.code) {
        view.fast = message.fast;
        view.schedule = { startsAt: message.startsAt, roundMs: message.roundMs };
        patchArena();
        startAnimation();
      }
      break;
    case 'battle:settled':
      if (message.code === view.code) applyBattle(message.battle);
      break;
    case 'battle:cancelled':
      if (message.code === view.code) {
        toast({ kind: 'lose', title: 'Battle cancelled', body: message.reason });
        goLobby();
      }
      break;
    default:
      break;
  }
}

/* ─────────────────────────── data ─────────────────────────── */

/* Coalesces a burst of calls into at most one request per window: the first runs at once, the
 * rest collapse into a single trailing run. Every lobby event used to fetch, and a busy lobby emits
 * several a second — enough to walk a spectator into the API's per-user rate limit, at which point
 * their own Join is the request that gets refused. */
function coalesce(fn, windowMs) {
  let last = 0;
  let trailing = 0;
  return () => {
    const wait = last + windowMs - Date.now();
    if (wait <= 0) {
      last = Date.now();
      void fn();
      return;
    }
    if (trailing) return;
    trailing = window.setTimeout(() => {
      trailing = 0;
      last = Date.now();
      void fn();
    }, wait);
  };
}

const refreshLobbies = coalesce(fetchLobbies, 1_000);
const refreshFinished = coalesce(fetchFinished, 3_000);

async function fetchLobbies() {
  try {
    const result = await api.get('/v1/battles?status=lobby&limit=24');
    view.lobbies = result.battles ?? [];
    if (view.screen === 'lobby') paint();
  } catch { /* the list is ambient; a failure leaves the last one on screen */ }
}

/* Started battles for the Live and Recent lists. Public ones only: the list endpoint also returns
 * private battles once they have settled, and a private lobby's result is not this page's to show. */
async function fetchFinished() {
  try {
    const result = await api.get('/v1/battles?status=settled&limit=12');
    splitFinished((result.battles ?? []).filter((battle) => battle.visibility === 'public'));
  } catch { /* ambient, like the open list */ }
}

/* Live until the last reel stops, Recent after. The split is re-run the moment the next live battle
 * finishes, and the list is refetched every half minute while the lobby is on screen. */
function splitFinished(finished) {
  if (!root?.isConnected) return;
  const now = Date.now();
  view.live = finished.filter((battle) => (lobbySpinEnd(battle) ?? 0) > now);
  view.recent = finished.filter((battle) => (lobbySpinEnd(battle) ?? 0) <= now).slice(0, 8);

  if (finishedTimer) clearTimeout(finishedTimer);
  const next = Math.min(...view.live.map((battle) => lobbySpinEnd(battle) ?? Infinity));
  finishedTimer = window.setTimeout(() => {
    finishedTimer = 0;
    /* Stops re-arming once the player has moved on; the next visit to the lobby starts it again. */
    if (!lobbyOnScreen()) return;
    if (Number.isFinite(next)) splitFinished([...view.live, ...view.recent]);
    else refreshFinished();
  }, Number.isFinite(next) ? Math.max(250, next - now + 250) : 30_000);

  if (view.screen === 'lobby') paint();
}

/* Views are hidden rather than removed when the player navigates away, so "connected" is not
 * "on screen". The Live and Recent lists are only refetched while somebody can actually see them. */
function lobbyOnScreen() {
  return Boolean(root?.isConnected) && view.screen === 'lobby' && !root.closest('.view')?.hidden;
}

/* When a started battle's last reel stops, from its own start stamp. A normal roll is assumed: a
 * fast-rolled battle ends sooner and simply moves to Recent on the next split. */
function lobbySpinEnd(battle) {
  const started = Date.parse(battle?.startedAt ?? '');
  if (!Number.isFinite(started)) return null;
  return started + START_LEAD_MS + ROUND_MS * (battle.rounds?.length ?? 0);
}

async function openBattle(code, quiet = false) {
  try {
    const result = await api.get(`/v1/battles/${encodeURIComponent(code)}`);
    /* A different battle means a different clock. Carrying the last one over would animate this
     * battle against the previous battle's anchor — which, for a battle that has already ended,
     * reads as the reels being skipped entirely. A quiet reconnect to the SAME battle keeps it. */
    if (view.code !== code) {
      view.schedule = null;
      view.fast = false;
    }
    view.screen = 'arena';
    view.code = code;
    applyBattle(result.battle);
    send({ type: 'watch', code });
    if (result.battle?.status !== 'lobby') startAnimation();
    paint();
  } catch (error) {
    if (!quiet) {
      toast({ kind: 'lose', title: 'Battle not found', body: error?.message ?? 'Bad code' });
      goLobby();
    }
  }
}

function applyBattle(battle) {
  if (!battle) return;
  view.battle = battle;
  if (battle.schedule) view.schedule = battle.schedule;
  holdForBattle(battle);
  paint();
}

function goLobby() {
  if (view.code) send({ type: 'unwatch', code: view.code });
  view.screen = 'lobby';
  view.code = null;
  view.battle = null;
  view.schedule = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  releaseBattleHold();
  navigate('/battles');
  refreshLobbies();
  paint();
}

/* ────────────────────────── the clock, and what it is allowed to show ──────────────────────────
 *
 * The server settles a battle the instant the last seat fills — payouts, winning team, revealed
 * seeds and all — and broadcasts that settled battle BEFORE it broadcasts the start. The REST
 * payload does the same and carries no schedule at all, which is what a player who took the last
 * seat, or who reloaded mid-battle, is holding when they reach the arena.
 *
 * So `status === 'settled'` answers "has the server finished?", never "has the player watched it
 * happen?". Painting from it printed the profit before a single reel had turned. Everything the
 * result touches is gated on the local clock passing the end of the schedule instead — the same
 * pure function of Date.now() that drives the reels, so what the player is told and what the
 * player is shown can never disagree.
 */

/** The anchor to animate against, reconstructed when the socket has not delivered one yet. */
function scheduleFor(battle = view.battle) {
  if (view.schedule) return view.schedule;
  if (!battle?.startedAt) return null;
  /* The server stamps `started_at` immediately before it announces the start, so this lands within
   * a few milliseconds of the real anchor. `roundMs` assumes a normal roll; a fast lobby corrects
   * itself the moment `battle:speed` or `battle:start` arrives and replaces this wholesale. */
  const started = Date.parse(battle.startedAt);
  if (!Number.isFinite(started)) return null;
  return { startsAt: started + START_LEAD_MS, roundMs: ROUND_MS };
}

function spinEndsAt(battle = view.battle) {
  const schedule = scheduleFor(battle);
  if (!schedule || !battle?.rounds?.length) return null;
  return schedule.startsAt + schedule.roundMs * battle.rounds.length;
}

/** True once the last reel has stopped — the only moment the result may reach the screen. */
function isRevealed(battle = view.battle) {
  if (!battle || battle.status !== 'settled') return false;
  const end = spinEndsAt(battle);
  if (end === null) return true;   // an archived battle with no recoverable clock
  return Date.now() >= end;
}

/** True while the reels are turning, or waiting out the lead-in before they do. */
function isSpinning(battle = view.battle) {
  if (!battle || battle.status === 'lobby') return false;
  const end = spinEndsAt(battle);
  return end !== null && Date.now() < end;
}

/* ─────────────────────────── painting ─────────────────────────── */

function paint() {
  if (!root?.isConnected) return;
  if (view.screen === 'arena' && view.battle) {
    /* A full repaint during a spin tears the strip out from under the animation. Every socket
     * message that touches this battle — a watcher count, a lobby echo, the settled payload that
     * arrives seconds before anyone is meant to see it — would otherwise rebuild every reel
     * mid-flight, which is what made the items appear to flicker and change. While the reels are
     * turning the arena is patched in place instead. */
    if (isSpinning() && showsLiveBoard()) patchArena();
    else paintArena();
    return;
  }
  paintLobby();
}

/* Whether the arena on screen is already the board this battle is spinning on. It is not enough to
 * ask whether an arena exists: the lobby-to-running transition swaps "Waiting for a player…"
 * placeholders for real seats and drops the waiting bar, so that one has to repaint. Everything
 * after it — watcher counts, lobby echoes, the settled payload — must not. */
function showsLiveBoard() {
  const arena = root.querySelector('.arena');
  return arena?.dataset.phase === 'run'
    && Number(arena.dataset.seats) === view.battle.seats.length;
}

/** The only things that can legitimately change while the reels are turning. */
function patchArena() {
  const fast = $('#arenaFast', root);
  if (!fast || !view.battle) return;
  fast.setAttribute('aria-checked', String(view.fast));
  fast.disabled = !view.battle.isHost;
}

function paintLobby() {
  /* The skeleton is built once and the lists are repainted into it. Rebuilding the whole lobby on
   * every socket echo also rebuilt the host panel, which threw away a half-typed crate search and
   * the pool's scroll position each time somebody else joined a battle. */
  if (!root.querySelector('.btl')) {
    root.innerHTML = `
      <div class="btl">
        <aside class="btl__make" id="btlMake"></aside>
        <div class="btl__list">
          <p class="btl__paused" id="btlPaused" role="status" hidden>
            Case Battles are paused for now. Open lobbies are being refunded, and nobody can host or
            join until they are back.
          </p>
          <section class="btl__sec" id="btlLiveSec" hidden>
            <div class="btl__listhead">
              <h2><i class="btl__dot" aria-hidden="true"></i>Live now</h2>
              <span class="btl__count mono" id="btlLiveCount"></span>
            </div>
            <div class="btl__rows" id="btlLive"></div>
          </section>
          <section class="btl__sec">
            <div class="btl__listhead">
              <h2>Open battles</h2>
              <span class="btl__count mono" id="btlCount"></span>
            </div>
            <div class="btl__rows" id="btlRows"></div>
          </section>
          <section class="btl__sec" id="btlRecentSec" hidden>
            <div class="btl__listhead">
              <h2>Recent battles</h2>
            </div>
            <div class="btl__recent" id="btlRecent"></div>
          </section>
        </div>
      </div>`;
    paintCreator();
  }
  paintLists();
}

/** The server says whether battles are open; until it has answered they are assumed to be. */
function battlesPaused() {
  return view.modes?.enabled === false;
}

function paintLists() {
  const rows = $('#btlRows', root);
  if (!rows) return;
  $('#btlPaused', root).hidden = !battlesPaused();
  $('#btlCount', root).textContent = `${view.lobbies.length} waiting`;
  rows.replaceChildren(...(view.lobbies.length
    ? view.lobbies.map((lobby) => battleCard(lobby, 'open'))
    : [el('p', 'empty', 'No open battles. Host one and it appears here.')]));

  $('#btlLiveSec', root).hidden = view.live.length === 0;
  $('#btlLiveCount', root).textContent = `${view.live.length} spinning`;
  $('#btlLive', root).replaceChildren(...view.live.map((battle) => battleCard(battle, 'live')));

  $('#btlRecentSec', root).hidden = view.recent.length === 0;
  $('#btlRecent', root).replaceChildren(...view.recent.map(recentRow));
}

/** A lobby waiting for players, or a battle whose reels are turning right now. */
function battleCard(battle, kind) {
  const card = el('article', 'btlcard');
  card.dataset.mode = battle.mode;
  card.dataset.kind = kind;
  const mine = battle.isHost || battle.seats.some((seat) => seat.isYou);
  card.dataset.mine = mine ? '1' : '0';

  const head = el('div', 'btlcard__head');
  head.append(formatPill(battle));
  if (kind === 'live') {
    const live = el('span', 'btlcard__live');
    live.append(el('i', 'btl__dot'), document.createTextNode('LIVE'));
    head.append(live);
  }
  const rule = el('span', 'btlcard__crazy');
  rule.textContent = battle.mode === 'crazy' ? 'Crazy · lowest wins' : 'Highest wins';
  head.append(rule);

  const stats = statRow([
    ['Entry', money(Number(battle.entryCostMinor))],
    ['Value', money(battleValue(battle))],
    ['Rounds', String(battle.rounds.length)],
  ]);

  const foot = el('div', 'btlcard__foot');
  const host = el('span', 'btlcard__host');
  host.textContent = `by ${battle.host}`;
  const full = battle.seats.length >= battle.seatCount;
  const action = el('button', 'btn btn--go btlcard__join');
  action.type = 'button';
  action.textContent = kind === 'live' ? 'Watch'
    : mine ? 'Open'
      : full ? 'Watch' : `Join · ${money(Number(battle.entryCostMinor))}`;
  action.addEventListener('click', () => {
    if (kind === 'live' || mine || full) navigate(`/battles?code=${encodeURIComponent(battle.code)}`);
    else joinBattle(battle.code, battle.entryCostMinor);
  });
  foot.append(host, action);

  card.append(head, crateRow(battle.rounds, 6), seatSlots(battle));
  if (kind === 'live') card.append(liveProgress(battle));
  card.append(stats, foot);
  return card;
}

/* How far a live battle's reels have got, as a bar that runs itself to the end. */
function liveProgress(battle) {
  const bar = el('div', 'btlcard__prog');
  const started = Date.parse(battle.startedAt ?? '') + START_LEAD_MS;
  const length = ROUND_MS * battle.rounds.length;
  const done = Math.min(1, Math.max(0, (Date.now() - started) / length));
  const fill = el('i');
  fill.style.setProperty('--from', String(done));
  fill.style.setProperty('--ms', `${Math.max(0, Math.round((1 - done) * length))}ms`);
  bar.appendChild(fill);
  return bar;
}

/** A finished battle: who took it and how much. */
function recentRow(battle) {
  const row = el('div', 'btlrec');
  row.dataset.mode = battle.mode;
  const winners = battle.seats.filter((seat) => seat.team === battle.winningTeam);
  const paid = winners.filter((seat) => Number(seat.payoutMinor) > 0);

  const who = el('span', 'btlrec__win');
  who.innerHTML = TROPHY_SVG;
  const names = el('span');
  names.textContent = paid.length
    ? paid.map((seat) => (seat.isYou ? 'You' : seat.name)).join(' & ')
    : 'Bot';
  who.appendChild(names);

  const pot = el('b', 'btlrec__pot mono');
  pot.textContent = money(Number(battle.potMinor ?? 0));
  const ago = el('span', 'btlrec__ago');
  ago.textContent = timeAgo(battle.settledAt ?? battle.startedAt);
  const replay = el('button', 'btn btn--tiny');
  replay.type = 'button';
  replay.textContent = 'Replay';
  replay.addEventListener('click', () => navigate(`/battles?code=${encodeURIComponent(battle.code)}`));

  const crates = crateRow(battle.rounds, 4);
  crates.classList.add('btlrec__crates');
  row.append(formatPill(battle), crates, who, pot, ago, replay);
  return row;
}

function formatPill(battle) {
  const pill = el('span', 'btlcard__fmt');
  pill.textContent = formatLabel(battle);
  return pill;
}

function statRow(pairs) {
  const row = el('div', 'btlstats');
  for (const [label, value] of pairs) {
    const cell = el('span');
    const name = el('i');
    name.textContent = label;
    const figure = el('b', 'mono');
    figure.textContent = value;
    cell.append(name, figure);
    row.appendChild(cell);
  }
  return row;
}

/* The crates of a battle, each crate once with a count, in the order they are first opened. Ten
 * thumbnails of the same crate said less than one thumbnail marked x10. */
function crateGroups(rounds) {
  const groups = [];
  for (const round of rounds) {
    const known = groups.find((group) => group.caseId === round.caseId);
    if (known) known.count += 1;
    else groups.push({ caseId: round.caseId, round, count: 1 });
  }
  return groups;
}

function crateRow(rounds, limit) {
  const row = el('div', 'btlcard__crates');
  const groups = crateGroups(rounds);
  for (const group of groups.slice(0, limit)) {
    const chip = el('span', 'btlcrate');
    chip.title = group.count > 1 ? `${group.round.name} ×${group.count}` : group.round.name;
    const art = document.createElement('img');
    art.src = safeImage(crateArt(group.round));
    art.alt = '';
    art.loading = 'lazy';
    chip.appendChild(art);
    if (group.count > 1) {
      const count = el('b', 'btlcrate__n mono');
      count.textContent = `×${group.count}`;
      chip.appendChild(count);
    }
    row.appendChild(chip);
  }
  if (groups.length > limit) {
    const more = el('span', 'btlcrate btlcrate--more mono');
    more.textContent = `+${groups.length - limit}`;
    row.appendChild(more);
  }
  return row;
}

/* Who is in, team by team. A seat is a coloured chip with the player's initial, an open seat a
 * dashed ring, and the teams are split by "vs" so a 2v2 reads as two pairs rather than four. */
function seatSlots(battle) {
  const row = el('div', 'btlslots');
  for (let team = 0; team < battle.teamCount; team += 1) {
    if (team > 0) row.appendChild(el('i', 'btlslots__vs', 'vs'));
    const group = el('span', 'btlslots__team');
    group.dataset.team = String(team);
    for (let offset = 0; offset < battle.teamSize; offset += 1) {
      const index = team * battle.teamSize + offset;
      const occupant = battle.seats.find((seat) => seat.seat === index);
      const slot = el('span', 'btlslot');
      slot.dataset.filled = occupant ? '1' : '0';
      if (occupant) {
        slot.dataset.you = occupant.isYou ? '1' : '0';
        slot.dataset.bot = occupant.isBot ? '1' : '0';
        slot.textContent = occupant.isBot ? 'B' : initials(occupant.name);
        slot.title = occupant.isYou ? 'You' : occupant.name;
      } else {
        slot.textContent = '+';
        slot.title = 'Open seat';
      }
      group.appendChild(slot);
    }
    row.appendChild(group);
  }
  const count = el('span', 'btlslots__count mono');
  count.textContent = `${battle.seats.length}/${battle.seatCount}`;
  row.appendChild(count);
  return row;
}

function paintCreator() {
  const panel = $('#btlMake', root);
  if (!panel) return;

  const formats = view.modes?.modes ?? [];

  panel.innerHTML = `
    <h2>Host a battle</h2>
    <div class="btl__field">
      <span class="btl__label">Format</span>
      <div class="btl__chips" id="btlFormats"></div>
    </div>
    <div class="btl__field">
      <span class="btl__label">Rules</span>
      <div class="btl__chips" id="btlModes"></div>
    </div>
    <div class="btl__field">
      <span class="btl__label">Lobby</span>
      <div class="btl__chips" id="btlVis"></div>
    </div>
    <label class="btl__toggle" id="btlBots">
      <span>Fill empty seats with bots</span>
      <i class="btl__sw" aria-hidden="true"></i>
    </label>
    <div class="btl__field">
      <span class="btl__label btl__label--row">Crates <b id="btlPickCount"></b>
        <button class="btl__clear" id="btlClear" type="button">Clear</button>
      </span>
      <div class="btl__picked" id="btlPicked"></div>
      <div class="btl__find">
        <input id="btlSearch" type="search" placeholder="Search crates" autocomplete="off" maxlength="40" aria-label="Search crates" />
        <select id="btlSort" aria-label="Sort crates">
          <option value="price">Price ↑</option>
          <option value="price-desc">Price ↓</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div class="btl__pool" id="btlPool"></div>
    </div>
    <div class="btl__sum">
      <span><i>Entry per seat</i><b class="mono" id="btlTotal"></b></span>
      <span><i id="btlValueLabel">Battle value</i><b class="mono" id="btlValue"></b></span>
    </div>
    <button class="btn btn--go btl__go" id="btlCreate" type="button">Create battle</button>`;

  const formatChips = $('#btlFormats', panel);
  for (const format of formats) {
    const chip = el('button', 'btl__chip');
    chip.type = 'button';
    chip.textContent = format.label;
    chip.title = format.blurb;
    chip.setAttribute('aria-pressed', String(view.draft.format === format.code));
    chip.addEventListener('click', () => {
      view.draft.format = format.code;
      paintCreator();
    });
    formatChips.appendChild(chip);
  }

  const modeChips = $('#btlModes', panel);
  for (const [code, label] of [['standard', 'Highest wins'], ['crazy', 'Crazy · lowest wins']]) {
    const chip = el('button', 'btl__chip');
    chip.type = 'button';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(view.draft.mode === code));
    chip.addEventListener('click', () => {
      view.draft.mode = code;
      paintCreator();
    });
    modeChips.appendChild(chip);
  }

  const visChips = $('#btlVis', panel);
  for (const [code, label] of [['public', 'Public'], ['private', 'Private link']]) {
    const chip = el('button', 'btl__chip');
    chip.type = 'button';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(view.draft.visibility === code));
    chip.addEventListener('click', () => {
      view.draft.visibility = code;
      paintCreator();
    });
    visChips.appendChild(chip);
  }

  const bots = $('#btlBots', panel);
  bots.setAttribute('role', 'switch');
  bots.setAttribute('aria-checked', String(view.draft.allowBots));
  bots.addEventListener('click', () => {
    view.draft.allowBots = !view.draft.allowBots;
    paintCreator();
  });

  $('#btlClear', panel).addEventListener('click', () => {
    view.draft.caseIds = [];
    paintPicks(panel);
  });

  /* Typing filters the pool in place. Repainting the panel per keystroke would take the focus out
   * of the very box being typed in. */
  const search = $('#btlSearch', panel);
  search.value = view.pool.query;
  search.addEventListener('input', () => {
    view.pool.query = search.value;
    paintPool(panel);
  });
  const sort = $('#btlSort', panel);
  sort.value = view.pool.sort;
  sort.addEventListener('change', () => {
    view.pool.sort = sort.value;
    paintPool(panel);
  });

  $('#btlCreate', panel).addEventListener('click', () => {
    if (!state.authenticated) { $('#loginBtn')?.click(); return; }
    createBattle();
  });

  paintPicks(panel);
}

/** Everything that changes when a crate is added or removed — and nothing that does not. */
function paintPicks(panel) {
  const max = view.modes?.maxRounds ?? 10;
  const picked = view.draft.caseIds;
  const format = (view.modes?.modes ?? []).find((entry) => entry.code === view.draft.format);
  const seats = format ? format.teamCount * format.teamSize : 2;
  const entry = picked.reduce((sum, id) => {
    const crate = state.cases.find((candidate) => candidate.id === id);
    return sum + (crate?.price ?? 0);
  }, 0);

  $('#btlPickCount', panel).textContent = `${picked.length}/${max}`;
  $('#btlClear', panel).hidden = picked.length === 0;
  $('#btlTotal', panel).textContent = money(entry);
  $('#btlValueLabel', panel).textContent = `Value · ${seats} seats`;
  $('#btlValue', panel).textContent = money(entry * seats);

  const pickedRow = $('#btlPicked', panel);
  pickedRow.replaceChildren();
  for (const group of crateGroups(picked.map((id) => ({ caseId: id })))) {
    const crate = state.cases.find((candidate) => candidate.id === group.caseId);
    if (!crate) continue;
    const chip = el('button', 'btl__crate btl__pick');
    chip.type = 'button';
    chip.title = `${crate.name} — click to remove one`;
    const art = document.createElement('img');
    art.src = safeImage(crate.art);
    art.alt = '';
    chip.appendChild(art);
    if (group.count > 1) {
      const count = el('b', 'btlcrate__n mono');
      count.textContent = `×${group.count}`;
      chip.appendChild(count);
    }
    chip.addEventListener('click', () => {
      const at = view.draft.caseIds.lastIndexOf(crate.id);
      if (at >= 0) view.draft.caseIds.splice(at, 1);
      paintPicks(panel);
    });
    pickedRow.appendChild(chip);
  }
  if (!picked.length) {
    const hint = el('p', 'btl__hint');
    hint.textContent = 'Pick up to ten crates below. Every seat opens the same ones, in order.';
    pickedRow.appendChild(hint);
  }

  const create = $('#btlCreate', panel);
  create.disabled = state.authenticated && picked.length < 1;
  create.textContent = !state.authenticated
    ? 'Log in to host'
    : picked.length < 1 ? 'Pick at least one crate' : `Create · ${money(entry)}`;

  paintPool(panel);
}

function paintPool(panel) {
  const pool = $('#btlPool', panel);
  if (!pool) return;
  const max = view.modes?.maxRounds ?? 10;
  const picked = view.draft.caseIds;
  const query = view.pool.query.trim().toLowerCase();
  const crates = state.cases.filter((crate) => !query || crate.name.toLowerCase().includes(query));
  crates.sort((a, b) => (
    view.pool.sort === 'name' ? a.name.localeCompare(b.name)
      : view.pool.sort === 'price-desc' ? b.price - a.price
        : a.price - b.price
  ));

  /* Rebuilt in place with its scroll kept, so picking a crate far down the list does not throw
   * the player back to the top of it. */
  const top = pool.scrollTop;
  pool.replaceChildren();
  for (const crate of crates) {
    const chip = el('button', 'btl__crate btl__crate--pool');
    chip.type = 'button';
    chip.title = `${crate.name} · ${money(crate.price)}`;
    chip.disabled = picked.length >= max;
    const count = picked.filter((id) => id === crate.id).length;
    if (count) chip.dataset.picked = '1';
    const art = document.createElement('img');
    art.src = safeImage(crate.art);
    art.alt = '';
    art.loading = 'lazy';
    const price = el('span', 'btl__cratecost mono');
    price.textContent = money(crate.price);
    chip.append(art, price);
    /* Picked once is the gold border; a count is only worth a badge from two up. */
    if (count > 1) {
      const badge = el('b', 'btlcrate__n mono');
      badge.textContent = `×${count}`;
      chip.appendChild(badge);
    }
    chip.addEventListener('click', () => {
      if (view.draft.caseIds.length >= max) return;
      view.draft.caseIds.push(crate.id);
      playSound('click');
      paintPicks(panel);
    });
    pool.appendChild(chip);
  }
  if (!crates.length) {
    const none = el('p', 'btl__hint');
    none.textContent = state.cases.length ? 'No crate matches that search.' : 'Loading crates…';
    pool.appendChild(none);
  }
  pool.scrollTop = top;
}

function paintArena() {
  const battle = view.battle;
  /* Not `battle.status === 'settled'`. See the clock section above: the server settles before the
   * spin, so the status is true several seconds before the player is meant to know anything. */
  const revealed = isRevealed(battle);

  root.innerHTML = `
    <div class="arena barena">
      <header class="arena__head">
        <button class="btn arena__back" id="arenaBack" type="button">← Lobby</button>
        <div class="arena__title">
          <h2><span class="btlcard__fmt" id="arenaFmt"></span><span class="arena__mode" id="arenaMode"></span></h2>
          <span class="arena__code mono" id="arenaCode"></span>
        </div>
        <div class="arena__stats">
          <span class="arena__stat"><i id="arenaValueLabel"></i><b class="mono" id="arenaValue"></b></span>
          <span class="arena__stat"><i>Round</i><b class="mono" id="arenaRound">–</b></span>
        </div>
        <div class="arena__tools">
          <button class="btn arena__copy" id="arenaCopy" type="button">Copy invite</button>
          <button class="btn arena__fast" id="arenaFast" type="button" role="switch">Fast roll</button>
        </div>
      </header>
      <div class="arena__strip" id="arenaStrip"></div>
      <div class="arena__result" id="arenaResult" hidden></div>
      <div class="arena__board" id="arenaBoard"></div>
      <details class="bfair" id="arenaFair" hidden></details>
    </div>`;

  const arena = root.querySelector('.arena');
  arena.dataset.phase = battle.status === 'lobby' ? 'lobby' : 'run';
  arena.dataset.seats = String(battle.seats.length);
  arena.dataset.mode = battle.mode;

  $('#arenaFmt', root).textContent = formatLabel(battle);
  $('#arenaMode', root).textContent = battle.mode === 'crazy' ? 'Crazy · lowest wins' : 'Highest wins';
  $('#arenaCode', root).textContent = battle.code;
  /* The pot is the sum of every drop, so it is the answer: it stays hidden behind the battle's
   * value until the last reel stops, like everything else the result touches. */
  $('#arenaValueLabel', root).textContent = revealed ? 'Pot' : 'Battle value';
  $('#arenaValue', root).textContent = money(revealed ? Number(battle.potMinor ?? 0) : battleValue(battle));
  if (battle.status === 'lobby') $('#arenaRound', root).textContent = `0/${battle.rounds.length}`;
  $('#arenaBack', root).addEventListener('click', goLobby);

  const copy = $('#arenaCopy', root);
  copy.addEventListener('click', async () => {
    const link = `${location.origin}/battles?code=${encodeURIComponent(battle.code)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast({ kind: 'win', title: 'Invite copied', body: link });
    } catch {
      toast({ kind: 'lose', title: 'Could not copy', body: link });
    }
  });

  const fast = $('#arenaFast', root);
  fast.setAttribute('aria-checked', String(view.fast));
  fast.disabled = !battle.isHost || revealed;
  fast.addEventListener('click', async () => {
    try {
      await api.post(`/v1/battles/${battle.code}/speed`, { fast: !view.fast });
    } catch (error) {
      toast({ kind: 'lose', title: 'Speed not changed', body: error?.message ?? '' });
    }
  });

  // The crate strip, with the active round marked.
  const strip = $('#arenaStrip', root);
  battle.rounds.forEach((round) => {
    const cell = el('div', 'arena__round');
    cell.dataset.index = String(round.index);
    cell.title = round.name;
    const art = document.createElement('img');
    art.src = safeImage(crateArt(round));
    art.alt = '';
    const price = el('span', 'arena__roundprice mono');
    price.textContent = money(Number(round.priceMinor));
    cell.append(art, price);
    strip.appendChild(cell);
  });

  /* Team by team, split by "vs". A 2v2 is two boxed pairs with a combined total each; a free-for-all
   * is every player in their own lane. Seats are laid out team-major by the server, so a seat's
   * index alone says which team it sits in. */
  const board = $('#arenaBoard', root);
  board.dataset.seats = String(battle.seatCount);
  board.dataset.teams = String(battle.teamCount);
  for (let team = 0; team < battle.teamCount; team += 1) {
    if (team > 0) board.appendChild(versus());
    const block = el('section', 'bteam');
    block.dataset.team = String(team);
    block.dataset.squad = battle.teamSize > 1 ? '1' : '0';
    if (revealed) block.dataset.won = battle.winningTeam === team ? '1' : '0';
    if (battle.teamSize > 1) {
      const head = el('header', 'bteam__head');
      const name = el('span', 'bteam__name');
      name.textContent = `Team ${team + 1}`;
      const total = el('span', 'bteam__total mono');
      total.dataset.team = String(team);
      total.textContent = money(revealed ? teamTotal(battle, team) : 0);
      head.append(name, total);
      block.appendChild(head);
    }
    for (let offset = 0; offset < battle.teamSize; offset += 1) {
      const index = team * battle.teamSize + offset;
      const seat = battle.seats.find((entry) => entry.seat === index);
      block.appendChild(seat ? buildSeat(battle, seat, revealed) : emptySeat(battle));
    }
    board.appendChild(block);
  }

  if (battle.status === 'lobby') paintWaiting(battle);
  if (revealed) {
    paintResult(battle);
    paintFairness(battle);
  }
  startAnimation();
}

function versus() {
  const vs = el('div', 'bvs');
  vs.textContent = 'VS';
  vs.setAttribute('aria-hidden', 'true');
  return vs;
}

function buildSeat(battle, seat, revealed) {
  const cell = el('div', 'seat');
  cell.dataset.seat = String(seat.seat);
  cell.dataset.team = String(seat.team);
  cell.dataset.you = seat.isYou ? '1' : '0';
  /* The winning TEAM is marked, bots included: when a bot takes the battle that is the result,
   * even though nobody is paid for it. The payout line below is what only humans get. */
  if (revealed) cell.dataset.won = battle.winningTeam === seat.team ? '1' : '0';

  const info = el('div', 'seat__info');
  const avatar = el('span', 'seat__av');
  avatar.dataset.bot = seat.isBot ? '1' : '0';
  avatar.textContent = seat.isBot ? 'BOT' : initials(seat.name);

  const who = el('div', 'seat__who');
  const name = el('span', 'seat__name');
  name.textContent = seat.name;
  const tags = el('span', 'seat__tags');
  if (seat.isYou) tags.appendChild(el('i', 'seat__you', 'YOU'));
  if (seat.isBot) tags.appendChild(el('i', 'seat__bot', 'BOT'));
  const place = el('i', 'seat__team mono');
  place.textContent = battle.teamSize > 1 ? `TEAM ${seat.team + 1}` : `P${seat.seat + 1}`;
  tags.appendChild(place);
  who.append(name, tags);

  const crown = el('span', 'seat__crown', CROWN_SVG);
  crown.setAttribute('aria-hidden', 'true');

  /* The running total starts at zero and is counted up by the animation as each round lands. It
   * used to open on `totalDropMinor` — the settled, final figure — which handed the player the
   * answer while the reels were still spinning. */
  const total = el('div', 'seat__total mono');
  total.dataset.seat = String(seat.seat);
  total.append(coin(), document.createTextNode(
    money(revealed ? Number(seat.totalDropMinor ?? 0) : 0),
  ));

  const won = el('div', 'seat__won mono');
  if (revealed && Number(seat.payoutMinor) > 0) {
    won.textContent = `+${money(Number(seat.payoutMinor))}`;
  }
  info.append(avatar, who, crown, total, won);

  const play = el('div', 'seat__play');
  const reel = el('div', 'seat__reel');
  const track = el('div', 'seat__track');
  track.dataset.seat = String(seat.seat);
  reel.append(track, el('i', 'seat__marker'));
  /* Every drop this seat has landed so far, filled in round by round by the animation. */
  const drops = el('div', 'seat__drops');
  drops.dataset.seat = String(seat.seat);
  play.append(reel, drops);

  cell.append(info, play);
  return cell;
}

function emptySeat(battle) {
  const empty = el('div', 'seat seat--empty');
  const label = el('p', 'seat__waiting');
  label.textContent = 'Waiting for a player…';
  empty.appendChild(label);
  /* Only offered to someone not already at the table — a seated player taking a second seat is a
   * request the server refuses anyway. */
  if (!battle.seats.some((seat) => seat.isYou)) {
    const join = el('button', 'btn btn--go');
    join.type = 'button';
    join.textContent = `Take this seat · ${money(Number(battle.entryCostMinor))}`;
    join.addEventListener('click', () => joinBattle(battle.code, battle.entryCostMinor));
    empty.appendChild(join);
  }
  return empty;
}

/* The banner over the board once the last reel stops: who took it, and for the player who did,
 * how much. A battle a bot won says so — the house keeps that pot and nobody is paid. */
function paintResult(battle) {
  const box = $('#arenaResult', root);
  if (!box || battle.winningTeam === null || battle.winningTeam === undefined) return;
  const mine = battle.seats.find((seat) => seat.isYou);
  const winners = battle.seats.filter((seat) => seat.team === battle.winningTeam);
  const paid = winners.filter((seat) => Number(seat.payoutMinor) > 0);
  const youWon = Boolean(mine && Number(mine.payoutMinor) > 0);

  box.hidden = false;
  box.dataset.state = youWon ? 'won' : mine ? 'lost' : 'neutral';

  const text = el('div', 'arena__resulttext');
  const title = el('strong', 'arena__resulttitle');
  const sub = el('span', 'arena__resultsub');
  const side = battle.teamSize > 1
    ? `Team ${battle.winningTeam + 1}`
    : (winners[0]?.isYou ? 'You' : winners[0]?.name ?? 'A player');
  if (youWon) title.textContent = `You won ${money(Number(mine.payoutMinor))}`;
  else if (!paid.length) title.textContent = `${side} wins — the bot takes it`;
  else title.textContent = `${side} ${side === 'You' ? 'win' : 'wins'}`;
  const rule = battle.mode === 'crazy' ? 'lowest' : 'highest';
  sub.textContent = `${money(Number(battle.potMinor ?? 0))} pot · ${rule} total `
    + `${money(teamTotal(battle, battle.winningTeam))}`;
  text.append(title, sub);

  const trophy = el('span', 'arena__trophy', TROPHY_SVG);
  trophy.setAttribute('aria-hidden', 'true');
  box.replaceChildren(trophy, text);

  if (state.authenticated) {
    const again = el('button', 'btn btn--go arena__again');
    again.type = 'button';
    again.textContent = 'Battle again';
    again.title = 'Host a new battle with the same crates and format';
    again.addEventListener('click', () => rematch(battle));
    box.appendChild(again);
  }
}

/* Every input the result was derived from, published with the result. */
function paintFairness(battle) {
  const box = $('#arenaFair', root);
  const fairness = battle.fairness;
  if (!box || !fairness?.serverSeedReveal) return;
  box.hidden = false;
  const summary = el('summary');
  summary.textContent = 'Verify this battle';
  const formula = el('code', 'bfair__formula');
  formula.textContent = fairness.formula ?? '';
  const list = el('dl', 'bfair__list');
  const rows = [
    ['Server seed hash', fairness.serverSeedHash],
    ['Server seed', fairness.serverSeedReveal],
    ['Combined seed', fairness.combinedSeedHash],
    ['Nonce', String(fairness.nonce ?? 0)],
    ...battle.seats.map((seat) => [`Seat ${seat.seat + 1} seed`, seat.clientSeed]),
  ];
  for (const [label, value] of rows) {
    const term = el('dt');
    term.textContent = label;
    const detail = el('dd');
    detail.textContent = value ?? '—';
    list.append(term, detail);
  }
  box.replaceChildren(summary, formula, list);
}

/* "Battle again": the same crates, format and rules, back in the host panel. Nothing is staked
 * until the player presses Create, so this is a shortcut and never a second wager. */
function rematch(battle) {
  const format = (view.modes?.modes ?? []).find((entry) => (
    entry.teamCount === battle.teamCount && entry.teamSize === battle.teamSize
  ));
  view.draft = {
    format: format?.code ?? '1v1',
    mode: battle.mode,
    visibility: battle.visibility === 'private' ? 'private' : 'public',
    allowBots: Boolean(battle.allowBots),
    caseIds: battle.rounds.map((round) => round.caseId).slice(0, view.modes?.maxRounds ?? 10),
  };
  goLobby();
}

function paintWaiting(battle) {
  const board = $('#arenaBoard', root);
  if (!board) return;
  const bar = el('div', 'arena__waiting');
  const text = el('span');
  text.textContent = `${battle.seats.length} of ${battle.seatCount} seats taken`;
  bar.appendChild(text);

  if (battle.isHost && battle.allowBots && battle.seats.length < battle.seatCount) {
    const fill = el('button', 'btn btn--go');
    fill.type = 'button';
    fill.textContent = 'Start with bots';
    fill.addEventListener('click', async () => {
      try {
        await api.post(`/v1/battles/${battle.code}/bots`, {});
      } catch (error) {
        toast({ kind: 'lose', title: 'Could not start', body: error?.message ?? '' });
      }
    });
    bar.appendChild(fill);
  }
  const leave = el('button', 'btn');
  leave.type = 'button';
  leave.textContent = battle.isHost ? 'Cancel lobby' : 'Leave';
  leave.addEventListener('click', async () => {
    try {
      await api.post(`/v1/battles/${battle.code}/leave`, {});
      goLobby();
    } catch (error) {
      toast({ kind: 'lose', title: 'Could not leave', body: error?.message ?? '' });
    }
  });
  bar.appendChild(leave);
  board.parentElement?.insertBefore(bar, board);
}

/* ─────────────────────────── the animation ───────────────────────────
 *
 * One rAF loop drives every reel on the table. Each frame recomputes the position from the shared
 * clock rather than advancing a per-reel counter, so a dropped frame or a backgrounded tab cannot
 * leave one seat behind the others — the next frame simply lands where the clock says it should.
 */
function startAnimation() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;

  const battle = view.battle;
  if (!battle) return;

  const tracks = [...root.querySelectorAll('.seat__track')];
  if (!tracks.length) return;

  /* A lobby still filling has no results at all, so its reels can safely show the first crate's
   * contents at rest — a seated player sees what they are about to open instead of an empty bar. */
  if (battle.status === 'lobby') {
    dress(tracks, new Map(), battle, 0);
    for (const track of tracks) settle(track, 0);
    return;
  }

  const byRound = new Map();
  for (const result of battle.results ?? []) {
    if (!byRound.has(result.round)) byRound.set(result.round, new Map());
    byRound.get(result.round).set(result.seat, result);
  }

  const totalRounds = battle.rounds.length;
  const schedule = scheduleFor(battle);

  /* No recoverable clock at all — an archived battle opened cold from a link. Park every reel on
   * its final item instead of leaving a row of empty slots where the spin would have been. */
  if (!schedule) {
    /* Only a SETTLED battle may be parked on its last round. Anything else with no clock is a
     * battle whose start has not been announced yet, and parking that one on the winner would
     * give away the result that the rest of this file goes to some length to hold back. */
    const parked = battle.status === 'settled';
    const round = parked ? totalRounds - 1 : 0;
    dress(tracks, byRound, battle, round);
    markRound(round);
    for (const track of tracks) settle(track, parked ? 1 : 0);
    paintProgress(battle, parked ? totalRounds : 0, byRound);
    reveal(battle, false);
    return;
  }

  /* Reduced motion keeps the round-by-round pacing — that is information, not decoration — but
   * drops the travel: each reel is simply already on its winner when the round begins. The CSS
   * rule that claimed to handle this targeted a `transition` the track has never had. */
  const calm = reduceMotion();
  let lastRound = -1;
  let lastLanded = -1;
  /* Whether this loop ever rendered a frame that was still running. Opening a link to a battle
   * that ended last week finishes on frame one — that is a replay, and a replay must not fire the
   * jackpot sound and the "you took the pot" toast at someone who is just reading the history. */
  let watched = false;

  const tick = () => {
    const { startsAt, roundMs } = schedule;
    const elapsed = Date.now() - startsAt;
    const finished = elapsed >= roundMs * totalRounds;
    const index = elapsed < 0 ? 0 : Math.min(totalRounds - 1, Math.floor(elapsed / roundMs));

    /* Clamped to 1 when finished, never `elapsed % roundMs`. A battle that ended an hour ago has
     * an arbitrary remainder, which parked the reel at a random offset with an unrelated tile
     * under the marker — a reel has to REST on its winner, that is the whole point of one. */
    const progress = finished ? 1 : elapsed < 0 ? 0 : (elapsed % roundMs) / roundMs;

    if (index !== lastRound) {
      const first = lastRound === -1;
      lastRound = index;
      dress(tracks, byRound, battle, index);
      markRound(index);
      if (!first) playSound('click');
    }

    /* The lead-in holds every reel at the start of the strip, reduced motion included — parking
     * a calm reel on its winner before the battle has begun would give round one away. */
    const eased = elapsed < 0 ? 0 : calm ? 1 : travel(progress);
    for (const track of tracks) settle(track, eased);

    /* The total ticks up the instant a reel lands, not when the next round starts. */
    const landed = finished ? totalRounds : index + (eased >= 1 ? 1 : 0);
    if (landed !== lastLanded) {
      lastLanded = landed;
      paintProgress(battle, landed, byRound);
    }

    if (finished) {
      frame = 0;
      reveal(battle, watched);
      return;
    }
    watched = true;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

/* The spin curve: race → brake → crawl → dwell, and pure in `progress` so the table stays in
 * lockstep. The previous curve was a bare `1 - (1 - p) ** 3` across the whole round, which sheds
 * its speed immediately and then asymptotes — that reads as a number being assigned rather than a
 * wheel stopped by friction, and it left no dwell at all, so the winning tile was replaced at the
 * very instant it arrived. */
function travel(progress) {
  if (progress >= P_LAND) return 1;
  if (progress <= P_RACE) return RACE_END * (progress / P_RACE);
  if (progress <= P_BRAKE) {
    return RACE_END + (BRAKE_END - RACE_END) * BRAKE(span(progress, [P_RACE, P_BRAKE]));
  }
  return BRAKE_END + (1 - BRAKE_END) * CRAWL(span(progress, [P_BRAKE, P_LAND]));
}

function markRound(index) {
  for (const cell of root.querySelectorAll('.arena__round')) {
    const at = Number(cell.dataset.index);
    cell.dataset.active = at === index ? '1' : '0';
    cell.dataset.done = at < index ? '1' : '0';
  }
  const total = view.battle?.rounds?.length ?? 0;
  const label = $('#arenaRound', root);
  if (label && total) label.textContent = `${Math.min(index + 1, total)}/${total}`;
}

function dress(tracks, byRound, battle, roundIndex) {
  for (const track of tracks) {
    const seat = Number(track.dataset.seat);
    buildStrip(track, byRound.get(roundIndex)?.get(seat), battle, roundIndex, seat);
  }
  metrics = null;   // the strip changed; re-measure once, lazily, on the next frame
}

/* The distance that brings the winning tile's CENTRE under the marker.
 *
 * The marker sits at `left: 50%` of the reel. The old constant was `(TILE_COUNT - 4) * 96`, which
 * puts the winning tile's LEFT EDGE at the track origin — so every reel stopped with the winner
 * pinned to the far left and an unrelated tile sitting under the marker. It also hardcoded a 96px
 * stride against an 88px tile and an 8px gap, a coincidence one CSS edit away from breaking.
 * Measured from the DOM instead, once per round rather than once per frame: the grid gives every
 * reel the same width, so a single measurement serves the whole table. */
let metrics = null;
function settle(track, k) {
  if (metrics === null) metrics = measure(track);
  if (metrics === null) return;
  track.style.transform = `translate3d(${-(k * metrics.total)}px, 0, 0)`;
  const reel = track.parentElement;
  if (reel) reel.dataset.landed = k >= 1 ? '1' : '0';
}

function measure(track) {
  const reel = track.parentElement;
  const tile = track.firstElementChild;
  if (!reel || !tile) return null;
  const style = getComputedStyle(track);
  const tileWidth = tile.getBoundingClientRect().width;
  const reelWidth = reel.getBoundingClientRect().width;
  if (!tileWidth || !reelWidth) return null;
  const gap = parseFloat(style.columnGap) || 0;
  const pad = parseFloat(style.paddingLeft) || 0;
  return { total: pad + WIN_AT * (tileWidth + gap) + tileWidth / 2 - reelWidth / 2 };
}

/* A reel is only as wide as its grid column, so a resize invalidates the measurement. */
window.addEventListener('resize', () => { metrics = null; }, { passive: true });

/* The strip for one seat in one round.
 *
 * Two things were wrong here. The WINNING tile was drawn straight from the API payload, whose
 * `imageUrl` is null for almost every catalogue item because the sprite is resolved client-side
 * from the Minecraft name — and `safeImage(null)` is a blank pixel, so the one tile that mattered
 * was the one tile with no picture on it. It now goes through the same normaliser as every other
 * item on the site. And the fillers were drawn with Math.random(), so every rebuild reshuffled the
 * whole strip in front of the player; they are now drawn from a seed fixed by battle, seat and
 * round, so a rebuild reproduces the strip exactly. */
function buildStrip(track, result, battle, roundIndex, seat) {
  track.innerHTML = '';
  const round = battle.rounds[roundIndex];
  const pool = state.cases.find((entry) => entry.id === round?.caseId)?.drops ?? [];
  const winner = result?.item ? normalizeItem(result.item) : null;

  /* The catalogue has not landed yet, or this crate is community-made and outside the public
   * list. Rather than draw thirty blank tiles, fall back to the one item we are certain of. */
  const fillers = pool.length ? pool : winner ? [winner] : [];
  if (!pool.length && !state.cases.length) refreshCases().catch(() => undefined);

  const random = seeded(`${battle.code}:${seat}:${roundIndex}`);
  for (let index = 0; index < TILE_COUNT; index += 1) {
    const winning = index === WIN_AT;
    track.appendChild(buildTile(
      winning ? winner : weightedPick(fillers, random),
      winning,
      winning ? result : null,
    ));
  }
}

function buildTile(item, winning, result) {
  const tile = el('div', 'seat__tile');
  /* `winner`, not the old `win`: that attribute lit the tile gold the moment the strip was built,
   * so the drop could be read off the reel while it was still racing. battles.css lights this one
   * only once its reel reports landed, and hides the value until then. */
  if (winning) tile.dataset.winner = '1';
  if (item?.rarity) tile.dataset.rarity = item.rarity;

  const art = document.createElement('img');
  /* `img` first: the normaliser already prefers the server URL there and falls back to the local
   * sprite, whereas `imageUrl` is the raw, usually-null field. The old order had it backwards. */
  art.src = safeImage(item?.img ?? item?.imageUrl ?? '');
  art.alt = '';
  art.loading = 'lazy';
  tile.appendChild(art);

  /* Naming the drop is what makes a reel readable at all — a 40px sprite flying past is a shape,
   * not an item. Written with textContent, like every other server string in this file. */
  const name = el('span', 'seat__tilename');
  name.textContent = item?.displayName ?? item?.name ?? '';
  tile.appendChild(name);

  if (winning && result) {
    const value = el('span', 'seat__tileval mono');
    value.textContent = money(Number(result.payoutMinor));
    tile.appendChild(value);
  }
  return tile;
}

/* A strip has to be reproducible: the same battle, seat and round must always draw the same
 * fillers, or any rebuild reshuffles the reel in front of the player. FNV-1a into xorshift32 is
 * ample — this decides nothing but which sprites fly past, and the outcome they sit next to was
 * committed server-side long before any of this ran. */
function seeded(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  let seed = hash >>> 0 || 1;
  return () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
}

/* Fillers follow the crate's real weights. A uniform draw put the legendaries on the reel as often
 * as the junk, so every crate looked identical while it spun — and made the odds look far better
 * than they are, which is the kind of lie this codebase goes out of its way not to tell. */
function weightedPick(items, random) {
  if (!items.length) return null;
  let total = 0;
  for (const item of items) total += Math.max(1, Number(item.weight) || 1);
  let roll = random() * total;
  for (const item of items) {
    roll -= Math.max(1, Number(item.weight) || 1);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/* Everything that moves as a round lands: each seat's running total and its row of drops, each
 * team's combined total, and the crown over whoever is ahead. Summed only over the rounds that have
 * actually landed, so none of it can run ahead of the reels. */
function paintProgress(battle, landedRounds, byRound) {
  const seatTotals = new Map();
  for (const seat of battle.seats) {
    let total = 0n;
    const drops = root.querySelector(`.seat__drops[data-seat="${seat.seat}"]`);
    for (let index = 0; index < landedRounds; index += 1) {
      const result = byRound.get(index)?.get(seat.seat);
      if (!result) continue;
      total += BigInt(result.payoutMinor ?? 0);
      if (drops && !drops.querySelector(`[data-round="${index}"]`)) {
        drops.appendChild(dropChip(result, index));
      }
    }
    /* A fast-roll toggle re-anchors the clock, which can move the landed count backwards. */
    for (const chip of drops?.querySelectorAll('[data-round]') ?? []) {
      if (Number(chip.dataset.round) >= landedRounds) chip.remove();
    }
    seatTotals.set(seat.seat, total);
    const node = root.querySelector(`.seat__total[data-seat="${seat.seat}"]`);
    if (node) node.replaceChildren(coin(), document.createTextNode(money(Number(total))));
  }

  const teamTotals = new Map();
  for (const seat of battle.seats) {
    teamTotals.set(seat.team, (teamTotals.get(seat.team) ?? 0n) + (seatTotals.get(seat.seat) ?? 0n));
  }
  for (const node of root.querySelectorAll('.bteam__total')) {
    node.textContent = money(Number(teamTotals.get(Number(node.dataset.team)) ?? 0n));
  }

  /* The leader under the battle's own rule — lowest in crazy mode. Nobody leads before a round has
   * landed, nor when every team is level, and the crown hands over to the result once revealed. */
  let leaders = new Set();
  if (landedRounds > 0 && !isRevealed(battle) && teamTotals.size > 1) {
    const values = [...teamTotals.values()];
    const best = values.reduce((pick, value) => (
      battle.mode === 'crazy' ? (value < pick ? value : pick) : (value > pick ? value : pick)
    ));
    leaders = new Set([...teamTotals].filter(([, value]) => value === best).map(([team]) => team));
    if (leaders.size === teamTotals.size) leaders = new Set();
  }
  for (const cell of root.querySelectorAll('.seat[data-seat]')) {
    cell.dataset.lead = leaders.has(Number(cell.dataset.team)) ? '1' : '0';
  }
}

function dropChip(result, round) {
  const item = result.item ? normalizeItem(result.item) : null;
  const chip = el('span', 'seat__drop');
  chip.dataset.round = String(round);
  if (item?.rarity) chip.dataset.rarity = item.rarity;
  chip.title = `${item?.displayName ?? ''} · ${money(Number(result.payoutMinor))}`;
  const art = document.createElement('img');
  art.src = safeImage(item?.img ?? item?.imageUrl ?? '');
  art.alt = '';
  const value = el('b', 'mono');
  value.textContent = money(Number(result.payoutMinor));
  chip.append(art, value);
  return chip;
}

/* The moment the last reel stops. The arena repaints with the result it has been holding back —
 * payouts, the winning seat, the revealed seeds — and only then does the toast fire.
 *
 * Guarded by code, because that repaint calls startAnimation() again and a finished battle reaches
 * this line on its very first frame: without the guard it is a 60fps repaint loop. */
let announced = null;
function reveal(battle, watched) {
  if (battle.status !== 'settled' || announced === battle.code) return;
  announced = battle.code;
  paintArena();
  /* Released before the replay check: a battle that finished while the tab was hidden reaches
   * here on its first frame, and still has to hand the wallet back. */
  const held = releaseBattleHold();
  if (!watched) return;   // a replay, not a result

  const mine = battle.seats.find((seat) => seat.isYou);
  const won = mine && Number(mine.payoutMinor) > 0;
  if (won) confetti();
  playSound(won ? 'jackpot' : 'lose');
  toast({
    kind: won ? 'win' : 'lose',
    title: won ? 'You took the pot' : 'Battle over',
    body: won
      ? `+${money(Number(mine.payoutMinor))} from a ${money(Number(battle.potMinor))} pot`
      : `Team ${battle.winningTeam + 1} took ${money(Number(battle.potMinor))}`,
  });
  if (!held) refreshBalance().catch(() => undefined);
}

/* ─────────────────────────── actions ─────────────────────────── */

function toastPaused() {
  toast({
    kind: 'lose',
    title: 'Battles paused',
    body: 'Case Battles are closed for now. Open lobbies are refunded.',
  });
}

async function createBattle() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (battlesPaused()) return toastPaused();
  try {
    const result = await api.post('/v1/battles', {
      format: view.draft.format,
      mode: view.draft.mode,
      visibility: view.draft.visibility,
      allowBots: view.draft.allowBots,
      caseIds: view.draft.caseIds,
      clientSeed: randomSeed(),
    });
    view.draft.caseIds = [];
    playSound('coin');
    await refreshBalance().catch(() => undefined);
    navigate(`/battles?code=${encodeURIComponent(result.battle.code)}`);
  } catch (error) {
    toast({
      kind: 'lose',
      title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not host',
      body: error?.message ?? '',
    });
  }
}

async function joinBattle(code, entryCostMinor) {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (battlesPaused()) return toastPaused();
  /* Taken before the request: taking the last seat settles the battle inside this very call, and
   * the server's balance event can arrive ahead of its HTTP answer. Only the stake is shown leaving
   * the wallet; whatever the battle pays waits for the reels. */
  const before = BigInt(state.balanceMinor || '0');
  holdForBattle({ seats: [{ isYou: true }] });
  try {
    await api.post(`/v1/battles/${encodeURIComponent(code)}/join`, { clientSeed: randomSeed() });
    playSound('coin');
    if (entryCostMinor !== undefined) showBalance(before - BigInt(entryCostMinor));
    navigate(`/battles?code=${encodeURIComponent(code)}`);
  } catch (error) {
    releaseBattleHold();
    toast({
      kind: 'lose',
      title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not join',
      body: error?.message ?? '',
    });
  }
}

/* ─────────────────────────── bits ─────────────────────────── */

/** The player's entropy for the combined seed. Real randomness, never a timestamp. */
function randomSeed() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* 1v1, 1v1v1, 2v2, 2v2v2 — the same names the host panel offers. Team formats used to print as
 * "2x2", so the lobby card and the chip that created it disagreed about what the battle was. */
function formatLabel(battle) {
  return Array.from({ length: battle.teamCount }, () => String(battle.teamSize)).join('v');
}

/* A round's crate art: the catalogue's own entry first, so a battle shows exactly the picture the
 * crate list does, then the crate's decal under the same rules the catalogue applies to it. */
function crateArt(round) {
  const known = state.cases.find((entry) => entry.id === round?.caseId);
  if (known?.art) return known.art;
  const asset = round?.metadata?.frontendAsset;
  if (typeof asset === 'string'
    && /^(?:(?:items|block)\/)?[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/.test(asset)) {
    return `assets/img/${asset.includes('/') ? asset : `block/${asset}`}`;
  }
  return round?.imageUrl || 'assets/img/items/chest.png';
}

/* What every seat's crates are worth together, before anything is opened. The pot — the sum of
 * what was actually pulled — is only shown once the result is. */
function battleValue(battle) {
  return Number(battle.entryCostMinor ?? 0) * Number(battle.seatCount ?? 0);
}

function teamTotal(battle, team) {
  return battle.seats
    .filter((seat) => seat.team === team)
    .reduce((sum, seat) => sum + Number(seat.totalDropMinor ?? 0), 0);
}

/* Names arrive masked ("D*******"), so this is usually one letter, which is all a chip needs. */
function initials(name) {
  const letters = String(name ?? '').replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

function timeAgo(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/* A short burst over the result banner for the player who took the pot. Decoration only, and
 * skipped entirely under reduced motion. */
function confetti() {
  if (reduceMotion()) return;
  const host = $('#arenaResult', root);
  if (!host) return;
  const layer = el('div', 'bconfetti');
  layer.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 32; index += 1) {
    const bit = el('i');
    bit.dataset.c = String(index % 4);
    bit.style.setProperty('--x', `${Math.round((Math.random() * 2 - 1) * 280)}px`);
    bit.style.setProperty('--y', `${Math.round(-60 - Math.random() * 140)}px`);
    bit.style.setProperty('--r', `${Math.round(Math.random() * 900 - 450)}deg`);
    bit.style.setProperty('--d', `${(Math.random() * 0.18).toFixed(2)}s`);
    layer.appendChild(bit);
  }
  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 2_600);
}

const CROWN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8.5l4.5 3.5L12 5l4.5 7L21 8.5 19 18H5L3 8.5z"/><rect x="5" y="19.2" width="14" height="1.8" rx=".9"/></svg>';
const TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M16 5h3a3 3 0 0 1-3 4M8 5H5a3 3 0 0 0 3 4"/><path d="M12 13v4M8.5 20h7M10 17h4v3h-4z"/></svg>';

function coin() {
  const mark = el('i', 'coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

void grouped;
