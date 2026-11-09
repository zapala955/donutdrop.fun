/* plinko.js — a ball, a triangle of pegs, and a row of slots that pay more the further out they sit.
 *
 * The server owns every ball. One request places the bet, draws the path from the player's
 * committed fairness seed and pays the slot; this page animates a result that already exists, bounce
 * for bounce along the path it was given. Balls are sent one after another -- each answer carries
 * the commitment the next ball must be sent against -- but they fall together, so a player can keep
 * dropping while earlier balls are still in the air.
 *
 * The wallet pill does not jump ahead of the balls. While any ball is falling the live polls are
 * held, and the pill shows the server's balance less the payouts still in the air, adding each one
 * as its ball lands.
 *
 * Motion: the ball's fall, a peg lighting as it is struck, a slot dipping as a ball lands. With
 * reduced motion a ball lands the moment it is answered, and nothing moves.
 *
 * The flat board (2D) is drawn here, on a canvas, in the look of a casino floor: white pegs that
 * ring when they are struck, a gold ball that hops from peg to peg as a thrown ball would (sideways
 * at an even pace, up and down under gravity) and squashes a little on each one, slots coloured
 * from yellow at the centre to red at the edges, a column of the last results by the board, and a
 * card over a slot with what it would pay and how likely it is. A win of 2x and up throws sparks
 * off its slot. The board has its own sounds: a tap per peg, rising as the ball falls, and a
 * landing that grows with the multiplier.
 *
 * The board is drawn in WebGL (plinko3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage: ender pearls through end rods into shulker boxes, in the End. This page still
 * moves every ball; the 3D board only draws them where it is told. The row of slots stays this page's
 * own, set under the boxes where the board says they stand; without WebGL the flat board is back.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, commitmentMoved, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, sceneLoaded, sceneLoading, setWants3d, viewSwitch, wants3d } from './view3d.js';

const RISKS = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const MAX_QUEUED = 4; // drops waiting for the server
const MAX_FALLING = 24; // balls on the board at once
const RECENT = 8;
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

/* The board in units of one peg gap. Peg row r (0-based, from the top) has r + 3 pegs; the slots sit
 * under the gaps of the last row, so a board of n rows is n + 2 gaps wide. */
const TOP = 1.1; // the first row's height
const ROW = 0.9; // the drop from one row to the next
const FOOT = 0.9; // the last row to the slots
const PEG_R = 0.1;
const BALL_R = 0.26;
/* The flat board's motion. */
const FLASH_MS = 420; // a struck peg's ring
const SQUASH_MS = 90; // the ball flattening on a peg
const INTRO_MS = 240; // each row of pegs fading in when the board changes shape
const HOP = 0.3; // how high the ball hops off a peg, in peg gaps
const HISTORY = 5; // results in the column by the flat board

let root = null;
let canvas = null;
let ctx = null;
let palette = null;
let config = null;
let seedHash = null;
let rows = 12;
let risk = 'medium';
let stakeText = '1m';
let queue = []; // [{ key, stakeMinor, rows, risk, release }]
let sending = false;
let balls = []; // falling: { bet, points, times, start, release, hit, landed }
let serverBalance = null; // the balance the server last confirmed, every payout sent so far included
let recent = []; // newest first: { slot, multiplierBps, payoutMinor, stakeMinor, rows }
let flashes = new Map(); // "r:j" -> the moment that peg was struck
let raf = 0;
let lastTick = 0;
let pendingSay = [];
let sayTimer = 0;
let boardRows = 0;
let slotsDense = false; // measured when the board's size changes, never while painting
let board3d = null; // the End, once it is up
let boardTried = null;
let sparks = []; // the flat board's win sparks: { x, y, vx, vy, born, life, size, lit }
let introAt = 0; // when the flat board last changed shape
let sprite = null; // the ball, drawn once per size: { radius, canvas }
let tipSlot = null; // the slot whose card is open
let lastLand = 0;

/* ─────────── numbers ─────────── */

const busy = () => queue.length > 0 || balls.length > 0;

function table(n = rows, level = risk) {
  return config?.multipliersBps?.[n]?.[level] ?? null;
}

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

/** The largest stake whose best slot still pays within the payout ceiling. */
function boardMaxStake(n = rows, level = risk) {
  const slots = table(n, level);
  if (!slots || !config) return 0n;
  const ceiling = (BigInt(config.maxPayoutMinor) * 10_000n) / BigInt(Math.max(...slots));
  const max = BigInt(config.maxStakeMinor);
  return ceiling < max ? ceiling : max;
}

/** Payouts already credited by the server for balls still falling, not yet shown to the player. */
function inAir() {
  return balls.reduce((sum, ball) => sum + BigInt(ball.bet.payoutMinor), 0n);
}

