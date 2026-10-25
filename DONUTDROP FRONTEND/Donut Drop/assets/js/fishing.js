/* fishing.js — Fishing: a deep dive on a fishing line. Cast, the lure goes under, and the multiplier
 * climbs with the depth -- past a coral reef, a kelp forest, a shipwreck, an ocean monument and the
 * abyss, down to an ancient city. Reel up whenever you like; go too deep and something down there
 * cuts the line.
 *
 * The server owns every cast (lib/fishing.ts, routes/fishing.ts). The cast stakes and draws the
 * line's breaking point from the player's committed fairness seed; from the moment the lure goes
 * under the multiplier climbs on the server's clock, the same curve as Crash. Reeling up is a
 * request: the server pays the multiplier the line had reached when it arrived, if the line still
 * held by then. This page draws the dive from the time the server gave and asks a few times a second
 * whether the line still holds, so it learns of a cut from the server and never from anything of its
 * own.
 *
 * The sinker is the pace: the same odds with every sinker, the dive faster with iron and fastest with
 * an anvil. The deeper the lure, the rarer the catch on it, from a raw cod in the shallows to an
 * enchanted golden apple out of an ancient city; what it pays is the multiplier.
 *
 * The wallet pill does not run ahead of the line: the live figures are held from the click until the
 * cast is reeled up or cut.
 *
 * The sea is drawn in WebGL (fishing3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage; where WebGL is missing or its context is lost, the flat pond does the same job.
 * The multiplier, the depth, the catch ladder and every result are in the page as text too -- what a
 * screen reader reads.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { openModal, toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { onNavigate } from './routing.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';

const SINKERS = [
  { id: 'feather', label: 'Feather', note: 'Drifts down' },
  { id: 'iron', label: 'Iron', note: 'Sinks faster' },
  { id: 'anvil', label: 'Anvil', note: 'Drops like a stone' },
];
/* The depths, from the multiplier each begins at (fishing3d.js builds the same), and what lives
 * there to cut a line that goes too deep. */
const ZONES = [
  { id: 'shallows', name: 'The Shallows', fromX100: 100, cutter: 'drowned' },
  { id: 'reef', name: 'Coral Reef', fromX100: 150, cutter: 'drowned' },
  { id: 'kelp', name: 'Kelp Forest', fromX100: 300, cutter: 'drowned' },
  { id: 'wreck', name: 'Shipwreck', fromX100: 500, cutter: 'drowned' },
  { id: 'monument', name: 'Ocean Monument', fromX100: 1000, cutter: 'guardian' },
  { id: 'abyss', name: 'The Abyss', fromX100: 2500, cutter: 'guardian' },
  { id: 'city', name: 'Ancient City', fromX100: 6000, cutter: 'warden' },
];
const CUTS = {
  drowned: 'A drowned grabbed the line',
  guardian: 'A guardian’s beam cut the line',
  warden: 'The warden’s sonic boom cut the line',
};
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/* Blocks of depth for every doubling of the multiplier, as fishing3d.js sinks the lure. */
const PER_DOUBLING = 22;
/* The catches that glint as enchanted items do. */
const ENCHANTED = new Set(['enchanted_golden_apple']);
/* A catch worth fireworks, in stakes. */
const BIG = 10;
const LOG_SIZE = 12;
/* How often the line is asked about while the lure goes down. */
const POLL_MS = 250;

/* The game draws the enchanted golden apple with the golden apple's sprite, glinting. */
const SPRITES = { enchanted_golden_apple: 'golden_apple' };
const icon = (id) => `assets/img/items/${SPRITES[id] ?? id}.png`;
/* Written only when it changes: the HUD and the button are painted every frame of a dive, and writing
 * the same value again still costs the browser a style pass. */
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setData = (node, key, value) => { if (node.dataset[key] !== value) node.dataset[key] = value; };
const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const setDisabled = (node, value) => { if (node.disabled !== value) node.disabled = value; };
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/* One formatter, made once: building it again for every figure of every frame was a measurable cost. */
const TWO_PLACES = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const times = (x100) => `${TWO_PLACES.format(x100 / 100)}×`;
/** How deep the lure is at a multiplier, in blocks. */
const depthAt = (x100) => Math.round(PER_DOUBLING * Math.log2(Math.max(100, x100) / 100));
/** The depth a multiplier is in. */
function zoneAt(x100) {
  let at = ZONES[0];
  for (const zone of ZONES) if (x100 >= zone.fromX100) at = zone;
  return at;
}

/** The multiplier, in hundredths and floored, `seconds` after the lure went under: lib/fishing.ts's curve. */
function x100At(growth, seconds, max) {
  if (!(seconds > 0)) return 100;
  return Math.min(max, Math.max(100, Math.floor(100 * Math.exp(growth * seconds) + 1e-9)));
}

