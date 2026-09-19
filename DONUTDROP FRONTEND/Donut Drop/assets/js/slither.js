/* slither.js — the Slither arena: the lobby, the pit and the way out.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS ALLOWED TO DECIDE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Where the player wants to point, and whether they are holding boost or extract. That is the
 * entire list. It never computes a position, a collision, a pickup, a kill or a payout — those
 * arrive as snapshots from a server that simulates them, because every one of them is a statement
 * about money and a client that could make one could make a better one.
 *
 * There is no source of chance anywhere in here, not even a cosmetic one. Orb sparkle and scale
 * phase are derived from the orb's own id, so two players watching the same floor see the same
 * floor, and the "no client-side roll" guarantee this platform makes about its other modes is not
 * quietly weakened by a mode that happens to have particles in it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWENTY SNAPSHOTS A SECOND, SIXTY FRAMES A SECOND
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The server ticks at 20Hz. Drawing those frames as they land is a 20fps game with a 60fps frame
 * counter, so the renderer deliberately runs one snapshot BEHIND: it draws the world as it was
 * `INTERP_MS` ago and interpolates between the two snapshots that straddle that instant. The cost
 * is a tenth of a second of latency on everything you see. The gain is that nothing on screen ever
 * teleports, which in a game about judging a gap by eye is not a cosmetic concern.
 *
 * Bodies are resampled to a fixed number of equally spaced points before being interpolated. The
 * obvious alternative — lerping point N against point N — is wrong, because the server sheds and
 * adds points at the ends as a snake moves, so point N is a different part of the animal between
 * two frames and the whole body crawls backward through itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO FEES ARE DISPLAYED, AND THAT IS A DESIGN DECISION WITH A RULE BEHIND IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The platform's cut is applied on the server at the instant of extraction, and the socket sends
 * back the figure that actually reached the wallet. This file renders that figure. It never
 * receives a rate, a rake or a split, so there is nothing here to accidentally put on screen — the
 * absence is structural rather than a matter of remembering not to.
 */
import { bus, refreshBalance } from './store.js';
import { $, clamp, el, formatAmountInput, money, parseAmount } from './util.js';
import { closeModal, toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { API_BASE_URL, api } from './api.js';
import { initSideBets, stopSideBets } from './sidebet.js';
import { createSlitherRenderer, logStakeRadius, snakeColourCss } from './slither-renderer.js';

/* ═════════════════════════ the numbers this file is built on ═════════════════════════ */

/** The entry band. Re-read from the server on every mount; these are only the fallback. */
const MIN_ENTRY = 1_000_000;
const MAX_ENTRY = 100_000_000;

/** How far behind live the renderer draws. One snapshot plus a little. See the header. */
const INTERP_MS = 110;

/** Input frames a second. Matched to the server tick: sending faster is bytes nobody reads. */
const INPUT_HZ = 20;

/* ═════════════════════════ module state ═════════════════════════ */

let root = null;
let board = null;
let socket = null;
let reconnectTimer = 0;

/** The session this client is playing, or null in the lobby. */
let live = null;

/** The two most recent snapshots, and when each arrived. Interpolation straddles them. */
let previousFrame = null;
let currentFrame = null;

/** What the player is asking for, as read by the input layer and sent at INPUT_HZ. */
const input = { heading: 0, boost: false, extract: false };
let inputTimer = 0;

/** Everything the renderer owns. Torn down in one place, see `destroyScene`. */
let renderer = null;

/** The value we were carrying on the previous snapshot, so a pickup can be heard. */
let lastValue = 0;
/** Throttle for the pickup cue: at speed a snake eats several orbs a tick. */
let lastAbsorbAt = 0;

/* ═════════════════════════ entry ═════════════════════════ */

export function mountSlither(view) {
  root = $('#slitherRoot', view);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) void refresh();
    });
    /* Leaving the route is not leaving the pit — the snake stays on the floor and the server keeps
     * simulating it, exactly as it would if the tab had crashed. Navigating away to dodge a losing
     * position has to cost the same as pulling the network cable, or it becomes the way to play. */
    window.addEventListener('hashchange', () => {
      if (!root.isConnected || root.closest('.view')?.hidden) teardownArena();
    });
  }
  void refresh();
}

