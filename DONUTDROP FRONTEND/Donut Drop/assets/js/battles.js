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
import { state, bus, refreshBalance, refreshCases, normalizeItem } from './store.js';
import { $, el, money, safeImage, grouped, reduceMotion } from './util.js';
import { bezier, span } from './fx.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { navigate } from './routing.js';

const TILE_COUNT = 32;
const WIN_AT = 26;                 // the winner, with six tiles of runway left behind it
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
  modes: null,
  draft: { format: '1v1', mode: 'standard', visibility: 'public', allowBots: false, caseIds: [] },
  schedule: null,
  fast: false,
};

let root = null;
let socket = null;
let reconnectTimer = 0;
let frame = 0;

export function mountBattles(node) {
  root = $('#battleRoot', node);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    connect();
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) paint();
    });
    if (!state.cases.length) refreshCases().catch(() => undefined);
    api.get('/v1/battles/modes').then((modes) => {
      view.modes = modes;
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
  }
  paint();
}

export function stopBattles() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
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
      if (view.screen === 'lobby') refreshLobbies();
      if (view.code && message.battle?.code === view.code) applyBattle(message.battle);
      break;
    case 'lobby:removed':
      if (view.screen === 'lobby') refreshLobbies();
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

async function refreshLobbies() {
  try {
    const result = await api.get('/v1/battles?status=lobby&limit=24');
    view.lobbies = result.battles ?? [];
    if (view.screen === 'lobby') paint();
  } catch { /* the list is ambient; a failure leaves the last one on screen */ }
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
  root.innerHTML = `
    <div class="btl">
      <aside class="btl__make" id="btlMake"></aside>
      <div class="btl__list">
        <div class="btl__listhead">
          <h2>Open battles</h2>
          <span class="btl__count mono" id="btlCount"></span>
        </div>
        <div class="btl__rows" id="btlRows"></div>
      </div>
    </div>`;
  paintCreator();

  const rows = $('#btlRows', root);
  $('#btlCount', root).textContent = `${view.lobbies.length} waiting`;

  if (!view.lobbies.length) {
    rows.appendChild(el('p', 'empty', 'No open battles. Host one and the lobby appears here.'));
    return;
  }

  for (const lobby of view.lobbies) {
    const card = el('div', 'btlcard');
    card.dataset.mode = lobby.mode;

    const head = el('div', 'btlcard__head');
    const fmt = el('span', 'btlcard__fmt');
    fmt.textContent = formatLabel(lobby);
    const crazy = el('span', 'btlcard__crazy');
    crazy.textContent = lobby.mode === 'crazy' ? 'CRAZY · lowest wins' : 'Highest wins';
    head.append(fmt, crazy);

    const crates = el('div', 'btlcard__crates');
    for (const round of lobby.rounds.slice(0, 10)) {
      const art = document.createElement('img');
      art.src = safeImage(crateArt(round));
      art.alt = '';
      art.title = round.name;
      art.loading = 'lazy';
      crates.appendChild(art);
    }

    const seats = el('div', 'btlcard__seats');
    for (let index = 0; index < lobby.seatCount; index += 1) {
      const occupant = lobby.seats.find((entry) => entry.seat === index);
      const pip = el('i', 'btlcard__pip');
      pip.dataset.filled = occupant ? '1' : '0';
      if (occupant) pip.title = occupant.name;
      seats.appendChild(pip);
    }

    const foot = el('div', 'btlcard__foot');
    const cost = el('span', 'btlcard__cost mono');
    cost.append(coin(), document.createTextNode(money(Number(lobby.entryCostMinor))));
    const host = el('span', 'btlcard__host');
    host.textContent = `by ${lobby.host}`;
    const join = el('button', 'btn btn--go btlcard__join');
    join.type = 'button';
    join.textContent = lobby.seats.length >= lobby.seatCount ? 'Watch' : 'Join';
    join.addEventListener('click', () => {
      if (lobby.seats.length >= lobby.seatCount) openBattle(lobby.code);
      else joinBattle(lobby.code);
    });
    foot.append(cost, host, join);

    card.append(head, crates, seats, foot);
    rows.appendChild(card);
  }
}