let root = null;
let view = null;
let config = null;
let seedHash = null;
let stakeText = '1m';
let autoText = '';
let sinker = 'feather';
let phase = 'idle'; // idle | casting | climbing | settling
let auto = false;
let session = { casts: 0, won: 0n, best: 0n };
let log = []; // the newest first: { status, x100, catchId }
let round = null; // the cast in play
let pollTimer = 0;
let climbFrame = 0;
let nextTimer = 0;
let pond = null; // the WebGL sea, once it is up; null draws the flat pond
let pondTried = null;

/* ─────────── numbers ─────────── */

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

/** The auto reel-up target in hundredths, null when it is off, or NaN when it is not a multiplier. */
function autoX100() {
  const text = autoText.trim().replace(/[x×]$/i, '');
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.round(value * 100);
}

function maxStake() {
  if (!config) return 0n;
  const ceiling = (BigInt(config.maxPayoutMinor) * 100n) / BigInt(config.maxX100);
  const max = BigInt(config.maxStakeMinor);
  return ceiling < max ? ceiling : max;
}

function castProblem() {
  if (!config) return 'Fishing is not answering';
  if (!config.enabled) return 'Fishing is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest cast is ${money(Number(config.minStakeMinor))}`;
  if (stake > maxStake()) return `The largest cast is ${money(Number(maxStake()))}`;
  const target = autoX100();
  if (Number.isNaN(target) || (target !== null && (target < config.minLandX100 || target >= config.maxX100))) {
    return `Auto reel goes from ${times(config.minLandX100)} to ${times(config.maxX100 - 1)}`;
  }
  if (auto && target === null) return 'Set an auto reel to cast automatically';
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

const catchName = (id) => config?.catches?.[id]?.name ?? id;
const ladder = () => config?.ladder ?? [];
/** What is on the line at a multiplier. */
function tierAt(x100) {
  let id = ladder()[0]?.id ?? 'cod';
  for (const step of ladder()) if (x100 >= step.fromX100) id = step.id;
  return id;
}
const tierIndex = (id) => ladder().findIndex((step) => step.id === id);

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/fishing/config');
  } catch {
    config = null;
  }
  if (config) buildLadder();
  if (state.authenticated) {
    await refreshSeed();
    await loadLog();
  }
  paint();
  if (config) await startPond();
  if (state.authenticated && config && !round && phase === 'idle') await resume();
}

async function loadLog() {
  try {
    const { casts } = await api.get(`/v1/fishing/casts?limit=${LOG_SIZE}`);
    if (phase === 'idle') log = casts.map(logEntry);
  } catch {
    /* the log is a nicety; an empty one is fine */
  }
}

const logEntry = (cast) => ({ status: cast.status, x100: cast.status === 'landed' ? cast.landedX100 : cast.snapX100, catchId: cast.catch?.id ?? null });

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function send(stake) {
  if (!seedHash) await refreshSeed();
  const body = () => ({ stakeMinor: stake.toString(), sinker, autoLandX100: autoX100(), clientSeed: clientSeed(), serverSeedHash: seedHash });
  try {
    return await api.post('/v1/fishing/casts', body(), { idempotencyKey: idempotencyKey() });
  } catch (error) {
    /* The commitment moved (another tab played something): pick up the new one and go again under a
     * new key, since the request itself is now a different one. */
    if (error?.code !== 'FAIRNESS_COMMITMENT_CHANGED') throw error;
    await refreshSeed();
    return api.post('/v1/fishing/casts', body(), { idempotencyKey: idempotencyKey() });
  }
}

/* ─────────── the sea ─────────── */