async function refresh() {
  try {
    board = await api.get('/v1/slither');
  } catch (error) {
    root.replaceChildren(
      notice(
        error?.code === 'ARENA_DISABLED'
          ? 'The arena is not switched on yet.'
          : 'The arena could not be reached.',
      ),
    );
    return;
  }
  if (!live) renderLobby();
}

function notice(text) {
  const box = el('p', 'empty');
  box.textContent = text;
  return box;
}

/* ═════════════════════════ the lobby ═════════════════════════ */

/**
 * The entry screen: a wager card over the live pit, blurred.
 *
 * The background is the REAL arena, not a canned loop of one. The socket accepts a `spectate` frame
 * from anybody and answers with the same culled snapshot a player gets, minus any `you` — so there
 * is nothing in the frame to steer and nothing that could be mistaken for a position. An empty pit
 * shows an empty floor, which is honest and still moves, because the gates rotate regardless.
 *
 * Blurred in CSS rather than by rendering small: the point is to put the wager card in focus, and a
 * low-resolution render would still cost a full-screen pass while looking worse.
 */
function renderLobby() {
  const wrap = el('div', 'arena arena--entry');
  const stage = el('div', 'pit pit--entry');

  const canvas = el('canvas', 'pit__gl');
  canvas.setAttribute('aria-hidden', 'true');
  stage.append(canvas);

  /* Names are DOM text, not per-frame canvas glyph uploads. The renderer only transforms labels
   * whose quadtree entries intersect the camera. */
  const names = el('div', 'pit__names');
  names.setAttribute('aria-hidden', 'true');
  stage.append(names);

  const veil = el('div', 'pit__veil');
  veil.setAttribute('aria-hidden', 'true');
  stage.append(veil);

  stage.append(entryCard());
  wrap.append(stage);
  root.replaceChildren(wrap);

  /* The background is decoration, so a machine that cannot run WebGL loses it and keeps the card.
   * Entering the pit must never depend on a GPU. */
  void buildScene(canvas).then(
    () => spectate(),
    () => {
      canvas.remove();
      stage.dataset.flat = '1';
    },
  );
}

