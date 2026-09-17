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
import { state, bus, refreshBalance, refreshCases } from './store.js';
import { $, el, money, safeImage, grouped } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const TILE_COUNT = 24;
const RECONNECT_MS = 2_000;

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

  // A code in the hash opens that battle directly — this is the private invite link.
  const hash = location.hash.split('/')[2];
  if (hash && /^[A-Z0-9]{6,12}$/.test(hash)) openBattle(hash);
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
  location.hash = '#/battles';
  refreshLobbies();
  paint();
}

/* ─────────────────────────── painting ─────────────────────────── */

function paint() {
  if (!root?.isConnected) return;
  if (view.screen === 'arena' && view.battle) paintArena();
  else paintLobby();
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
  const settled = battle.status === 'settled';

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

  $('#arenaFmt', root).textContent =
    `${formatLabel(battle)} · ${battle.mode === 'crazy' ? 'Crazy — lowest wins' : 'Highest wins'}`;
  $('#arenaCode', root).textContent = battle.code;
  $('#arenaBack', root).addEventListener('click', goLobby);

  const copy = $('#arenaCopy', root);
  copy.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#/battles/${battle.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast({ kind: 'win', title: 'Invite copied', body: link });
    } catch {
      toast({ kind: 'lose', title: 'Could not copy', body: link });
    }
  });

  const fast = $('#arenaFast', root);
  fast.setAttribute('aria-checked', String(view.fast));
  fast.disabled = !battle.isHost || settled;
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
    board.appendChild(buildSeat(battle, seat, settled));
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

  paintFairness(battle, settled);
  if (!settled && battle.status === 'lobby') paintWaiting(battle);
  startAnimation();
}

function buildSeat(battle, seat, settled) {
  const cell = el('div', 'seat');
  cell.dataset.seat = String(seat.seat);
  cell.dataset.team = String(seat.team);
  cell.dataset.you = seat.isYou ? '1' : '0';
  if (settled) {
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

  const total = el('div', 'seat__total mono');
  total.dataset.seat = String(seat.seat);
  total.append(coin(), document.createTextNode(money(Number(seat.totalDropMinor ?? 0))));

  const won = el('div', 'seat__won mono');
  if (settled && Number(seat.payoutMinor) > 0) {
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

function paintFairness(battle, settled) {
  const panel = $('#arenaFair', root);
  if (!panel) return;

  const rows = [
    ['Server seed hash', battle.fairness.serverSeedHash],
    ['Nonce', String(battle.fairness.nonce)],
  ];
  if (settled) {
    rows.push(['Server seed', battle.fairness.serverSeedReveal]);
    rows.push(['Combined seed', battle.fairness.combinedSeedHash]);
    for (const seat of battle.seats) rows.push([`Client seed · ${seat.name}`, seat.clientSeed]);
  }

  const head = el('h3', 'arena__fairhead');
  head.textContent = settled ? 'Verify this battle' : 'Committed before anyone joined';
  panel.appendChild(head);

  const note = el('p', 'arena__fairnote');
  note.textContent = settled
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
  const battle = view.battle;
  if (!battle || !view.schedule || battle.status === 'lobby') return;

  const tracks = [...root.querySelectorAll('.seat__track')];
  if (!tracks.length) return;

  // Build each reel's tile strip once, from the crate pool it is actually rolling.
  const byRound = new Map();
  for (const result of battle.results) {
    if (!byRound.has(result.round)) byRound.set(result.round, new Map());
    byRound.get(result.round).set(result.seat, result);
  }

  let lastRound = -1;
  const tick = () => {
    const now = Date.now();
    const { startsAt, roundMs } = view.schedule;
    const elapsed = now - startsAt;
    const totalRounds = battle.rounds.length;

    if (elapsed < 0) {
      frame = requestAnimationFrame(tick);
      return;
    }

    const index = Math.min(totalRounds - 1, Math.floor(elapsed / roundMs));
    const progress = Math.min(1, (elapsed % roundMs) / roundMs);
    const finished = elapsed >= roundMs * totalRounds;

    if (index !== lastRound) {
      lastRound = index;
      for (const cell of root.querySelectorAll('.arena__round')) {
        cell.dataset.active = Number(cell.dataset.index) === index ? '1' : '0';
      }
      for (const track of tracks) {
        const seat = Number(track.dataset.seat);
        buildStrip(track, byRound.get(index)?.get(seat), battle, index);
      }
      if (index > 0) playSound('click');
    }

    /* Ease out toward the winning tile. The easing is a pure function of progress, so two clients
     * at the same instant compute the same offset to the pixel. */
    const eased = 1 - (1 - progress) ** 3;
    const tile = 96;
    const target = (TILE_COUNT - 4) * tile;
    for (const track of tracks) {
      track.style.transform = `translate3d(${-(eased * target)}px, 0, 0)`;
    }

    if (finished) {
      paintTotals(battle);
      announce(battle);
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

function buildStrip(track, result, battle, roundIndex) {
  track.innerHTML = '';
  const round = battle.rounds[roundIndex];
  const pool = state.cases.find((entry) => entry.id === round?.caseId)?.drops ?? [];

  for (let index = 0; index < TILE_COUNT; index += 1) {
    const tile = el('div', 'seat__tile');
    const winning = index === TILE_COUNT - 4;
    const item = winning
      ? result?.item
      : pool[Math.floor(Math.random() * Math.max(1, pool.length))];
    if (winning) tile.dataset.win = '1';

    const art = document.createElement('img');
    art.src = safeImage(item?.imageUrl ?? item?.img ?? '');
    art.alt = '';
    tile.appendChild(art);

    if (winning && result) {
      const value = el('span', 'seat__tileval mono');
      value.textContent = money(Number(result.payoutMinor));
      tile.appendChild(value);
    }
    track.appendChild(tile);
  }
}

function paintTotals(battle) {
  for (const seat of battle.seats) {
    const node = root.querySelector(`.seat__total[data-seat="${seat.seat}"]`);
    if (!node) continue;
    node.innerHTML = '';
    node.append(coin(), document.createTextNode(money(Number(seat.totalDropMinor ?? 0))));
  }
}

let announced = null;
function announce(battle) {
  if (announced === battle.code || battle.status !== 'settled') return;
  announced = battle.code;

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
    location.hash = `#/battles/${result.battle.code}`;
    openBattle(result.battle.code);
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
    location.hash = `#/battles/${code}`;
    openBattle(code);
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
  return round?.imageUrl || 'assets/img/block/chest_normal.png';
}

function coin() {
  const mark = el('i', 'coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

void grouped;