/**
 * What the next ball may stake: the balance the pill shows, less the balls waiting to be sent.
 *
 * The pill is the server's balance less the payouts still in the air. Counting from the server's
 * figure instead let a player stake a win their falling ball had not revealed yet: the server
 * rightly accepted it (the money is credited the moment the ball is placed), but the pill, still
 * holding that win back, went below zero, and being able to drop past the shown balance gave the
 * hidden result away. Spending is held back exactly as long as the figure is.
 */
function available() {
  const base = serverBalance === null ? BigInt(state.balanceMinor || '0') : serverBalance - inAir();
  return queue.reduce((left, drop) => left - drop.stakeMinor, base);
}

function dropProblem() {
  if (!config) return 'Plinko is not answering';
  if (!config.enabled) return 'Plinko is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest ball is ${money(Number(config.minStakeMinor))}`;
  const max = boardMaxStake();
  if (stake > max) return `The largest ball on this board is ${money(Number(max))}`;
  if (state.authenticated && stake > available()) return 'That is more than your balance';
  return '';
}

/** 911, 23.5, 1.8, 0.18 -- the multiplier as a slot prints it. `tight` drops the leading zero. */
function short(bps, tight = false) {
  const x = bps / 10_000;
  if (x >= 100) return String(Math.floor(x));
  if (x >= 10) return String(Math.floor(x * 10) / 10);
  const text = String(Math.floor(x * 100) / 100);
  return tight && x < 1 ? text.slice(1) : text;
}
const times = (bps) => `${short(bps)}×`;

/** How far out a slot sits, 0 at the centre to 1 at the edge -- its colour. */
function heat(slot, n) {
  return Math.pow(Math.abs(slot - n / 2) / (n / 2), 1.3);
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/plinko/config');
  } catch {
    config = null;
  }
  if (state.authenticated) await refreshSeed();
  buildSlots();
  resize();
  paint();
  if (config) void startBoard();
  else sceneLoaded(root);
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

function drop() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (dropProblem() || queue.length >= MAX_QUEUED || queue.length + balls.length >= MAX_FALLING) return;
  if (serverBalance === null) serverBalance = BigInt(state.balanceMinor || '0');
  /* Held from the click, not from the answer: a poll landing between the two would print this
   * ball's stake and payout before the ball exists. */
  queue.push({ key: idempotencyKey(), stakeMinor: stakeMinor(), rows, risk, release: holdLiveFigures() });
  paint();
  void pump();
}

/* One request at a time, each against the commitment the last one handed back. */
async function pump() {
  if (sending) return;
  sending = true;
  paintControls();
  try {
    while (queue.length) {
      const next = queue[0];
      try {
        const response = await send(next);
        queue.shift();
        seedHash = response.nextServerSeedHash || null;
        commitmentMoved(response.nextServerSeedHash);
        serverBalance = BigInt(response.balanceMinor);
        launch(response.bet, next.release);
      } catch (error) {
        // This ball and every one behind it stay in the hand; nothing was taken for them.
        for (const waiting of queue) waiting.release();
        queue = [];
        if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
        toast({ kind: 'lose', title: 'Plinko', body: error?.message || 'That ball did not drop' });
      }
      paintControls();
    }
  } finally {
    sending = false;
    settleIfDone();
    paint();
  }
}

async function send(next) {
  if (!seedHash) await refreshSeed();
  const body = () => ({
    stakeMinor: next.stakeMinor.toString(),
    rows: next.rows,
    risk: next.risk,
    clientSeed: clientSeed(),
    serverSeedHash: seedHash,
  });
  try {
    return await api.post('/v1/plinko/bets', body(), { idempotencyKey: next.key });
  } catch (error) {
    /* The commitment moved (another tab played something): pick up the new one and go again under a
     * new key, since the request itself is now a different one. */
    if (error?.code !== 'FAIRNESS_COMMITMENT_CHANGED') throw error;
    await refreshSeed();
    next.key = idempotencyKey();
    return api.post('/v1/plinko/bets', body(), { idempotencyKey: next.key });
  }
}

/* ─────────── the balls ─────────── */

/** The ball's course in board units: the drop onto the top peg, one contact per row, the slot. */
function course(path, n) {
  const mid = (n + 2) / 2;
  const points = [{ x: mid + (Math.random() - 0.5) * 0.12, y: TOP - 0.8 }];
  let rights = 0;
  for (let r = 0; r < n; r += 1) {
    points.push({ x: mid + (1 + rights - (r + 2) / 2), y: TOP + r * ROW - PEG_R - BALL_R, peg: `${r}:${1 + rights}` });
    rights += path[r];
  }
  points.push({ x: 1 + rights, y: TOP + (n - 1) * ROW + FOOT - BALL_R });
  return points;
}

/**
 * The same course on the flat board, where the ball meets each peg on its shoulder rather than
 * dead on top: on the side it is about to fall to, a little over twenty degrees round.
 */