/** The wager card. The band, the presets, the amount, and one button. */
function entryCard() {
  const min = Number(board.minEntryMinor ?? MIN_ENTRY);
  const max = Number(board.maxEntryMinor ?? MAX_ENTRY);
  let entry = clamp(min, min, max);

  const card = el('div', 'entry');

  const badges = el('div', 'entry__badges');
  for (const [glyph, value, label] of [
    ['\u26A1', `${money(min)} / ${money(max)}`, 'MIN / MAX'],
    ['\u{1F6E1}', 'VERIFIED', 'ANTI-CHEAT'],
    ['\u{1F3AE}', `${board.players} / ${board.maxPlayers}`, 'IN THE PIT'],
  ]) {
    const badge = el('span', 'arena__badge');
    const icon = el('em', 'arena__badgeIco');
    icon.textContent = glyph;
    badge.append(
      icon,
      Object.assign(el('b'), { textContent: value }),
      Object.assign(el('i'), { textContent: label }),
    );
    badges.append(badge);
  }

  const amount = el('b', 'entry__amt mono');
  const shape = el('span', 'entry__shape');

  const bar = el('div', 'arenanew__bar');
  const fill = el('i', 'arenanew__fillbar');
  bar.append(fill);

  const field = el('input', 'arenanew__input mono');
  field.type = 'text';
  field.inputMode = 'numeric';
  field.autocomplete = 'off';
  field.setAttribute('aria-label', 'Buy-in');

  const paint = ({ retypeField = true } = {}) => {
    entry = clamp(Math.floor(entry), min, max);
    amount.textContent = money(entry);
    if (retypeField) field.value = formatAmountInput(entry);
    const t = (Math.log(entry) - Math.log(min)) / (Math.log(max) - Math.log(min));
    shape.textContent =
      t < 0.25
        ? 'COMPACT \u00B7 FAST \u00B7 HIGH AGILITY'
        : t < 0.6
          ? 'BALANCED \u00B7 STEADY \u00B7 GOOD REACH'
          : t < 0.9
            ? 'HEAVY \u00B7 WIDE \u00B7 LONG BODY'
            : 'LEVIATHAN \u00B7 SLOW \u00B7 RADIANT AURA';
    fill.style.width = `${Math.round(t * 100)}%`;
    card.dataset.tier = t < 0.25 ? 'min' : t < 0.6 ? 'mid' : t < 0.9 ? 'high' : 'max';
  };

  const chips = el('div', 'qchips');
  for (const preset of (board.presets ?? []).map(Number)) {
    const chip = el('button', 'qchip');
    chip.type = 'button';
    chip.textContent = `+${money(preset)}`;
    chip.addEventListener('click', () => {
      entry = clamp(entry + preset, min, max);
      playSound('click');
      paint();
    });
    chips.append(chip);
  }

  const edges = el('div', 'arenanew__seg arenanew__seg--two');
  for (const [label, value] of [
    ['MIN', min],
    ['MAX', max],
  ]) {
    const option = el('button', 'arenanew__opt');
    option.type = 'button';
    option.append(
      Object.assign(el('b'), { textContent: money(value) }),
      Object.assign(el('i'), { textContent: label }),
    );
    option.addEventListener('click', () => {
      entry = value;
      paint();
    });
    edges.append(option);
  }

  field.addEventListener('input', () => {
    const parsed = parseAmount(field.value);
    if (parsed === null) return;
    entry = parsed;
    paint({ retypeField: false });
  });
  field.addEventListener('blur', () => paint());

  /* The terms, stated before the buy-in rather than discovered after it.
   *
   * Three facts, each a figure: where value comes from, what boosting costs, what leaving costs.
   * Every one is server-supplied — the fee is the same number snapshotted onto the session, and
   * the burn rate is derived from the simulation's own constants — so this cannot drift into
   * quoting terms the pit does not actually apply.
   *
   * Placed immediately above the button because that is when it is read. Higher up it competes
   * with the stake dial, which is the thing a player is actually adjusting; here it is the last
   * thing between deciding an amount and committing it. */
  const terms = el('dl', 'entry__terms');
  const feePct = (Number(board.cashoutFeeBps ?? 0) / 100).toFixed(
    Number(board.cashoutFeeBps ?? 0) % 100 === 0 ? 0 : 1,
  );
  const burnPct = (Number(board.boostBurnBpsPerSecond ?? 0) / 100).toFixed(1);
  for (const [label, value] of [
    ['Growth', 'Kills only — no food in the pit'],
    ['Boost', `−${burnPct}% a second, burned`],
    ['Cash out', `−${feePct}% of what you carry`],
  ]) {
    const key = el('dt', 'entry__termk');
    key.textContent = label;
    const val = el('dd', 'entry__termv');
    val.textContent = value;
    terms.append(key, val);
  }

  const go = el('button', 'btn btn--go entry__go');
  go.textContent = board.liveSessionId ? 'REJOIN THE PIT' : 'ENTER THE PIT';
  go.addEventListener('click', () => void join(entry, go));

  const lb = el('div', 'entry__lb');

  card.append(badges, amount, shape, bar, field, chips, edges, terms, go, lb);
  paint();
  return card;
}

function leaderboardPanel(leaders, caption) {
  const panel = el('div', 'arenalb');
  const cap = el('div', 'arenalb__cap');
  cap.textContent = caption;
  panel.append(cap);
  if (!leaders.length) {
    const none = el('div', 'arenalb__none');
    none.textContent = 'Nobody in yet';
    panel.append(none);
    return panel;
  }
  leaders.forEach((leader, index) => {
    const row = el('div', 'arenalb__row');
    row.dataset.you = leader.isYou ? '1' : '0';
    const rank = el('span', 'arenalb__rank');
    rank.textContent = `#${index + 1}`;
    const name = el('span', 'arenalb__name');
    name.textContent = leader.name;
    const value = el('span', 'arenalb__val mono');
    value.textContent = money(Number(leader.valueMinor));
    row.append(rank, name, value);
    if (leader.extractable) {
      const pill = el('i', 'arenalb__pill');
      pill.textContent = 'EXTRACTABLE';
      row.append(pill);
    }
    panel.append(row);
  });
  return panel;
}

/* The entry modal is gone. It was a dialog you opened from a flat lobby page to set a stake; the
 * stake now sits on the entry screen itself, over the live pit, so the thing a player is about to
 * risk money on is on screen while they decide how much. See `entryCard`.
 */