function paintCreator() {
  const panel = $('#btlMake', root);
  if (!panel) return;

  const formats = view.modes?.modes ?? [];
  const picked = view.draft.caseIds;
  const total = picked.reduce((sum, id) => {
    const crate = state.cases.find((entry) => entry.id === id);
    return sum + (crate?.price ?? 0);
  }, 0);

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
      <span class="btl__label">Crates <b id="btlPickCount"></b></span>
      <div class="btl__picked" id="btlPicked"></div>
      <div class="btl__pool" id="btlPool"></div>
    </div>
    <div class="btl__cost">
      <span class="btl__label">Entry per seat</span>
      <b class="mono" id="btlTotal"></b>
    </div>
    <button class="btn btn--go btl__go" id="btlCreate">Create battle</button>`;

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

  const max = view.modes?.maxRounds ?? 10;
  $('#btlPickCount', panel).textContent = `${picked.length}/${max}`;
  $('#btlTotal', panel).textContent = money(total);

  const pickedRow = $('#btlPicked', panel);
  picked.forEach((id, index) => {
    const crate = state.cases.find((entry) => entry.id === id);
    if (!crate) return;
    const chip = el('button', 'btl__crate');
    chip.type = 'button';
    chip.title = `${crate.name} — click to remove`;
    const art = document.createElement('img');
    art.src = safeImage(crate.art);
    art.alt = '';
    chip.appendChild(art);
    chip.addEventListener('click', () => {
      view.draft.caseIds.splice(index, 1);
      paintCreator();
    });
    pickedRow.appendChild(chip);
  });

  const pool = $('#btlPool', panel);
  for (const crate of [...state.cases].sort((a, b) => a.price - b.price).slice(0, 24)) {
    const chip = el('button', 'btl__crate btl__crate--pool');
    chip.type = 'button';
    chip.title = `${crate.name} · ${money(crate.price)}`;
    chip.disabled = picked.length >= max;
    const art = document.createElement('img');
    art.src = safeImage(crate.art);
    art.alt = '';
    const price = el('span', 'btl__cratecost mono');
    price.textContent = money(crate.price);
    chip.append(art, price);
    chip.addEventListener('click', () => {
      if (view.draft.caseIds.length >= max) return;
      view.draft.caseIds.push(crate.id);
      playSound('click');
      paintCreator();
    });
    pool.appendChild(chip);
  }

  const create = $('#btlCreate', panel);
  create.disabled = picked.length < 1 || !state.authenticated;
  create.textContent = !state.authenticated
    ? 'Log in to host'
    : picked.length < 1 ? 'Pick at least one crate' : `Create · ${money(total)}`;
  create.addEventListener('click', createBattle);
}

function paintArena() {
  const battle = view.battle;
  /* Not `battle.status === 'settled'`. See the clock section above: the server settles before the
   * spin, so the status is true several seconds before the player is meant to know anything. */
  const revealed = isRevealed(battle);

  root.innerHTML = `
    <div class="arena">
      <header class="arena__head">
        <button class="btn arena__back" id="arenaBack" type="button">← Lobby</button>
        <div class="arena__title">
          <h2 id="arenaFmt"></h2>
          <span class="arena__code mono" id="arenaCode"></span>
        </div>
        <div class="arena__tools">
          <button class="btn arena__copy" id="arenaCopy" type="button">Copy invite</button>
          <button class="btn arena__fast" id="arenaFast" type="button" role="switch">Fast roll</button>
        </div>
      </header>
      <div class="arena__strip" id="arenaStrip"></div>
      <div class="arena__board" id="arenaBoard"></div>
      <div class="arena__fair" id="arenaFair"></div>
    </div>`;

  const arena = root.querySelector('.arena');
  arena.dataset.phase = battle.status === 'lobby' ? 'lobby' : 'run';
  arena.dataset.seats = String(battle.seats.length);

  $('#arenaFmt', root).textContent =
    `${formatLabel(battle)} · ${battle.mode === 'crazy' ? 'Crazy — lowest wins' : 'Highest wins'}`;
  $('#arenaCode', root).textContent = battle.code;
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
    const art = document.createElement('img');
    art.src = safeImage(crateArt(round));
    art.alt = '';
    art.title = round.name;
    cell.appendChild(art);
    strip.appendChild(cell);
  });

  const board = $('#arenaBoard', root);
  board.dataset.seats = String(battle.seatCount);
  for (const seat of battle.seats) {
    board.appendChild(buildSeat(battle, seat, revealed));
  }
  for (let index = battle.seats.length; index < battle.seatCount; index += 1) {
    const empty = el('div', 'seat seat--empty');
    const label = el('p', 'seat__waiting');
    label.textContent = 'Waiting for a player…';
    const join = el('button', 'btn btn--go');
    join.type = 'button';
    join.textContent = 'Take this seat';
    join.addEventListener('click', () => joinBattle(battle.code));
    empty.append(label, join);
    board.appendChild(empty);
  }

  paintFairness(battle, revealed);
  if (battle.status === 'lobby') paintWaiting(battle);
  startAnimation();
}

function buildSeat(battle, seat, revealed) {
  const cell = el('div', 'seat');
  cell.dataset.seat = String(seat.seat);
  cell.dataset.team = String(seat.team);
  cell.dataset.you = seat.isYou ? '1' : '0';
  if (revealed) {
    cell.dataset.won = battle.winningTeam === seat.team && Number(seat.payoutMinor) > 0 ? '1' : '0';
  }

  const head = el('div', 'seat__head');
  const name = el('span', 'seat__name');
  name.textContent = seat.name;
  const team = el('span', 'seat__team mono');
  team.textContent = battle.teamSize > 1 ? `TEAM ${seat.team + 1}` : `P${seat.seat + 1}`;
  head.append(name, team);
  if (seat.isBot) {
    const bot = el('span', 'seat__bot');
    bot.textContent = 'BOT';
    head.appendChild(bot);
  }

  const reel = el('div', 'seat__reel');
  const track = el('div', 'seat__track');
  track.dataset.seat = String(seat.seat);
  reel.append(track, el('i', 'seat__marker'));

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

  cell.append(head, reel, total, won);
  return cell;
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

/* The seed reveal is part of the result, so it waits for the result. The revealed seed is in the
 * payload either way — this is presentation, not secrecy — but printing it beside a reel that is
 * still turning tells the player the battle is already over. */
function paintFairness(battle, revealed) {
  const panel = $('#arenaFair', root);
  if (!panel) return;

  const rows = [
    ['Server seed hash', battle.fairness.serverSeedHash],
    ['Nonce', String(battle.fairness.nonce)],
  ];
  if (revealed) {
    rows.push(['Server seed', battle.fairness.serverSeedReveal]);
    rows.push(['Combined seed', battle.fairness.combinedSeedHash]);
    for (const seat of battle.seats) rows.push([`Client seed · ${seat.name}`, seat.clientSeed]);
  }

  const head = el('h3', 'arena__fairhead');
  head.textContent = revealed ? 'Verify this battle' : 'Committed before anyone joined';
  panel.appendChild(head);

  const note = el('p', 'arena__fairnote');
  note.textContent = revealed
    ? battle.fairness.formula
    : 'The server seed hash is published now and the seed itself is revealed when the battle ends.';
  panel.appendChild(note);

  const list = el('dl', 'arena__fairlist');
  for (const [label, value] of rows) {
    if (!value) continue;
    const term = el('dt');
    term.textContent = label;
    const detail = el('dd', 'mono');
    detail.textContent = value;
    list.append(term, detail);
  }
  panel.appendChild(list);
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
  if (!battle || battle.status === 'lobby') return;

  const tracks = [...root.querySelectorAll('.seat__track')];
  if (!tracks.length) return;

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
    paintTotals(battle, parked ? totalRounds : 0, byRound);
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
      paintTotals(battle, landed, byRound);
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
    cell.dataset.active = Number(cell.dataset.index) === index ? '1' : '0';
  }
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
  if (winning) tile.dataset.win = '1';
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

/* The running total, summed over the rounds that have actually landed. */
function paintTotals(battle, landedRounds, byRound) {
  for (const seat of battle.seats) {
    const node = root.querySelector(`.seat__total[data-seat="${seat.seat}"]`);
    if (!node) continue;
    let total = 0n;
    for (let index = 0; index < landedRounds; index += 1) {
      const result = byRound.get(index)?.get(seat.seat);
      if (result) total += BigInt(result.payoutMinor ?? 0);
    }
    node.innerHTML = '';
    node.append(coin(), document.createTextNode(money(Number(total))));
  }
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
  if (!watched) return;   // a replay, not a result

  const mine = battle.seats.find((seat) => seat.isYou);
  const won = mine && Number(mine.payoutMinor) > 0;
  playSound(won ? 'jackpot' : 'lose');
  toast({
    kind: won ? 'win' : 'lose',
    title: won ? 'You took the pot' : 'Battle over',
    body: won
      ? `+${money(Number(mine.payoutMinor))} from a ${money(Number(battle.potMinor))} pot`
      : `Team ${battle.winningTeam + 1} took ${money(Number(battle.potMinor))}`,
  });
  refreshBalance().catch(() => undefined);
}

/* ─────────────────────────── actions ─────────────────────────── */

async function createBattle() {
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Hosting a battle stakes real balance.' });
    return;
  }
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

async function joinBattle(code) {
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Joining a battle stakes real balance.' });
    return;
  }
  try {
    await api.post(`/v1/battles/${encodeURIComponent(code)}/join`, { clientSeed: randomSeed() });
    playSound('coin');
    await refreshBalance().catch(() => undefined);
    navigate(`/battles?code=${encodeURIComponent(code)}`);
  } catch (error) {
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

function formatLabel(battle) {
  return battle.teamSize > 1
    ? `${battle.teamCount}x${battle.teamSize}`
    : Array.from({ length: battle.teamCount }, () => '1').join('v');
}

function crateArt(round) {
  const asset = round?.metadata?.frontendAsset;
  if (typeof asset === 'string' && /^(?:items|block)\/[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/.test(asset)) {
    return `assets/img/${asset}`;
  }
  return round?.imageUrl || 'assets/img/items/chest.png';
}

function coin() {
  const mark = el('i', 'coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

void grouped;