function flatCourse(points, path) {
  return points.map((point, i) => {
    if (!point.peg) return point;
    const angle = (0.38 + Math.random() * 0.14) * (path[i - 1] ? 1 : -1);
    const reach = PEG_R + BALL_R;
    return { x: point.x + reach * Math.sin(angle), y: point.y + reach * (1 - Math.cos(angle)) };
  });
}

function launch(bet, release) {
  const n = bet.rows;
  const points = course(bet.path, n);
  const ball = { bet, release, landed: false, points, flat: flatCourse(points, bet.path), hop: HOP * (0.85 + Math.random() * 0.3), start: performance.now(), hit: 0 };
  /* One time per point: the start, the top peg, each row after it, the slot. */
  const hop = Math.min(170, Math.max(115, 2000 / n));
  ball.times = [0, 300];
  for (let r = 2; r <= n; r += 1) ball.times.push(ball.times[r - 1] + hop);
  ball.times.push(ball.times[n] + hop * 1.25);
  balls.push(ball);
  showFalling();
  if (reduceMotion() || bet.rows !== boardRows) {
    land(ball);
    return;
  }
  run();
}

function positionOf(ball, elapsed) {
  const { points, times } = ball;
  let i = 1;
  while (i < times.length - 1 && elapsed > times[i]) i += 1;
  const a = points[i - 1];
  const b = points[i];
  const t = Math.min(1, Math.max(0, (elapsed - times[i - 1]) / (times[i] - times[i - 1])));
  if (i === 1) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t * t };
  // Knocked sideways off the peg, a short lift, then falling onto the next one.
  return {
    x: a.x + (b.x - a.x) * (1 - (1 - t) * (1 - t)),
    y: a.y + (b.y - a.y) * t * t - 0.22 * 4 * t * (1 - t),
  };
}

/**
 * Where the flat board draws a ball: the drop onto the top peg falls under gravity; every hop after
 * it travels sideways at an even pace and up and down on a parabola, as a thrown ball does.
 */
function flatPosition(ball, elapsed) {
  const { flat, times } = ball;
  let i = 1;
  while (i < times.length - 1 && elapsed > times[i]) i += 1;
  const a = flat[i - 1];
  const b = flat[i];
  const t = Math.min(1, Math.max(0, (elapsed - times[i - 1]) / (times[i] - times[i - 1])));
  if (i === 1) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t * t };
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - ball.hop * 4 * t * (1 - t) };
}

function run() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  for (const ball of balls) {
    const elapsed = now - ball.start;
    // Every peg this ball has reached lights, and the newest one ticks.
    while (ball.hit + 1 < ball.points.length - 1 && elapsed >= ball.times[ball.hit + 1]) {
      ball.hit += 1;
      flashes.set(ball.points[ball.hit].peg, now);
      board3d?.strike(ball.points[ball.hit].peg);
      if (now - lastTick > 45) {
        lastTick = now;
        // The flat board's tap climbs as the ball falls; the End keeps its click.
        if (board3d) playSound('reeltick');
        else playSound('pegtap', { rate: 0.9 + (0.55 * ball.hit) / ball.bet.rows + (Math.random() - 0.5) * 0.06 });
      }
    }
    if (elapsed >= ball.times[ball.times.length - 1]) land(ball);
  }
  for (const [peg, at] of flashes) if (now - at > FLASH_MS) flashes.delete(peg);
  sparks = sparks.filter((spark) => now - spark.born < spark.life);
  draw(now);
  if (balls.length || flashes.size || sparks.length || now - introAt < INTRO_MS + boardRows * 16) run();
}

function land(ball) {
  if (ball.landed) return;
  ball.landed = true;
  balls = balls.filter((other) => other !== ball);
  ball.release();
  const { bet } = ball;
  showFalling();
  recent.unshift({ slot: bet.slot, rows: bet.rows, multiplierBps: bet.multiplierBps, payoutMinor: bet.payoutMinor, stakeMinor: bet.stakeMinor });
  recent = recent.slice(0, RECENT);
  bump(bet.slot);
  board3d?.land(bet.slot, bet.multiplierBps);
  const x = bet.multiplierBps / 10_000;
  if (board3d) playSound(x >= 10 ? 'reward' : x >= 1 ? 'win' : 'coin');
  else landFlat(bet, x);
  queueSay(bet);
  settleIfDone();
  paintReadout();
  shiftHistory();
  paintControls();
  if (!raf) draw(performance.now());
}