async function join(entryMinor, button) {
  button.disabled = true;
  try {
    const accepted = await api.post('/v1/slither/join', { entryMinor: String(entryMinor) });
    closeModal();
    live = accepted;
    lastValue = Number(accepted.entryMinor);
    previousFrame = null;
    currentFrame = null;
    await startArena(accepted);
  } catch (error) {
    button.disabled = false;
    toast({
      kind: 'lose',
      title: 'CANNOT ENTER',
      body: error?.message || 'Try again',
    });
  }
}

/* ═════════════════════════ transport ═════════════════════════ */

function socketUrl() {
  return `${API_BASE_URL.replace(/^http/, 'ws')}/v1/slither/live`;
}

/**
 * Opens a socket that only watches.
 *
 * No ticket, no account, nothing to steer. The frames it receives carry `you: null`, so the
 * renderer draws the pit and the spectator camera follows the `focus` the server names.
 */
function spectate() {
  disconnect();
  try {
    socket = new WebSocket(socketUrl());
  } catch {
    return;
  }
  socket.addEventListener('open', () => send({ type: 'spectate' }));
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== 'arena:state') return;
    previousFrame = currentFrame;
    currentFrame = { ...message, at: performance.now() };
    paintSpectatorBoard(message);
  });
  socket.addEventListener('error', () => {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  });
}

/** The live board on the entry card. Throttled, like the in-game one. */
let entryBeat = 0;
function paintSpectatorBoard(frame) {
  entryBeat += 1;
  if (entryBeat % 6 !== 0) return;
  const host = root?.querySelector('.entry__lb');
  if (!host) return;
  host.replaceChildren(leaderboardPanel(frame.leaders ?? [], 'IN THE PIT'));
}

function connect(ticket) {
  disconnect();
  try {
    socket = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect(ticket);
    return;
  }
  socket.addEventListener('open', () => {
    send({ type: 'enter', ticket });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(message);
  });
  socket.addEventListener('close', () => {
    /* No automatic reconnect while a snake is live. The ticket is single use and the session is
     * already on the floor: re-entering would need a new buy-in, and silently taking one because
     * a socket blinked is not a thing this file gets to do. */
    if (live) finish('abandoned', '0');
  });
  socket.addEventListener('error', () => {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  });
}

function scheduleReconnect(ticket) {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => connect(ticket), 1200);
}

function disconnect() {
  window.clearTimeout(reconnectTimer);
  if (!socket) return;
  try {
    socket.close();
  } catch {
    /* already gone */
  }
  socket = null;
}

function send(frame) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function handle(message) {
  switch (message.type) {
    case 'arena:entered':
      live = { ...live, publicId: message.publicId };
      break;
    case 'arena:state':
      previousFrame = currentFrame;
      currentFrame = { ...message, at: performance.now() };
      hearPickups(message);
      paintHud(message);
      break;
    case 'arena:hit':
      onHit(message);
      break;
    case 'arena:cashout':
      if (message.id !== live?.publicId) {
        toast({
          kind: 'gold',
          title: 'EXTRACTED',
          body: `${message.name} left with ${money(Number(message.creditedMinor))}`,
        });
      }
      break;
    case 'arena:over':
      finish(message.reason, message.creditedMinor);
      break;
    default:
      break;
  }
}

/**
 * Plays a pickup when our own value went up.
 *
 * Derived from the value rather than from orbs disappearing out of the frame, because orbs leave
 * the frame constantly — eaten by other players, or simply left behind as we move and the server
 * stops sending them. Only one of those is a sound the player wants.
 */
function hearPickups(frame) {
  const now = Number(frame.you?.valueMinor ?? lastValue);
  const grew = now > lastValue;
  lastValue = now;
  if (!grew) return;
  const at = performance.now();
  if (at - lastAbsorbAt < 90) return;
  lastAbsorbAt = at;
  playSound('absorb');
}

function onHit(message) {
  const dropped = money(Number(message.droppedMinor));
  if (message.victim === live?.publicId) return; // the over frame says it better
  if (message.killer && message.killer === live?.publicId) {
    playSound('jackpot');
    toast({ kind: 'gold', title: 'KILL', body: `${dropped} on the floor — go and get it` });
    return;
  }
  playSound('spill');
}

