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
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const RISKS = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const MAX_QUEUED = 4; // drops waiting for the server
const MAX_FALLING = 24; // balls on the board at once
const RECENT = 8;

/* The board in units of one peg gap. Peg row r (0-based, from the top) has r + 3 pegs; the slots sit
 * under the gaps of the last row, so a board of n rows is n + 2 gaps wide. */
const TOP = 1.1; // the first row's height
const ROW = 0.9; // the drop from one row to the next
const FOOT = 0.9; // the last row to the slots
const PEG_R = 0.1;
const BALL_R = 0.26;

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

function available() {
  const base = serverBalance ?? BigInt(state.balanceMinor || '0');
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
  playSound('click');
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

function launch(bet, release) {
  const n = bet.rows;
  const ball = { bet, release, landed: false, points: course(bet.path, n), start: performance.now(), hit: 0 };
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
      if (now - lastTick > 45) {
        lastTick = now;
        playSound('reeltick');
      }
    }
    if (elapsed >= ball.times[ball.times.length - 1]) land(ball);
  }
  for (const [peg, at] of flashes) if (now - at > 320) flashes.delete(peg);
  draw(now);
  if (balls.length || flashes.size) run();
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
  const x = bet.multiplierBps / 10_000;
  playSound(x >= 10 ? 'reward' : x >= 1 ? 'win' : 'coin');
  queueSay(bet);
  settleIfDone();
  paintReadout();
  paintControls();
  if (!raf) draw(performance.now());
}

/** The pill: the server's balance less every payout still in the air. */
function showFalling() {
  if (serverBalance === null) return;
  const inAir = balls.reduce((sum, ball) => sum + BigInt(ball.bet.payoutMinor), 0n);
  showBalance((serverBalance - inAir).toString());
}

function settleIfDone() {
  if (busy() || sending) return;
  serverBalance = null;
  void refreshBalance();
}

function bump(slot) {
  const node = root?.querySelector(`.plinko__slot[data-slot="${slot}"]`);
  if (!node) return;
  node.classList.remove('is-hit');
  void node.offsetWidth;
  node.classList.add('is-hit');
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

/* ─────────── the board ─────────── */

function readPalette() {
  const style = getComputedStyle(root);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  palette = {
    peg: token('--plinko-peg', '#9da1aa'),
    pegLit: token('--plinko-peg-lit', '#ffd700'),
    ballHi: token('--plinko-ball-hi', '#fff6c8'),
    ball: token('--plinko-ball', '#ffd700'),
    ballLo: token('--plinko-ball-lo', '#a35f00'),
    shadow: token('--plinko-shadow', 'rgba(0, 0, 0, .55)'),
  };
}

function resize() {
  if (!canvas) return;
  const n = rows;
  boardRows = n;
  const wrap = canvas.parentElement;
  wrap.style.setProperty('--gaps', String(n + 2));
  wrap.style.setProperty('--depth', String(TOP + (n - 1) * ROW + FOOT));
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  draw(performance.now());
  if ($('.plinko__slot', root)) paintSlots();
}

function draw(now) {
  if (!ctx || !canvas.width) return;
  if (!palette) readPalette();
  const n = boardRows;
  const unit = canvas.width / (n + 2);
  const mid = (n + 2) / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < n; r += 1) {
    for (let j = 0; j < r + 3; j += 1) {
      const x = (mid + j - (r + 2) / 2) * unit;
      const y = (TOP + r * ROW) * unit;
      const struck = flashes.get(`${r}:${j}`);
      const glow = struck === undefined ? 0 : Math.max(0, 1 - (now - struck) / 320);
      if (glow > 0) {
        ctx.beginPath();
        ctx.arc(x, y, PEG_R * unit * (1 + 2.2 * glow), 0, Math.PI * 2);
        ctx.globalAlpha = 0.35 * glow;
        ctx.fillStyle = palette.pegLit;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, PEG_R * unit), 0, Math.PI * 2);
      ctx.fillStyle = glow > 0 ? palette.pegLit : palette.peg;
      ctx.fill();
    }
  }

  const radius = BALL_R * unit;
  for (const ball of balls) {
    const at = positionOf(ball, now - ball.start);
    const x = at.x * unit;
    const y = at.y * unit;
    ctx.beginPath();
    ctx.arc(x, y + radius * 0.25, radius, 0, Math.PI * 2);
    ctx.fillStyle = palette.shadow;
    ctx.fill();
    const body = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
    body.addColorStop(0, palette.ballHi);
    body.addColorStop(0.45, palette.ball);
    body.addColorStop(1, palette.ballLo);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
  }
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
}

function buildSlots() {
  const holder = $('#plinkoSlots', root);
  if (!holder) return;
  holder.style.setProperty('--slots', String(rows + 1));
  holder.replaceChildren();
  for (let slot = 0; slot <= rows; slot += 1) {
    const node = document.createElement('span');
    node.className = 'plinko__slot';
    node.dataset.slot = String(slot);
    node.setAttribute('role', 'listitem');
    node.style.setProperty('--heat', heat(slot, rows).toFixed(3));
    holder.appendChild(node);
  }
}

function paintSlots() {
  const slots = table();
  const holder = $('#plinkoSlots', root);
  const dense = holder.clientWidth / (rows + 1) < 26;
  holder.toggleAttribute('data-dense', dense);
  root.querySelectorAll('.plinko__slot').forEach((node, slot) => {
    const bps = slots?.[slot];
    const text = bps ? short(bps, dense) : '—';
    if (node.textContent !== text) node.textContent = text;
    node.setAttribute('aria-label', bps ? `${times(bps)}` : 'unavailable');
  });
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
  root.querySelectorAll('.plinko__risk, .plinko__step').forEach((node) => { node.disabled = locked; });
  root.querySelectorAll('.plinko__risk').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.risk === risk));
  });
  $('#plinkoRows', root).textContent = String(rows);
  $('#plinkoRowsDown', root).disabled = locked || rows <= (config?.minRows ?? 8);
  $('#plinkoRowsUp', root).disabled = locked || rows >= (config?.maxRows ?? 16);
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
        <canvas id="plinkoCanvas" aria-hidden="true"></canvas>
        <div class="plinko__slots" id="plinkoSlots" role="list" aria-label="What each slot pays, left to right"></div>
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
        <span class="plinko__label" id="plinkoRowsLabel">Rows</span>
        <div class="plinko__stepper" role="group" aria-labelledby="plinkoRowsLabel">
          <button type="button" class="plinko__step" id="plinkoRowsDown" data-step="-1" aria-label="One row fewer">−</button>
          <output id="plinkoRows" aria-live="off">12</output>
          <button type="button" class="plinko__step" id="plinkoRowsUp" data-step="1" aria-label="One row more">+</button>
        </div>
        <button class="btn plinko__go" id="plinkoGo" type="submit">
          <span id="plinkoGoLabel">Loading…</span>
        </button>
        <p class="plinko__hint" id="plinkoHint" aria-live="polite"></p>
        <p class="plinko__falling" id="plinkoFalling"></p>
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
  root.querySelectorAll('.plinko__step').forEach((button) => button.addEventListener('click', () => {
    if (busy()) return;
    rows = Math.min(config?.maxRows ?? 16, Math.max(config?.minRows ?? 8, rows + Number(button.dataset.step)));
    paint();
  }));
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
  void load();
}