/** The flat board's landing: a sound that grows with the multiplier, and sparks off a win. */
function landFlat(bet, x) {
  const now = performance.now();
  // A burst of balls landing together is one sound, not a pile of them; a win always speaks.
  if (x >= 2 || now - lastLand > 60) {
    lastLand = now;
    const cue = x >= 100 ? 'jackpot' : x >= 10 ? 'plinkoBig' : x >= 2 ? 'plinkoWin' : x >= 1 ? 'plinkoEven' : 'plinkoLow';
    playSound(cue, { rate: x < 2 ? 0.92 + heat(bet.slot, bet.rows) * 0.25 : 1 });
  }
  if (x < 2 || reduceMotion() || bet.rows !== boardRows) return;
  const count = x >= 100 ? 40 : x >= 10 ? 24 : 12;
  const depth = TOP + (bet.rows - 1) * ROW + FOOT;
  for (let k = 0; k < count; k += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
    const speed = 2.2 + Math.random() * (x >= 10 ? 4.2 : 2.6);
    sparks.push({
      x: bet.slot + 1 + (Math.random() - 0.5) * 0.6,
      y: depth - 0.05,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      born: now,
      life: 520 + Math.random() * 380,
      size: 0.035 + Math.random() * 0.045,
      lit: Math.random() < 0.35,
    });
  }
  run();
}

/** The column of results by the flat board slides down one place for the newest. */
function shiftHistory() {
  const list = root && $('#plinkoRecent', root);
  if (!list || reduceMotion()) return;
  list.classList.remove('is-shift');
  requestAnimationFrame(() => list.classList.add('is-shift'));
}

/** The pill: the server's balance less every payout still in the air. */
function showFalling() {
  if (serverBalance === null) return;
  /* Never below zero. available() keeps it there for balls dropped here; another tab spending the
   * same wallet meanwhile could still undercut it, and a wallet cannot be negative (the database
   * refuses it), so neither may its figure. */
  const shown = serverBalance - inAir();
  showBalance((shown < 0n ? 0n : shown).toString());
}

function settleIfDone() {
  if (busy() || sending) return;
  serverBalance = null;
  void refreshBalance();
}

function bump(slot) {
  const node = root?.querySelector(`.plinko__slot[data-slot="${slot}"]`);
  if (!node) return;
  // The light starts again on the next frame rather than by forcing a layout now: a burst of balls
  // landing was a burst of synchronous layouts on a slow machine.
  node.classList.remove('is-hit');
  requestAnimationFrame(() => node.classList.add('is-hit'));
  if (reduceMotion()) return;
  // `translate`, not `transform`: a slot standing its number on end is already rotated.
  node.animate(
    [{ translate: '0 0' }, { translate: '0 5px', offset: 0.35 }, { translate: '0 0' }],
    { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
}

/* One polite sentence for a burst of balls, not one per ball. */
function queueSay(bet) {
  pendingSay.push(bet);
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    const landed = pendingSay;
    pendingSay = [];
    const node = $('#plinkoSay', root);
    if (!node || !landed.length) return;
    let text;
    if (landed.length === 1) {
      const [one] = landed;
      text = `Landed on ${times(one.multiplierBps)}. Paid ${money(Number(one.payoutMinor))}.`;
    } else {
      const net = landed.reduce((sum, one) => sum + BigInt(one.payoutMinor) - BigInt(one.stakeMinor), 0n);
      const best = Math.max(...landed.map((one) => one.multiplierBps));
      text = `${landed.length} balls landed, best ${times(best)}, ${net >= 0n ? 'up' : 'down'} ${money(Number(net >= 0n ? net : -net))}.`;
    }
    node.textContent = '';
    requestAnimationFrame(() => { node.textContent = text; });
  }, 500);
}

/* ─────────── the End ─────────── */

function startBoard() {
  if (boardTried || !wants3d()) return boardTried;
  boardTried = (async () => {
    const host = $('.plinko__view', root);
    sceneLoading(root, host);
    try {
      const { createPlinko3d } = await import('./plinko3d.js');
      const built = await createPlinko3d(host);
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        boardTried = null;
        return;
      }
      if (!built) {
        // No WebGL here: the flat board is all there is, and its graphics have nothing to choose.
        $('.plinko__gfx', root).hidden = true;
        return;
      }
      built.onLost = () => {
        if (board3d === built) board3d = null;
        built.dispose();
        root.dataset.render = '2d';
        resize();
      };
      // The slots sit under the shulker boxes, wherever the board's camera has put them.
      built.onLayout = ({ left, width }) => {
        const holder = $('#plinkoSlots', root);
        holder.style.setProperty('--row-left', `${left.toFixed(1)}px`);
        holder.style.setProperty('--row-width', `${width.toFixed(1)}px`);
        measureSlots();
        paintSlots();
      };
      built.onCue = (cue) => {
        if (cue === 'teleport') playSound('portal', { rate: 1.8 });
      };
      board3d = built;
      root.dataset.render = '3d';
      board3d.setBoard(boardRows || rows);
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    } finally {
      sceneLoaded(root);
    }
  })();
  return boardTried;
}