/* ═════════════════════════ the arena shell ═════════════════════════ */

async function startArena(session) {
  /* The entry screen owns a renderer and a spectating socket. Both go before the pit builds its
   * own, or the page ends up with two WebGL contexts and two sockets fighting over one frame. */
  destroyScene();
  disconnect();
  previousFrame = null;
  currentFrame = null;
  root.replaceChildren(buildArenaDom());
  attachInput();
  initSideBets(root.querySelector('.pit__bets'));
  connect(session.ticket);
  try {
    await buildScene();
  } catch {
    toast({ kind: 'lose', title: 'NO WEBGL', body: 'This browser cannot run the arena' });
    teardownArena();
    return;
  }
  input.heading = 0;
  inputTimer = window.setInterval(pushInput, 1000 / INPUT_HZ);
}

function buildArenaDom() {
  const stage = el('div', 'pit');

  const canvas = el('canvas', 'pit__gl');
  canvas.setAttribute('aria-hidden', 'true');
  stage.append(canvas);

  /* Names are DOM text, not glyphs uploaded to a texture every frame. The renderer resolves this
   * host once when it starts, so it has to be in the tree BEFORE `buildScene` runs — which is why
   * it is appended here and not added later. The lobby builds the same element for the same
   * reason; the pit was missing it, so nobody in a live round had a name over their head. */
  const names = el('div', 'pit__names');
  names.setAttribute('aria-hidden', 'true');
  stage.append(names);

  const lb = el('div', 'pit__lb');
  stage.append(lb);

  const hud = el('div', 'pit__hud');
  const value = el('div', 'pit__value mono');
  value.textContent = money(Number(live?.entryMinor ?? 0));
  const action = el('button', 'pit__cash');
  action.type = 'button';
  const actionFill = el('i', 'pit__cashfill');
  const actionText = el('span', 'pit__cashtxt');
  actionText.textContent = '[ HOLD E TO CASHOUT ]';
  action.append(actionFill, actionText);
  /* Touch has no E key and no space bar, so the button is the extract control on a phone. */
  action.addEventListener('pointerdown', () => {
    input.extract = true;
    pushInput();
  });
  for (const done of ['pointerup', 'pointercancel', 'pointerleave']) {
    action.addEventListener(done, () => {
      input.extract = false;
      pushInput();
    });
  }
  hud.append(value, action);
  stage.append(hud);

  /* Bottom left, the one corner nothing else claims: the board is top right, the spectator panel
   * top left, the value and the cashout button run along the bottom centre, and the touch boost pad
   * sits bottom right. Nothing here ever covers anything else. */
  const map = el('canvas', 'pit__map');
  map.setAttribute('aria-hidden', 'true');
  stage.append(map);
  mountMinimap(map);

  const boost = el('button', 'pit__boost');
  boost.type = 'button';
  boost.textContent = 'BOOST';
  boost.addEventListener('pointerdown', () => setBoost(true));
  for (const done of ['pointerup', 'pointercancel', 'pointerleave']) {
    boost.addEventListener(done, () => setBoost(false));
  }
  stage.append(boost);

  /* The spectator board. It is mounted inside the pit rather than beside it because the people it
   * is for are already looking at the pit — and it lives opposite the leaderboard so the two never
   * cover each other or the middle of the floor. */
  const bets = el('div', 'pit__bets');
  stage.append(bets);

  stage.append(el('div', 'pit__over'));
  return stage;
}

let hudBeat = 0;

function paintHud(frame) {
  const stage = root.querySelector('.pit');
  if (!stage) return;
  const you = frame.you;
  const value = stage.querySelector('.pit__value');
  if (value && you) value.textContent = money(Number(you.valueMinor));
  const fill = stage.querySelector('.pit__cashfill');
  if (fill) fill.style.width = `${Math.round((you?.extracting ?? 0) * 100)}%`;
  const action = stage.querySelector('.pit__cash');
  if (action) action.dataset.on = (you?.extracting ?? 0) > 0 ? '1' : '0';

  /* The board is rebuilt five times a second, not twenty. It is a list of five names that change
   * every few seconds; replacing its DOM on every snapshot is layout work nobody can perceive. */
  hudBeat += 1;
  if (hudBeat % 2 === 0) paintMinimap(frame);
  if (hudBeat % 4 === 0) {
    const lb = stage.querySelector('.pit__lb');
    if (lb) lb.replaceChildren(leaderboardPanel(frame.leaders, 'TOP FIVE'));
  }
}