/** Builds the 3D sea over the flat pond, once, as its own download. Any failure leaves the flat pond. */
function startPond() {
  if (pondTried) return pondTried;
  pondTried = (async () => {
    const host = $('.fishing__pond', root);
    try {
      const { createPond3d } = await import('./fishing3d.js');
      const built = await createPond3d(host, { sinker, catches: Object.keys(config.catches), icon });
      if (!built) return;
      built.onLost = () => {
        if (pond === built) pond = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onCue = (cue) => {
        if (cue === 'land') playSound('splash');
        else if (cue === 'dive') playSound('splash', { rate: 0.7 });
        else if (cue === 'tier') playSound('chime');
        else if (cue === 'reel') playSound('cast', { rate: 0.8 });
        else if (cue === 'breach') playSound('splash', { rate: 1.2 });
        else if (cue === 'cut') { playSound('shatter'); playSound('splash', { rate: 0.6 }); }
        else if (cue === 'boom') playSound('thunder', { rate: 1.6 });
        else if (cue === 'firework') playSound('shatter', { rate: 1.5 });
      };
      built.onUnderwater = (under) => { root.dataset.under = under ? '1' : '0'; };
      pond = built;
      root.dataset.render = '3d';
      paintGraphics();
    } catch {
      pond = null;
      root.dataset.render = '2d';
    }
  })();
  return pondTried;
}

/** The player's graphics: kept with the other display settings, and the sea built again at them. */
function setGraphics(value) {
  if (phase !== 'idle' || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (pond || pondTried) {
    pond?.dispose();
    pond = null;
    pondTried = null;
    root.dataset.render = '2d';
    root.dataset.under = '0';
    if (config) void startPond();
  }
  paintGraphics();
}

/* The flat pond: the bobber flies out, goes under, and comes up with the catch or is lost. */
function flat(stateName) {
  const node = root && $('.fishing__flat', root);
  if (node) node.dataset.state = stateName;
}
function flatCast() {
  flat('cast');
  return wait(reduceMotion() ? 0 : 520).then(() => { flat('wait'); playSound('splash'); });
}
async function flatLand(cast) {
  $('.fishing__flatcatch', root).src = icon(cast.catch.id);
  flat('caught');
  await wait(reduceMotion() ? 0 : 620);
}
async function flatSnap() {
  flat('snapped');
  await wait(reduceMotion() ? 0 : 700);
}

/* ─────────── a cast ─────────── */

async function cast() {
  clearTimeout(nextTimer);
  if (!state.authenticated) {
    stopAuto();
    $('#loginBtn')?.click();
    return;
  }
  if (phase !== 'idle') return;
  if (castProblem()) {
    stopAuto();
    paint();
    return;
  }
  phase = 'casting';
  const stake = stakeMinor();
  /* Held from the click, not from the answer: a poll landing between the two would print the
   * catch's pay before it was out of the water. */
  const release = holdLiveFigures();
  hideCatch();
  playSound('click');
  // The line goes out on the click; the lure goes under when the server says.
  const landed = pond ? pond.cast() : flatCast();
  playSound('cast');
  paintHud(100, 'waiting');
  paint();
  try {
    const sent = Date.now();
    const response = await send(stake);
    seedHash = response.nextServerSeedHash || null;
    // The stake leaves the pill now; what the catch pays waits for it.
    showBalance(response.balanceMinor);
    begin(response.cast, response.serverNow, sent, Date.now(), release);
  } catch (error) {
    stopAuto();
    release();
    phase = 'idle';
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    if (error?.code === 'CAST_IN_PLAY') void resume();
    else toast({ kind: 'lose', title: 'Fishing', body: error?.message || 'That cast did not go through' });
    // Nothing was staked: the line comes back empty.
    await landed;
    if (pond) await pond.slack();
    else flat('idle');
    paintHud(100, 'idle');
    void refreshBalance();
    paint();
  }
}

/** A cast is out: draw its dive from the server's time, and ask after it until it is over. */
function begin(cast, serverNow, sent, received, release) {
  round = {
    id: cast.id,
    stake: BigInt(cast.stakeMinor),
    hookedAt: Date.parse(cast.hookedAt),
    growth: cast.growth,
    autoX100: cast.autoLandX100,
    // The server's clock against this one's, taken at the middle of the round trip.
    offset: Date.parse(serverNow) - (sent + received) / 2,
    release,
    tier: null,
    zone: null,
    shown: 100,
    landing: false,
    settled: false,
    tickAt: 0,
  };
  const biteIn = round.hookedAt - (Date.now() + round.offset);
  pond?.setSinker(cast.sinker);
  pond?.hookAt(performance.now() + biteIn);
  if (!pond) setTimeout(() => { if (round?.id === cast.id && !round.settled) flat('fight'); }, Math.max(0, biteIn));
  phase = 'climbing';
  cancelAnimationFrame(climbFrame);
  climbFrame = requestAnimationFrame(climbStep);
  clearTimeout(pollTimer);
  // Nothing can be said about the line until the lure is under.
  pollTimer = setTimeout(poll, Math.max(POLL_MS, biteIn + 60));
  paint();
}

/** Picks up a cast left open (a reload mid-dive), or one the server will not start another over. */
async function resume() {
  try {
    const response = await api.get('/v1/fishing/casts/active');
    if (!response.cast || round || phase !== 'idle') return;
    if (response.cast.status !== 'open') return;
    phase = 'casting';
    const release = holdLiveFigures();
    if (pond) void pond.cast();
    else flat('wait');
    const now = Date.now();
    begin(response.cast, response.serverNow, now, now, release);
  } catch {
    /* nothing to pick up */
  }
}

function serverNow() {
  return Date.now() + (round?.offset ?? 0);
}

/** One frame of the dive: the multiplier, the depth, the ladder, the ticking reel. */
function climbStep() {
  if (!round || round.settled) return;
  const seconds = (serverNow() - round.hookedAt) / 1000;
  let x100 = x100At(round.growth, seconds, config.maxX100);
  // At its auto reel-up target the line holds still while the server says how it went.
  if (round.autoX100 && x100 >= round.autoX100) x100 = round.autoX100;
  round.shown = x100;
  if (seconds >= 0) {
    const tier = tierAt(x100);
    // The lure follows the curve itself, not its floored hundredths: near 1.00x a hundredth is a third
    // of a block of depth, and a floored figure moved the lure down in steps.
    const smooth = Math.min(x100 + 0.999, Math.max(100, 100 * Math.exp(round.growth * seconds)));
    pond?.climb(round.autoX100 && x100 >= round.autoX100 ? x100 : smooth, tier);
    if (tier !== round.tier) {
      const first = round.tier === null;
      round.tier = tier;
      paintLadder(tier, !first);
    }
    const zone = zoneAt(x100);
    if (zone !== round.zone) {
      const first = round.zone === null;
      round.zone = zone;
      root.dataset.zone = zone.id;
      if (!first) announceZone(zone, x100);
    }
    // The reel ticks faster as the line pays out.
    const tickNow = performance.now();
    if (tickNow >= round.tickAt) {
      round.tickAt = tickNow + Math.max(80, 420 / Math.sqrt(x100 / 100));
      playSound('reeltick', { rate: 0.8 + Math.log(x100 / 100) * 0.25 });
    }
  }
  // The figures at most thirty times a second (every frame on a fast machine): the lure moves every
  // frame regardless, and text is the dearest thing a frame can change on a slow one.
  const now = performance.now();
  if (pond?.tier === 'high' || now - (climbStep.paintedAt ?? 0) >= 33) {
    climbStep.paintedAt = now;
    paintHud(x100, seconds < 0 ? 'waiting' : 'climbing');
    paintControls();
  }
  climbFrame = requestAnimationFrame(climbStep);
}

function poll() {
  if (!round || round.settled) return;
  const id = round.id;
  api.get(`/v1/fishing/casts/${id}`)
    .then((response) => {
      if (round?.id === id && response.cast.status !== 'open') void finish(response.cast, response.balanceMinor);
    })
    .catch(() => { /* asked again shortly */ })
    .finally(() => {
      if (round?.id === id && !round.settled) pollTimer = setTimeout(poll, POLL_MS);
    });
}

/** Reel up: the server pays what the line has reached when this arrives, if it still holds. */
async function landNow() {
  if (phase !== 'climbing' || !round || round.settled || round.landing) return;
  if (round.shown < (config?.minLandX100 ?? 101)) return;
  round.landing = true;
  const id = round.id;
  playSound('click');
  paintControls();
  try {
    const response = await api.post(`/v1/fishing/casts/${id}/land`, {});
    if (round?.id === id) void finish(response.cast, response.balanceMinor);
  } catch (error) {
    if (round?.id === id) round.landing = false;
    if (error?.code !== 'NOTHING_TO_LAND') toast({ kind: 'lose', title: 'Fishing', body: error?.message || 'That reel did not go through' });
    paintControls();
  }
}

/** The cast is over: reeled up with its catch, or the line cut. */
async function finish(cast, balanceMinor) {
  if (!round || round.settled || round.id !== cast.id) return;
  const r = round;
  r.settled = true;
  clearTimeout(pollTimer);
  cancelAnimationFrame(climbFrame);
  phase = 'settling';
  paintControls();
  if (cast.status === 'landed') {
    paintHud(cast.landedX100, 'landed');
    splash(cast.landedX100 >= BIG * 100 ? 'Huge catch!' : 'Reeled up!', cast.landedX100 >= BIG * 100 ? 'big' : 'landed');
    if (pond) await pond.land(cast.catch.id, cast.landedX100, cast.catch.kind);
    else await flatLand(cast);
    present(cast, r.stake);
  } else {
    paintHud(cast.snapX100, 'snapped');
    splash('Cut!', 'snapped');
    if (pond) await pond.snap();
    else await flatSnap();
    presentSnap(cast, r.stake);
  }
  if (balanceMinor) showBalance(balanceMinor);
  r.release();
  round = null;
  phase = 'idle';
  root.dataset.zone = 'shallows';
  void refreshBalance();
  paint();
  scheduleNext(cast);
}

function present(cast, stake) {
  const paid = BigInt(cast.payoutMinor);
  const x = cast.landedX100 / 100;
  session.casts += 1;
  session.won += paid;
  if (paid > session.best) session.best = paid;
  log.unshift(logEntry(cast));
  log = log.slice(0, LOG_SIZE);
  showCatch(cast, stake);
  playSound(x >= BIG ? 'jackpot' : x >= 3 ? 'win' : 'coin');
  if (x >= BIG) setTimeout(() => playSound('chime'), 350);
  say(`Reeled up at ${times(cast.landedX100)}, ${depthAt(cast.landedX100)} blocks down: ${cast.catch.name}. It pays ${money(Number(paid))}.`);
  paintStats();
  paintLog();
}

/** Who cut a line at a multiplier. */
const cutAt = (x100) => CUTS[zoneAt(x100).cutter];

function presentSnap(cast, stake) {
  session.casts += 1;
  log.unshift(logEntry(cast));
  log = log.slice(0, LOG_SIZE);
  showSnap(cast, stake);
  playSound('lose');
  say(cast.snapX100 <= 100 ? `${cutAt(100)} as the lure went under.` : `${cutAt(cast.snapX100)} at ${times(cast.snapX100)}.`);
  paintStats();
  paintLog();
}

function scheduleNext(settled) {
  clearTimeout(nextTimer);
  if (!auto) return;
  if (!view || view.hidden || castProblem()) {
    stopAuto();
    return;
  }
  const big = settled?.status === 'landed' && settled.landedX100 >= BIG * 100;
  nextTimer = setTimeout(() => {
    if (!view || view.hidden) {
      stopAuto();
      return;
    }
    void cast();
  }, big ? 3600 : 1600);
}

function stopAuto() {
  clearTimeout(nextTimer);
  if (!auto) return;
  auto = false;
  paintControls();
}

function setSinker(name) {
  if (phase !== 'idle' || !SINKERS.some((s) => s.id === name) || name === sinker) return;
  sinker = name;
  globalThis.DonutPrefs?.update?.({ fishSinker: name === 'feather' ? undefined : name });
  pond?.setSinker(name);
  root.dataset.sinker = name;
  playSound('click');
  paint();
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintControls();
  paintSinkers();
  paintGraphics();
  paintStats();
  paintLog();
}

function paintControls() {
  if (!root) return;
  const go = $('#fishingGo', root);
  const label = $('#fishingGoLabel', root);
  const problem = phase === 'idle' ? castProblem() : '';
  let text = `Cast · ${money(Number(stakeMinor() ?? 0n))}`;
  let tone = 'go';
  if (!state.authenticated) text = 'Log in to play';
  else if (phase === 'casting') text = 'Casting…';
  else if (phase === 'climbing' && round) {
    const seconds = (serverNow() - round.hookedAt) / 1000;
    if (seconds < 0) text = 'The lure goes under…';
    else if (round.landing) text = 'Reeling up…';
    else {
      text = `Reel up · ${money(Number((round.stake * BigInt(round.shown)) / 100n))}`;
      tone = 'land';
    }
  } else if (phase === 'settling') text = '…';
  setText(label, text);
  setData(go, 'tone', tone);
  const canLand = tone === 'land';
  setDisabled(go, state.authenticated && (phase === 'idle' ? Boolean(problem) : !canLand));
  setAttr(go, 'aria-busy', String(phase !== 'idle' && !canLand));

  const autoButton = $('#fishingAuto', root);
  setAttr(autoButton, 'aria-pressed', String(auto));
  setText(autoButton, auto ? 'Stop auto' : 'Auto cast');
  setDisabled(autoButton, !state.authenticated);
  setText($('#fishingHint', root), state.authenticated && phase === 'idle' ? problem : '');
  if (paintControls.idle !== (phase === 'idle')) {
    paintControls.idle = phase === 'idle';
    for (const node of root.querySelectorAll('.fishing__field input, .fishing__adj')) node.disabled = phase !== 'idle';
  }
}

function paintSinkers() {
  for (const button of root.querySelectorAll('.fishing__sinker')) {
    const on = button.dataset.sinker === sinker;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    button.disabled = phase !== 'idle';
    const growth = config?.growth?.[button.dataset.sinker];
    $('.fishing__sinkertop', button).textContent = growth ? `2× in ${(Math.log(2) / growth).toFixed(1)}s` : '';
  }
}

function paintGraphics() {
  const select = root && $('#fishingGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  // Auto says what it chose for this machine.
  const chosen = pond?.tier;
  $('option[value="auto"]', select).textContent = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  select.disabled = phase !== 'idle';
}

function paintStats() {
  $('#fishingCasts', root).textContent = session.casts.toLocaleString('en-US');
  $('#fishingWon', root).textContent = money(Number(session.won));
  $('#fishingBest', root).textContent = session.best > 0n ? money(Number(session.best)) : '—';
}

function paintLog() {
  const list = $('#fishingLog', root);
  list.innerHTML = log.map((entry) => {
    const landed = entry.status === 'landed';
    const title = landed ? `${catchName(entry.catchId)} at ${times(entry.x100)}` : `Cut at ${times(entry.x100)}`;
    return `<li class="fishing__logitem" data-status="${entry.status}" title="${title}">
      <img src="${landed ? icon(entry.catchId) : icon('string')}" alt="" /><span>${times(entry.x100)}</span></li>`;
  }).join('');
  list.setAttribute('aria-label', log.length ? `Your last ${log.length} casts` : 'No casts yet');
  $('#fishingLogEmpty', root).hidden = log.length > 0;
  // The recent results over the sea, as Crash shows its last rounds.
  $('#fishingRecent', root).innerHTML = log.slice(0, 8).map((entry) => `<li data-status="${entry.status}">${times(entry.x100)}</li>`).join('');
}

/** The big multiplier over the sea, the depth, what reeling up now would pay, and what is happening. */
function paintHud(x100, status) {
  const hud = root && $('#fishingHud', root);
  if (!hud) return;
  setData(hud, 'state', status);
  const tier = status === 'snapped' || status === 'waiting' || status === 'idle' ? null : tierAt(x100);
  setData(hud, 'tier', tier ? String(Math.max(0, tierIndex(tier))) : '');
  setData(hud, 'kind', tier && ENCHANTED.has(tier) ? 'enchanted' : tier ? config?.catches?.[tier]?.kind ?? '' : '');
  setText($('#fishingMult', hud), times(x100));
  setText($('#fishingDepth', hud), status === 'idle' ? '' : `${depthAt(x100)} blocks down · ${zoneAt(x100).name}`);
  const gain = $('#fishingGain', hud);
  const statusNode = $('#fishingStatus', hud);
  const next = ladder().find((step) => step.fromX100 > x100);
  let line = '';
  if (status === 'waiting') line = 'The lure goes under…';
  else if (status === 'climbing') line = next ? `${catchName(tier)} on the hook · ${catchName(next.id)} at ${times(next.fromX100)}` : `${catchName(tier)} on the hook`;
  else if (status === 'landed') line = 'Reeled up!';
  else if (status === 'snapped') line = `${cutAt(x100)}!`;
  else line = 'Cast, and reel up before something cuts the line';
  if (statusNode.textContent !== line) statusNode.textContent = line;
  const pay = round && (status === 'climbing' || status === 'landed') ? money(Number((round.stake * BigInt(x100)) / 100n)) : '';
  if (gain.textContent !== pay) gain.textContent = pay;
}

/** A new depth: its name across the sea for a moment, as the game titles a place. */
function announceZone(zone, x100) {
  const node = root && $('#fishingZone', root);
  if (!node) return;
  $('b', node).textContent = zone.name;
  $('span', node).textContent = `${depthAt(x100)} blocks down`;
  node.dataset.zone = zone.id;
  node.hidden = false;
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
  clearTimeout(announceZone.timer);
  announceZone.timer = setTimeout(() => { node.hidden = true; }, 2400);
  playSound('chime', { rate: 0.6 });
}

/** The catch ladder down the side of the sea, shallowest first: each rung's catch, lit as the lure passes it. */
function buildLadder() {
  const list = $('#fishingLadder', root);
  if (!list || list.dataset.built === '1') return;
  list.dataset.built = '1';
  list.innerHTML = ladder().map((step) => `
    <li data-id="${step.id}" data-state="ahead" data-kind="${ENCHANTED.has(step.id) ? 'enchanted' : config.catches[step.id]?.kind ?? 'fish'}">
      <span class="fishing__rung"><img src="${icon(step.id)}" alt="" /></span><b>${times(step.fromX100)}</b><span class="fishing__rungname">${catchName(step.id)}, ${depthAt(step.fromX100)} blocks down</span>
    </li>`).join('');
}
function paintLadder(tier, rose) {
  const at = tierIndex(tier);
  for (const item of root.querySelectorAll('#fishingLadder li')) {
    const index = tierIndex(item.dataset.id);
    item.dataset.state = tier === null ? 'ahead' : index < at ? 'passed' : index === at ? 'on' : 'ahead';
    if (index === at && rose && !reduceMotion()) {
      item.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
  }
}

/** The catch, as the game shows an item: its sprite in a slot, its name in its rarity's colour. */
function showCatch(cast, stake) {
  const card = $('#fishingCatch', root);
  const paid = BigInt(cast.payoutMinor);
  const x = cast.landedX100 / 100;
  card.dataset.kind = cast.catch.kind;
  card.dataset.result = 'landed';
  card.dataset.enchanted = ENCHANTED.has(cast.catch.id) ? '1' : '0';
  card.dataset.tone = x >= BIG ? 'big' : 'win';
  $('img', card).src = icon(cast.catch.id);
  $('.fishing__catchname', card).textContent = cast.catch.name;
  $('.fishing__catchkind', card).textContent = `${zoneAt(cast.landedX100).name} · ${times(cast.landedX100)}`;
  $('.fishing__catchpay', card).textContent = `+${money(Number(paid - stake))} · ${money(Number(paid))}`;
  card.hidden = false;
}

function showSnap(cast, stake) {
  const card = $('#fishingCatch', root);
  card.dataset.kind = 'junk';
  card.dataset.result = 'snapped';
  card.dataset.enchanted = '0';
  card.dataset.tone = 'none';
  $('img', card).src = icon('string');
  $('.fishing__catchname', card).textContent = cast.snapX100 <= 100 ? 'Cut as it went under' : `Cut at ${times(cast.snapX100)}`;
  $('.fishing__catchkind', card).textContent = cutAt(cast.snapX100);
  $('.fishing__catchpay', card).textContent = `−${money(Number(stake))}`;
  card.hidden = false;
}

/** The title screen's splash text over the sea, for a catch or a cut. */
function splash(text, tone) {
  const node = root && $('#fishingSplash', root);
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = false;
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
  clearTimeout(splash.timer);
  splash.timer = setTimeout(() => { node.hidden = true; }, 1700);
}

function hideCatch() {
  const card = root && $('#fishingCatch', root);
  if (card) card.hidden = true;
}

/* One polite, whole sentence per event. */
function say(text) {
  const node = $('#fishingSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── how it works ─────────── */

function paytableHtml() {
  if (!config) return '<p class="fishpay__sub">The ladder loads with the sea.</p>';
  const rtp = ((10_000 - config.houseEdgeBps) / 100).toFixed(0);
  const holds = (x100) => `${Math.min(100, (100 - config.houseEdgeBps / 100) / (x100 / 100)).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  const rows = ladder().map((step) => `
      <tr data-kind="${config.catches[step.id]?.kind ?? 'fish'}">
        <th scope="row"><span class="fishpay__item"><img src="${icon(step.id)}" alt="" /><span>${catchName(step.id)}</span></span></th>
        <td>${zoneAt(step.fromX100).name}</td>
        <td><b>${times(step.fromX100)}</b></td>
        <td><b>${holds(step.fromX100)}</b></td>
      </tr>`).join('');
  const pace = SINKERS.map((s) => `${s.label} ${(Math.log(2) / config.growth[s.id]).toFixed(1)} s`).join(' · ');
  return `
      <p class="fishpay__sub">Cast, and the lure goes down: past the reef and the kelp, a shipwreck, an ocean monument and the abyss, to an ancient city. The deeper it goes, the higher the multiplier, from 1.00×. Reel up whenever you like for your stake times the multiplier. Go too deep and something down there cuts the line, and the stake is lost: a drowned in the upper waters, a guardian round the monument and in the abyss, the warden in the city. It works like Crash, on a fishing line.</p>
      <p class="fishpay__sub">The deeper the lure, the rarer the catch on it: what it pays is always the multiplier you reel up at.</p>
      <div class="fishpay__scroll">
        <table class="fishpay__table">
          <thead><tr><th scope="col">On the hook</th><th scope="col">Down in</th><th scope="col">From</th><th scope="col">Line holds that far</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="fishpay__sub">The sinker is the pace, the odds are the same with all three: to 2× takes ${pace}. Set an auto reel and the line comes up there by itself. The line goes no deeper than 1000×; it is cut as the lure goes under about one cast in nine.</p>
      <p class="fishpay__sub">Every cast returns at most ${rtp}% over the long run, whenever you reel up. Where the line is cut is drawn from your fairness seed the moment you cast and revealed when the cast ends; check any cast on the Fairness page.</p>`;
}

function openPaytable() {
  openModal('Fishing: how it works', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'fishpay';
    wrap.innerHTML = paytableHtml();
    body.append(wrap);
  });
}

/* ─────────── building ─────────── */

function build() {
  const remembered = globalThis.DonutPrefs?.get?.().fishSinker;
  if (SINKERS.some((s) => s.id === remembered)) sinker = remembered;
  root.dataset.render = '2d';
  root.dataset.sinker = sinker;
  root.dataset.zone = 'shallows';
  root.dataset.under = '0';
  root.innerHTML = `
    <section class="fishing__stage" aria-label="The sea">
      <div class="fishing__pond">
        <div class="fishing__flat" data-state="idle" aria-hidden="true">
          <i class="fishing__flatdock"></i>
          <img class="fishing__flatrod" src="assets/img/items/fishing_rod_cast.png" alt="" />
          <img class="fishing__flatbobber" src="assets/img/entity/fishing_hook.png" alt="" />
          <img class="fishing__flatcatch" src="" alt="" />
        </div>
        <div class="fishing__hud" id="fishingHud" data-state="idle">
          <p class="fishing__mult"><b id="fishingMult">1.00×</b><span id="fishingGain"></span></p>
          <p class="fishing__depth" id="fishingDepth"></p>
          <p class="fishing__status" id="fishingStatus">Cast, and reel up before something cuts the line</p>
        </div>
        <ol class="fishing__recent" id="fishingRecent" aria-label="Recent casts"></ol>
        <ol class="fishing__ladder" id="fishingLadder" aria-label="The catch ladder, shallowest first"></ol>
        <p class="fishing__zone" id="fishingZone" aria-hidden="true" hidden><b></b><span></span></p>
        <p class="fishing__splash" id="fishingSplash" aria-hidden="true" hidden></p>
        <div class="fishing__catch" id="fishingCatch" hidden>
          <span class="fishing__slot"><img src="" alt="" /></span>
          <span class="fishing__catchtxt">
            <b class="fishing__catchname"></b>
            <span class="fishing__catchkind"></span>
            <span class="fishing__catchpay"></span>
          </span>
        </div>
      </div>
    </section>

    <aside class="fishing__panel" aria-label="Your cast">
      <form class="fishing__form" id="fishingForm" novalidate>
        <label class="fishing__label" for="fishingStake">Stake</label>
        <div class="fishing__field">
          <span aria-hidden="true">$</span>
          <input id="fishingStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="fishing__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="fishing__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="fishing__label" id="fishingSinkerLabel">Sinker</span>
        <div class="fishing__sinkers" role="radiogroup" aria-labelledby="fishingSinkerLabel">
          ${SINKERS.map((s) => `
          <button class="fishing__sinker" type="button" role="radio" data-sinker="${s.id}" aria-checked="false">
            <b>${s.label}</b><span class="fishing__sinkernote">${s.note}</span><span class="fishing__sinkertop"></span>
          </button>`).join('')}
        </div>
        <label class="fishing__label" for="fishingAutoX">Auto reel at</label>
        <div class="fishing__field fishing__field--x">
          <input id="fishingAutoX" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Off" />
          <span aria-hidden="true">×</span>
        </div>
        <button class="btn fishing__go" id="fishingGo" type="submit" data-tone="go">
          <span id="fishingGoLabel">Loading…</span>
        </button>
        <div class="fishing__toggles">
          <button class="fishing__toggle" id="fishingAuto" type="button" aria-pressed="false">Auto cast</button>
          <button class="fishing__paytable" id="fishingPaytable" type="button">How it works</button>
        </div>
        <p class="fishing__hint" id="fishingHint" aria-live="polite"></p>
        <dl class="fishing__stats">
          <div><dt>Casts</dt><dd id="fishingCasts"></dd></div>
          <div><dt>Won</dt><dd id="fishingWon"></dd></div>
          <div><dt>Best</dt><dd id="fishingBest"></dd></div>
        </dl>
        <span class="fishing__label">Last casts</span>
        <ol class="fishing__log" id="fishingLog"></ol>
        <p class="fishing__logempty" id="fishingLogEmpty">Nothing caught yet.</p>
        <label class="fishing__gfx" for="fishingGfx">
          <span>Graphics</span>
          <select id="fishingGfx">${GRAPHICS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="fishing__say" id="fishingSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#fishingStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  const autoInput = $('#fishingAutoX', root);
  autoInput.value = autoText;
  autoInput.addEventListener('input', () => { autoText = autoInput.value; paint(); });
  root.querySelectorAll('.fishing__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paint();
  }));
  const group = $('.fishing__sinkers', root);
  group.addEventListener('click', (event) => {
    const button = event.target.closest('.fishing__sinker');
    if (button) setSinker(button.dataset.sinker);
  });
  // A radio group moves with the arrow keys.
  group.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || phase !== 'idle') return;
    event.preventDefault();
    const index = SINKERS.findIndex((s) => s.id === sinker);
    const next = SINKERS[(index + step + SINKERS.length) % SINKERS.length].id;
    setSinker(next);
    $(`.fishing__sinker[data-sinker="${next}"]`, root)?.focus();
  });
  $('#fishingGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  // The one button: Cast, then Reel up.
  $('#fishingForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (phase === 'climbing') void landNow();
    else void cast();
  });
  $('#fishingAuto', root).addEventListener('click', () => {
    auto = !auto;
    paintControls();
    if (auto && phase === 'idle') void cast();
    else if (!auto) clearTimeout(nextTimer);
  });
  $('#fishingPaytable', root).addEventListener('click', openPaytable);

  /* Space casts, and reels up what is on the line, but only on this page and never while typing or
   * on a control (a focused button already answers Space itself). */
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || !view || view.hidden || event.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) return;
    event.preventDefault();
    if (phase === 'climbing') void landNow();
    else void cast();
  });
  // Auto-cast never runs on a page nobody is looking at.
  onNavigate(() => {
    if (view?.hidden) stopAuto();
  });
}

export function mountFishing(section) {
  view = section;
  root = $('#fishingRoot', section);
  if (!root) return;
  // A fresh page's fields start enabled, whatever the last one was left at.
  paintControls.idle = undefined;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments a seed can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (phase === 'idle') void load();
        return;
      }
      if (event.detail === 'logout') {
        stopAuto();
        seedHash = null;
        log = [];
      }
      if (phase === 'idle') paint();
    });
  }
  void load();
}