function setGraphics(value) {
  if (busy() || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (board3d) {
    board3d.dispose();
    board3d = null;
    boardTried = null;
    root.dataset.render = '2d';
    resize();
    if (config) void startBoard();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the board away for the flat board, 3D builds it again. */
function setView(on) {
  if (busy()) {
    // Switched somewhere else in the middle of a round: followed once the round lets go.
    if (on === wants3d()) setTimeout(() => setView(wants3d()), 600);
    paintGraphics();
    return;
  }
  if (on !== wants3d()) {
    setWants3d(on);
    playSound('click');
  }
  if (!on) sceneLoaded(root);
  if (!on && board3d) {
    board3d.dispose();
    board3d = null;
    boardTried = null;
    root.dataset.render = '2d';
    resize();
  }
  if (on && config) void startBoard();
  paintGraphics();
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#plinkoView', root), { disabled: Boolean(busy()) });
  const select = root && $('#plinkoGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = board3d?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
  select.disabled = busy();
}

/* ─────────── the board ─────────── */

function readPalette() {
  const style = getComputedStyle(root);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  palette = {
    peg: token('--plinko-peg', '#d9dbe0'),
    pegLit: token('--plinko-peg-lit', '#ffffff'),
    ring: token('--plinko-ring', '#f0c35a'),
    ballHi: token('--plinko-ball-hi', '#fff6c8'),
    ball: token('--plinko-ball', '#ffd700'),
    ballLo: token('--plinko-ball-lo', '#a35f00'),
    glow: token('--plinko-glow', 'rgba(255, 196, 64, .5)'),
    spark: token('--plinko-spark', '#f0c35a'),
    sparkLit: token('--plinko-spark-lit', '#ffffff'),
  };
  sprite = null;
}

/** A struck peg's glow: light at the peg fading to nothing, drawn once per peg size. */
function haloSprite(pegR) {
  if (sprite?.halo?.pegR === pegR) return sprite.halo.canvas;
  const size = Math.ceil(pegR * 9);
  const art = document.createElement('canvas');
  art.width = size;
  art.height = size;
  const g = art.getContext('2d');
  const c = size / 2;
  const light = g.createRadialGradient(c, c, 0, c, c, c);
  light.addColorStop(0, palette.pegLit);
  light.addColorStop(0.18, palette.ring);
  light.addColorStop(0.42, palette.glow);
  light.addColorStop(1, 'rgba(255, 190, 60, 0)');
  g.fillStyle = light;
  g.fillRect(0, 0, size, size);
  sprite = { ...(sprite || {}), halo: { pegR, canvas: art } };
  return art;
}

/** The ball, glow and all, drawn once for its size and stamped for every ball after. */
function ballSprite(radius) {
  if (sprite?.radius === radius && sprite.canvas) return sprite.canvas;
  const pad = Math.ceil(radius * 0.9);
  const size = Math.ceil(radius * 2) + pad * 2;
  const art = document.createElement('canvas');
  art.width = size;
  art.height = size;
  const g = art.getContext('2d');
  const c = size / 2;
  const halo = g.createRadialGradient(c, c, radius * 0.6, c, c, radius + pad);
  halo.addColorStop(0, palette.glow);
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);
  const body = g.createRadialGradient(c - radius * 0.35, c - radius * 0.4, radius * 0.08, c, c, radius);
  body.addColorStop(0, palette.ballHi);
  body.addColorStop(0.42, palette.ball);
  body.addColorStop(1, palette.ballLo);
  g.beginPath();
  g.arc(c, c, radius, 0, Math.PI * 2);
  g.fillStyle = body;
  g.fill();
  sprite = { ...(sprite || {}), radius, canvas: art };
  return art;
}

function resize() {
  if (!canvas) return;
  const n = rows;
  if (boardRows !== n) {
    // A new shape: its rows of pegs fade in from the top (flat board only).
    introAt = reduceMotion() ? 0 : performance.now();
    run();
  }
  boardRows = n;
  const wrap = canvas.closest('.plinko__board');
  wrap.style.setProperty('--gaps', String(n + 2));
  wrap.style.setProperty('--depth', String(TOP + (n - 1) * ROW + FOOT));
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  draw(performance.now());
  board3d?.setBoard(n);
  measureSlots();
  if ($('.plinko__slot', root)) paintSlots();
}

/** Whether the slots are too narrow for their numbers lying down: read when the size changes. */
function measureSlots() {
  const holder = root && $('#plinkoSlots', root);
  if (holder) slotsDense = holder.clientWidth / (rows + 1) < 26;
}

function draw(now) {
  if (board3d) {
    board3d.balls(balls.map((ball) => positionOf(ball, now - ball.start)));
    return;
  }
  if (!ctx || !canvas.width) return;
  if (!palette) readPalette();
  const n = boardRows;
  const unit = canvas.width / (n + 2);
  const mid = (n + 2) / 2;
  // Pegs drawn small and crisp, whatever the board's size: under a peg gap's tenth, at most 5.5 CSS px.
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  const pegR = Math.min(5.5 * dpr, Math.max(1.5 * dpr, 0.078 * unit));
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < n; r += 1) {
    // Each row fades in a beat after the one above it when the board changes shape.
    const shown = introAt ? Math.min(1, Math.max(0, (now - introAt - r * 16) / INTRO_MS)) : 1;
    if (shown <= 0) continue;
    const fade = 1 - (1 - shown) * (1 - shown);
    for (let j = 0; j < r + 3; j += 1) {
      const x = (mid + j - (r + 2) / 2) * unit;
      const y = (TOP + r * ROW) * unit;
      const struck = flashes.get(`${r}:${j}`);
      const t = struck === undefined ? 1 : Math.min(1, (now - struck) / FLASH_MS);
      if (t < 1) {
        // A struck peg lights up: a bright pulse that swells a little as it fades.
        const out = 1 - (1 - t) * (1 - t);
        const halo = haloSprite(pegR);
        const reach = (halo.width / 2) * (0.75 + 0.45 * out);
        ctx.globalAlpha = (1 - t) * (1 - t);
        ctx.drawImage(halo, x - reach, y - reach, reach * 2, reach * 2);
      }
      ctx.globalAlpha = fade;
      ctx.fillStyle = t < 0.4 ? palette.pegLit : palette.peg;
      ctx.beginPath();
      ctx.arc(x, y, t < 0.4 ? pegR * 1.15 : pegR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Sparks off a win: thrown up from the slot, falling back under gravity, fading as they go.
  for (const spark of sparks) {
    const s = (now - spark.born) / 1000;
    const life = (now - spark.born) / spark.life;
    if (life >= 1) continue;
    const x = (spark.x + spark.vx * s) * unit;
    const y = (spark.y + spark.vy * s + 4.5 * s * s) * unit;
    ctx.globalAlpha = 1 - life * life;
    ctx.fillStyle = spark.lit ? palette.sparkLit : palette.spark;
    ctx.beginPath();
    ctx.arc(x, y, spark.size * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const radius = Math.round(BALL_R * unit * 10) / 10;
  const art = ballSprite(radius);
  const half = art.width / 2;
  for (const ball of balls) {
    const elapsed = now - ball.start;
    const at = flatPosition(ball, elapsed);
    // Flattened for a moment on each peg it meets, rounding out again as it leaves.
    const since = ball.hit >= 1 ? elapsed - ball.times[ball.hit] : Infinity;
    const squash = since < SQUASH_MS ? 0.09 * (1 - since / SQUASH_MS) : 0;
    const w = half * (1 + squash);
    const h = half * (1 - squash);
    ctx.globalAlpha = Math.min(1, elapsed / 90);
    ctx.drawImage(art, at.x * unit - w, at.y * unit - h + (half - h) * 0.6, w * 2, h * 2);
  }
  ctx.globalAlpha = 1;
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  if (rows !== boardRows || !$('.plinko__slot', root)) {
    buildSlots();
    resize();
  }
  paintSlots();
  paintReadout();
  paintControls();
  paintGraphics();
}

function buildSlots() {
  const holder = $('#plinkoSlots', root);
  if (!holder) return;
  closeTip();
  holder.style.setProperty('--slots', String(rows + 1));
  holder.replaceChildren();
  for (let slot = 0; slot <= rows; slot += 1) {
    const node = document.createElement('span');
    node.className = 'plinko__slot';
    node.dataset.slot = String(slot);
    node.setAttribute('role', 'listitem');
    node.style.setProperty('--heat', heat(slot, rows).toFixed(3));
    // The flat board's slots arrive from the centre outwards (plinko.css).
    node.style.setProperty('--d', `${Math.round(Math.abs(slot - rows / 2) * 22)}ms`);
    holder.appendChild(node);
  }
}

function paintSlots() {
  const slots = table();
  const holder = $('#plinkoSlots', root);
  holder.toggleAttribute('data-dense', slotsDense);
  root.querySelectorAll('.plinko__slot').forEach((node, slot) => {
    const bps = slots?.[slot];
    const text = bps ? short(bps, slotsDense) : '—';
    if (node.textContent !== text) node.textContent = text;
    node.setAttribute('aria-label', bps ? `${times(bps)}, ${percent(chance(rows, slot))} chance` : 'unavailable');
  });
  paintTip();
}

/** How likely a ball is to land in `slot` of an `n`-row board: C(n, slot) / 2^n. */
function chance(n, slot) {
  let ways = 1;
  for (let i = 1; i <= slot; i += 1) ways = (ways * (n - slot + i)) / i;
  return ways / 2 ** n;
}
function percent(p) {
  const value = p * 100;
  const text = value >= 10 ? value.toFixed(1) : value >= 0.1 ? value.toFixed(2) : value.toPrecision(2);
  return `${text}%`;
}

/* ─────────── the slot card (flat board) ─────────── */

/** The card's words: what this slot pays on the stake in the field, and how often it is hit. */
function paintTip() {
  const tip = root && $('#plinkoTip', root);
  if (!tip) return;
  const bps = tipSlot === null ? undefined : table()?.[tipSlot];
  if (!bps) {
    tip.hidden = true;
    return;
  }
  const stake = stakeMinor() ?? 0n;
  const profit = (stake * BigInt(bps)) / 10_000n - stake;
  const won = profit >= 0n;
  const profitText = `${won ? '+' : '−'}${money(Number(won ? profit : -profit))}`;
  $('#plinkoTipMult', tip).textContent = times(bps);
  const profitNode = $('#plinkoTipProfit', tip);
  profitNode.textContent = profitText;
  profitNode.dataset.tone = won ? 'won' : 'lost';
  $('#plinkoTipChance', tip).textContent = percent(chance(rows, tipSlot));
  tip.hidden = false;
}

/** Opens the card over `slot`, kept inside the board's edges, its arrow still on the slot. */
function openTip(slot) {
  const node = root?.querySelector(`.plinko__slot[data-slot="${slot}"]`);
  const tip = root && $('#plinkoTip', root);
  if (!node || !tip) return;
  tipSlot = slot;
  paintTip();
  if (tip.hidden) return;
  const board = tip.offsetParent || tip.parentElement;
  const box = board.getBoundingClientRect();
  const cell = node.getBoundingClientRect();
  const centre = cell.left + cell.width / 2 - box.left;
  const half = tip.offsetWidth / 2;
  const left = Math.min(box.width - half - 4, Math.max(half + 4, centre));
  tip.style.setProperty('--tip-x', `${left.toFixed(1)}px`);
  tip.style.setProperty('--tip-arrow', `${(centre - left).toFixed(1)}px`);
  tip.style.setProperty('--tip-y', `${(box.bottom - cell.top + 10).toFixed(1)}px`);
  root.querySelectorAll('.plinko__slot.is-pointed').forEach((other) => other.classList.remove('is-pointed'));
  node.classList.add('is-pointed');
}

function closeTip() {
  tipSlot = null;
  root?.querySelectorAll('.plinko__slot.is-pointed').forEach((node) => node.classList.remove('is-pointed'));
  const tip = root && $('#plinkoTip', root);
  if (tip) tip.hidden = true;
}

function paintReadout() {
  const last = $('#plinkoLast', root);
  const top = recent[0];
  if (top) {
    const profit = BigInt(top.payoutMinor) - BigInt(top.stakeMinor);
    last.textContent = `${times(top.multiplierBps)} · ${profit >= 0n ? '+' : '−'}${money(Number(profit >= 0n ? profit : -profit))}`;
    last.dataset.tone = profit >= 0n ? 'won' : 'lost';
  } else {
    const slots = table();
    last.textContent = slots ? `Up to ${times(Math.max(...slots))}` : '—';
    last.dataset.tone = '';
  }
  const list = $('#plinkoRecent', root);
  list.style.setProperty('--shown', String(HISTORY));
  const chips = recent.map((one) => {
    const chip = document.createElement('li');
    chip.className = 'plinko__chip';
    chip.style.setProperty('--heat', heat(one.slot, one.rows).toFixed(3));
    chip.textContent = times(one.multiplierBps);
    return chip;
  });
  list.replaceChildren(...chips);
}

function paintControls() {
  const go = $('#plinkoGo', root);
  const label = $('#plinkoGoLabel', root);
  const hint = $('#plinkoHint', root);
  const problem = state.authenticated ? dropProblem() : '';
  const full = queue.length >= MAX_QUEUED || queue.length + balls.length >= MAX_FALLING;
  const text = !state.authenticated
    ? 'Log in to play'
    : `Drop · ${money(Number(stakeMinor() ?? 0n))}`;
  if (label.textContent !== text) label.textContent = text;
  go.disabled = state.authenticated && (Boolean(problem) || full || !config);
  go.setAttribute('aria-busy', String(sending));
  hint.textContent = problem;

  // The board's shape and its payouts stay put while balls are on it.
  const locked = busy();
  root.querySelectorAll('.plinko__risk').forEach((node) => {
    node.disabled = locked;
    node.setAttribute('aria-pressed', String(node.dataset.risk === risk));
  });
  // The risk switch's gold pill slides under the one that is chosen.
  $('.plinko__risks', root).style.setProperty('--risk-i', String(Math.max(0, RISKS.findIndex(([value]) => value === risk))));
  $('#plinkoRows', root).textContent = String(rows);
  const range = $('#plinkoRowsRange', root);
  const min = config?.minRows ?? 8;
  const max = config?.maxRows ?? 16;
  if (range.min !== String(min)) range.min = String(min);
  if (range.max !== String(max)) range.max = String(max);
  if (range.value !== String(rows)) range.value = String(rows);
  range.disabled = locked;
  range.style.setProperty('--fill', `${(((rows - min) / Math.max(1, max - min)) * 100).toFixed(2)}%`);
  paintTip();
  paintGraphics();
  const falling = $('#plinkoFalling', root);
  const inAir = balls.length + queue.length;
  falling.textContent = inAir ? `${inAir} ball${inAir === 1 ? '' : 's'} falling` : '';
}

/* ─────────── building ─────────── */

function build() {
  root.innerHTML = `
    <section class="plinko__stage" aria-label="The board">
      <div class="plinko__readout">
        <b id="plinkoLast" data-tone="">—</b>
        <ol class="plinko__recent" id="plinkoRecent" aria-label="Your last balls, newest first"></ol>
      </div>
      <div class="plinko__board">
        <div class="plinko__view"><canvas id="plinkoCanvas" aria-hidden="true"></canvas></div>
        <div class="plinko__slots" id="plinkoSlots" role="list" aria-label="What each slot pays, left to right"></div>
        <div class="plinko__tip" id="plinkoTip" role="tooltip" hidden>
          <b class="plinko__tipmult" id="plinkoTipMult"></b>
          <span class="plinko__tiprow"><span>Profit on win</span><b id="plinkoTipProfit"></b></span>
          <span class="plinko__tiprow"><span>Chance</span><b id="plinkoTipChance"></b></span>
        </div>
      </div>
    </section>

    <aside class="plinko__panel" aria-label="Your ball">
      <form class="plinko__form" id="plinkoForm" novalidate>
        <label class="plinko__label" for="plinkoStake">Stake per ball</label>
        <div class="plinko__field">
          <span aria-hidden="true">$</span>
          <input id="plinkoStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="plinko__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="plinko__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="plinko__label" id="plinkoRiskLabel">Risk</span>
        <div class="plinko__risks" role="group" aria-labelledby="plinkoRiskLabel">
          ${RISKS.map(([value, name]) => `<button type="button" class="plinko__risk" data-risk="${value}" aria-pressed="false">${name}</button>`).join('')}
        </div>
        <div class="plinko__labelrow">
          <label class="plinko__label" for="plinkoRowsRange">Rows</label>
          <output class="plinko__rowsval" id="plinkoRows" for="plinkoRowsRange" aria-live="off">12</output>
        </div>
        <input class="plinko__range" id="plinkoRowsRange" type="range" min="8" max="16" step="1" value="12" />
        <button class="btn plinko__go" id="plinkoGo" type="submit" data-sfx="plinkoDrop">
          <span id="plinkoGoLabel">Loading…</span>
        </button>
        <p class="plinko__hint" id="plinkoHint" aria-live="polite"></p>
        <p class="plinko__falling" id="plinkoFalling"></p>
        ${viewSwitch('plinkoView')}
        <label class="plinko__gfx" for="plinkoGfx">
          <span>Graphics</span>
          <select id="plinkoGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="plinko__say" id="plinkoSay" role="status" aria-atomic="true"></div>`;

  canvas = $('#plinkoCanvas', root);
  ctx = canvas.getContext('2d');

  const stake = $('#plinkoStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  root.querySelectorAll('.plinko__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paintControls();
  }));
  root.querySelectorAll('.plinko__risk').forEach((button) => button.addEventListener('click', () => {
    if (busy()) return;
    risk = button.dataset.risk;
    paint();
  }));
  $('#plinkoRowsRange', root).addEventListener('input', (event) => {
    const next = Math.min(config?.maxRows ?? 16, Math.max(config?.minRows ?? 8, Number(event.target.value) || rows));
    if (busy() || next === rows) {
      event.target.value = String(rows);
      return;
    }
    rows = next;
    playSound('tick', { rate: 0.75 + (rows - 8) * 0.06 });
    paint();
  });
  // The slot card: a pointer over a slot opens it; a tap opens it and a tap anywhere else shuts it.
  const slotsRow = $('#plinkoSlots', root);
  const slotAt = (event) => {
    const node = event.target.closest?.('.plinko__slot');
    return node ? Number(node.dataset.slot) : null;
  };
  slotsRow.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const slot = slotAt(event);
    if (slot !== null && slot !== tipSlot) openTip(slot);
  });
  slotsRow.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') closeTip(); });
  slotsRow.addEventListener('click', (event) => {
    const slot = slotAt(event);
    if (slot === null) return;
    if (slot === tipSlot && event.pointerType !== 'mouse') closeTip();
    else openTip(slot);
  });
  document.addEventListener('pointerdown', (event) => {
    if (tipSlot !== null && !event.target.closest?.('#plinkoSlots')) closeTip();
  });
  $('#plinkoGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#plinkoView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  $('#plinkoForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    drop();
  });

  new ResizeObserver(() => resize()).observe(canvas);
}

export function mountPlinko(section) {
  root = $('#plinkoRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        void load();
        return;
      }
      if (event.detail === 'logout') {
        for (const waiting of queue) waiting.release();
        for (const ball of balls) ball.release();
        queue = [];
        balls = [];
        recent = [];
        seedHash = null;
        serverBalance = null;
        draw(performance.now());
      }
      if (root) paint();
    });
  }
  // A scene still to be built comes up behind the loading screen, not after the flat board.
  if (!boardTried) sceneLoading(root, $('.plinko__view', root));
  void load();
}