/* ═════════ the minimap ═════════
 *
 * The pit is 7200 units across and the camera shows a few hundred of them at a time. Without a map
 * a player knows only what is already on top of them — and in a mode where the ONLY income is a
 * kill, the two questions that decide a round are "where is everybody" and "where is the money
 * somebody just dropped". Both are unanswerable from inside the camera.
 *
 * It is a 2D canvas rather than a fourth pass in the WebGL renderer. The renderer's whole frame is
 * three draw calls and a second camera inside it would mean a second projection, a second cull and
 * a scissor rect; this is forty dots on a 140px square, ten times a second. The cheap thing here is
 * also the simple thing.
 *
 * Its dots take their colour from `snakeColourCss` — the same function the floor uses — because a
 * map that assigns its own hues teaches the player a mapping and then breaks it at the moment they
 * lean on it.
 */

/** Set by the observer, never read from the DOM inside a paint. */
let mapWidth = 0;
let mapObserver = null;

function mountMinimap(canvas) {
  unmountMinimap();
  if (typeof ResizeObserver !== 'function') {
    /* Anything with WebGL2 has this, and this mode already requires WebGL2. Measured once anyway,
     * because a permanently blank square is a worse failure than a single forced reflow. */
    mapWidth = canvas.clientWidth;
    return;
  }
  /* Measuring in the paint would be a forced reflow ten times a second — the exact mistake the
   * renderer's name layer already had to be cured of once. The observer reports the box instead. */
  mapObserver = new ResizeObserver((entries) => {
    for (const entry of entries) mapWidth = entry.contentRect.width;
  });
  mapObserver.observe(canvas);
}

function unmountMinimap() {
  mapObserver?.disconnect();
  mapObserver = null;
  mapWidth = 0;
}

/** A snake's dot, true to the radius it actually has on the floor, with a floor and a ceiling. */
function mapDotRadius(snake, scale) {
  const world = Number(snake.radius);
  const radius = Number.isFinite(world) && world > 0
    ? world
    : logStakeRadius(snake.valueMinor, board?.minEntryMinor, board?.maxEntryMinor);
  return clamp(radius * scale, 1.7, 5);
}

function paintMinimap(frame) {
  const canvas = root?.querySelector('.pit__map');
  if (!canvas || mapWidth < 8) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* Capped at 2: past that the extra pixels cost real fill rate and buy nothing on a 140px box. */
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixels = Math.round(mapWidth * dpr);
  if (canvas.width !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mapWidth, mapWidth);

  const centre = mapWidth / 2;
  const arena = arenaRadius();
  const scale = (centre - 3) / arena;
  /* World +y is screen-down in the arena shader, and it is screen-down on a 2D canvas too, so the
   * two agree with no flip. If that shader's sign ever changes, this has to change with it. */
  const at = (value) => centre + value * scale;

  ctx.beginPath();
  ctx.arc(centre, centre, centre - 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, .035)';
  ctx.fill();
  /* Red, because the wall is red on the floor. */
  ctx.strokeStyle = 'rgba(192, 57, 43, .55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  /* The gates: the only way out with the money, so they are the one thing on this map a player
   * needs to be able to find while being chased. */
  ctx.fillStyle = '#ffd700';
  for (const angle of frame.gates ?? []) {
    ctx.beginPath();
    ctx.arc(at(Math.cos(angle) * arena), at(Math.sin(angle) * arena), 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Loot. Dim and small on purpose — a cluster means somebody died there, which is the signal;
   * an individual orb is not, and drawn any brighter they would out-shout the players. */
  ctx.fillStyle = 'rgba(255, 170, 0, .5)';
  for (const orb of frame.orbs ?? []) {
    ctx.beginPath();
    ctx.arc(at(Number(orb.x)), at(Number(orb.y)), 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  let you = frame.you ?? null;
  for (const snake of frame.snakes ?? []) {
    const head = snake.paths?.[0];
    if (!head || head.length < 2) continue;
    if (snake.isYou) {
      you = snake;
      continue;
    }
    ctx.beginPath();
    ctx.arc(at(Number(head[0])), at(Number(head[1])), mapDotRadius(snake, scale), 0, Math.PI * 2);
    ctx.fillStyle = snakeColourCss(snake);
    ctx.fill();
  }

  /* You, last, so nobody is ever drawn over you. A player who cannot find themselves on the map
   * has to look away from the floor to use it, and looking away is how a stake is lost. */
  const head = you?.paths?.[0];
  if (!head || head.length < 2) return;
  const x = at(Number(head[0]));
  const y = at(Number(head[1]));
  const dot = mapDotRadius(you, scale);
  ctx.beginPath();
  ctx.arc(x, y, dot + 0.6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, dot + 3.2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 215, 0, .55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Ends the round on screen.
 *
 * The money moved on the server before this frame was sent, so nothing here decides anything —
 * it reports. `creditedMinor` is what reached the wallet, and it is the only figure shown.
 */
function finish(reason, creditedMinor) {
  if (!live) return;
  const credited = Number(creditedMinor || 0);
  const won = reason === 'cashed_out';
  live = null;
  detachInput();
  disconnect();

  const overlay = root.querySelector('.pit__over');
  if (overlay) {
    overlay.dataset.on = '1';
    overlay.dataset.result = won ? 'win' : 'lose';
    const kicker = el('div', 'pit__overkick');
    kicker.textContent = won ? 'EXTRACTED' : reason === 'wall' ? 'HIT THE WALL' : 'WIPED OUT';
    const figure = el('div', 'pit__overfig mono');
    figure.textContent = won ? money(credited) : money(0);
    const again = el('button', 'btn btn--go');
    again.textContent = 'BACK TO THE PIT';
    again.addEventListener('click', () => {
      teardownArena();
      void refresh();
    });
    overlay.replaceChildren(kicker, figure, again);
  }

  playSound(won ? 'win' : 'lose');
  void refreshBalance();
}

function teardownArena() {
  live = null;
  stopSideBets();
  detachInput();
  disconnect();
  destroyScene();
  unmountMinimap();
  previousFrame = null;
  currentFrame = null;
  if (root?.isConnected) void refresh();
}

/* ═════════════════════════ input ═════════════════════════ */

let pointerX = 0;
let pointerY = 0;

function setBoost(on) {
  if (input.boost === on) return;
  input.boost = on;
  if (on) playSound('boost');
  pushInput();
}

function onPointerMove(event) {
  pointerX = event.clientX;
  pointerY = event.clientY;
  aim();
}

function onTouchMove(event) {
  const touch = event.touches[0];
  if (!touch) return;
  pointerX = touch.clientX;
  pointerY = touch.clientY;
  aim();
}

/**
 * Turns a pointer position into a heading.
 *
 * The player's head is always at the centre of the canvas, so the direction is simply the vector
 * from the centre to the cursor. There is no smoothing applied to the ANGLE here: the server turns
 * the snake at its own bounded rate, so the responsiveness a player feels comes from the angle
 * being sent raw and the turn being eased on the far end, not from easing it twice.
 */
function aim() {
  const canvas = root?.querySelector('.pit__gl');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dx = pointerX - (rect.left + rect.width / 2);
  const dy = pointerY - (rect.top + rect.height / 2);
  if (dx === 0 && dy === 0) return;
  input.heading = Math.atan2(dy, dx);
}

function onKeyDown(event) {
  if (event.repeat) return;
  if (event.code === 'Space') {
    event.preventDefault();
    setBoost(true);
  }
  if (event.code === 'KeyE') {
    input.extract = true;
    pushInput();
  }
}

function onKeyUp(event) {
  if (event.code === 'Space') setBoost(false);
  if (event.code === 'KeyE') {
    input.extract = false;
    pushInput();
  }
}

function onMouseDown(event) {
  // Left or right, both boost. A right-click that opens a context menu mid-chase is a death.
  event.preventDefault();
  setBoost(true);
}

function onMouseUp() {
  setBoost(false);
}

function onContextMenu(event) {
  event.preventDefault();
}

function attachInput() {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  const canvas = root?.querySelector('.pit__gl');
  canvas?.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  canvas?.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', releaseAll);
}

function detachInput() {
  window.clearInterval(inputTimer);
  inputTimer = 0;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('touchmove', onTouchMove);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('blur', releaseAll);
  const canvas = root?.querySelector('.pit__gl');
  canvas?.removeEventListener('mousedown', onMouseDown);
  canvas?.removeEventListener('contextmenu', onContextMenu);
  releaseAll();
}

/** A tab that loses focus must not leave boost held down and drain a snake nobody is watching. */
function releaseAll() {
  input.boost = false;
  input.extract = false;
  pushInput();
}

function pushInput() {
  if (!live) return;
  send({ type: 'input', heading: input.heading, boost: input.boost, extract: input.extract });
}

/* ═════════════════════════ interpolation ═════════════════════════ */
/** The two frames that straddle the render clock, and how far between them we are. */
function interpolation() {
  if (!currentFrame) return null;
  if (!previousFrame) return { from: currentFrame, to: currentFrame, t: 1 };
  const renderAt = performance.now() - INTERP_MS;
  const span = currentFrame.at - previousFrame.at;
  if (span <= 0) return { from: currentFrame, to: currentFrame, t: 1 };
  return {
    from: previousFrame,
    to: currentFrame,
    t: clamp((renderAt - previousFrame.at) / span, 0, 1),
  };
}

/* ═════════════════════════ the scene ═════════════════════════
 *
 * Every pixel is drawn by `slither-renderer.js`. This section owns the renderer's LIFETIME — when
 * one exists, what it is allowed to read, and that exactly one of it exists at a time — and nothing
 * else.
 *
 * There is deliberately no second drawing path here any more. This file used to carry a whole
 * Canvas2D renderer alongside the WebGL module it imports, and the two of them disagreeing about
 * which was live is precisely what left the pit showing nothing: the 2D path assigned to a `gl`
 * binding that no longer existed, which in a module — strict mode, always — is a ReferenceError,
 * so `buildScene` threw on its first line. The lobby quietly dropped its canvas and the pit
 * reported "NO WEBGL" on machines that had WebGL. One renderer, named once, is the fix.
 *
 * What the renderer gets is three accessors and no state. It cannot move a snake, change a value
 * or decide an outcome, because it is never handed anything it could change — the same guarantee
 * the top of this file makes about the client as a whole, kept structurally rather than by
 * remembering to.
 */

/** The radius the server is simulating inside. The floor, the wall and the gates come off it. */
function arenaRadius() {
  return Number(board?.arenaRadius) || 3600;
}

/**
 * Builds the scene on a canvas and starts its frame loop.
 *
 * Rejects when the machine cannot give us a WebGL2 context, and both call sites lean on that: the
 * lobby drops its background and keeps the wager card, and the pit refuses to start. A paid entry
 * must never begin behind a canvas the player cannot see.
 *
 * Still `async` because the call sites await it. It resolves immediately — there is no module to
 * fetch any more.
 */
async function buildScene(target) {
  const canvas = target ?? root?.querySelector('.pit__gl');
  if (!canvas) throw new Error('no canvas');
  /* Defensive: two live contexts on one page is how the lobby's spectator view and the pit's own
   * view ended up racing for the same frame. Whoever calls this owns the only renderer there is. */
  destroyScene();
  renderer = createSlitherRenderer(canvas, {
    getStep: interpolation,
    getArenaRadius: arenaRadius,
    minStakeMinor: Number(board?.minEntryMinor ?? MIN_ENTRY),
    maxStakeMinor: Number(board?.maxEntryMinor ?? MAX_ENTRY),
    /* The GPU took the context back — a driver reset, or a tab starved in the background. Nothing
     * here can rebuild it in place, and the server is still simulating a snake the player can no
     * longer see or steer, so saying so is the only honest move. Sitting on a frozen floor while
     * money drains is the one behaviour that is definitely wrong. */
    onContextLost: () => {
      toast({
        kind: 'lose',
        title: 'GRAPHICS LOST',
        body: 'The arena view was dropped by the GPU',
      });
      teardownArena();
    },
  });
  return renderer;
}

/** Stops the loop and hands back every GPU object and label node. Safe when nothing is running. */
function destroyScene() {
  if (!renderer) return;
  renderer.destroy();
  renderer = null;
}
