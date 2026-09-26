/* crash.js — one shared multiplier every player rides, and the one moment to get off it.
 *
 * The server owns the round: when betting closes, when the curve starts, when it busts, and what
 * every cash-out is paid. This page draws the curve from the round's start time alone -- the curve
 * is m(t) = e^(0.07·t), the same on every screen -- and asks the server for everything else.
 *
 * The bust arrives as its own live event, so the curve stops the moment it happens instead of
 * climbing on for as long as a refetch takes; the exact crash point replaces the frozen figure
 * when the refetch lands.
 *
 * Motion is one thing: the curve. With reduced motion it is redrawn four times a second instead of
 * every frame, and the bust does not shake.
 */
import { API_BASE_URL, api, idempotencyKey } from './api.js';
import { bus, refreshBalance, state } from './store.js';
import { $, el, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const BUST_HOLD_MS = 2600; // how long a bust stays on the stage before the countdown takes over
const LIVE_POLL_MS = 5_000; // a safety net under the live stream
const BLIND_POLL_MS = 1_000; // no live stream: poll while a round is in the air
const QUICK_STAKES = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];
const QUICK_TARGETS = [[null, 'Off'], [150, '1.5×'], [200, '2×'], [500, '5×'], [1000, '10×']];

let root = null;
let view = null;
let snap = null; // the last GET /v1/crash
let offsetMs = 0; // server clock minus this clock
let liveConnected = false;
let busy = false;
let pressed = null;
let queued = false;
let stakeText = '1m';
let autoText = '2';
let frozen = null; // { roundId, x100, at } -- the bust signal arrived, the figure is not in yet
let lastBust = null; // { roundId, x100, at, bets }
let lastPhase = null;
let inflight = null;
let again = false;
let frame = 0;
let lastDraw = 0;
let palette = null;
let canvas = null;
let ctx = null;
let size = { w: 0, h: 0, dpr: 1 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const growth = () => Number(snap?.config?.growthPerSecond) || 0.07;
const x100 = (value) => `${(Math.floor(value) / 100).toFixed(2)}×`;
const serverNow = () => Date.now() + offsetMs;

/* ─────────── the round ─────────── */

/** What the stage is showing right now. */
function stagePhase() {
  const round = snap?.round;
  if (frozen && frozen.roundId === round?.id) return 'busted';
  if (lastBust && Date.now() - lastBust.at < BUST_HOLD_MS) return 'busted';
  if (!round) return 'closed';
  return serverNow() < Date.parse(round.startedAt) ? 'betting' : 'running';
}

/** The round's phase for betting purposes, which ignores the bust still showing on the stage. */
function roundPhase() {
  const round = snap?.round;
  if (!round) return 'closed';
  if (frozen && frozen.roundId === round.id) return 'busted';
  return serverNow() < Date.parse(round.startedAt) ? 'betting' : 'running';
}

/** The live multiplier, in hundredths, for the round in the air. */
function liveX100() {
  const round = snap?.round;
  if (!round) return 100;
  const seconds = (serverNow() - Date.parse(round.startedAt)) / 1000;
  if (seconds <= 0) return 100;
  return Math.max(100, Math.floor(100 * Math.exp(growth() * seconds) + 1e-9));
}

function myBet() {
  return snap?.yourBet && snap.yourBet.roundId === snap.round?.id ? snap.yourBet : null;
}

/* ─────────── fetching ─────────── */

async function refresh() {
  if (!root?.isConnected) return;
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      const sent = Date.now();
      const next = await api.get('/v1/crash');
      const received = Date.now();
      // The midpoint of the request is the best local estimate of when the server read its clock.
      offsetMs = Date.parse(next.serverTime) - (sent + received) / 2;
      root.dataset.error = '';
      apply(next);
    } catch {
      root.dataset.error = '1';
    }
  })();
  await inflight;
  inflight = null;
  if (again) {
    again = false;
    await wait(180);
    return refresh();
  }
}

function apply(next) {
  const previous = snap;
  snap = next;
  const showing = previous?.round?.id;
  const settled = showing ? next.history?.find((row) => row.id === showing) : null;
  if (settled && next.round?.id !== showing) {
    // The round this page was showing has busted. Hold it on the stage, at its exact figure.
    const mine = (next.previousBets || []).find((bet) => bet.isViewer);
    lastBust = {
      roundId: showing,
      x100: settled.crashPointX100,
      at: frozen?.roundId === showing ? frozen.at : Date.now(),
      bets: next.previousBets || [],
      mine,
    };
    if (frozen?.roundId === showing) frozen = null;
    onBust(lastBust);
  }
  if (queued && next.round && roundPhase() === 'betting' && !myBet()) {
    queued = false;
    void placeBet();
  }
  paintHistory();
  paintPlayers();
  paintFairness();
  paintControls();
}

function onBust(bust) {
  const mine = bust.mine;
  announce(
    mine?.status === 'cashed_out'
      ? `Busted at ${x100(bust.x100)}. You cashed out at ${x100(mine.cashoutX100)}.`
      : mine
        ? `Busted at ${x100(bust.x100)}. Your bet was lost.`
        : `Busted at ${x100(bust.x100)}.`,
  );
  if (mine && mine.status !== 'cashed_out') playSound('lose');
  if (!reduceMotion()) {
    const stage = $('.crash__stage', root);
    stage?.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' },
        { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
      { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
  }
}

/** The live stream says the round just busted: stop the curve where it is, then fetch the figure. */
function onBustSignal() {
  const round = snap?.round;
  if (round && roundPhase() === 'running' && !frozen) {
    frozen = { roundId: round.id, x100: liveX100(), at: Date.now() };
  }
  void refresh();
}

/* ─────────── actions ─────────── */

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function autoX100() {
  const raw = String(autoText ?? '').trim().replace(/[×x\s]/gi, '');
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 100);
}

function betProblem() {
  const config = snap?.config;
  if (!config) return 'The table is not answering';
  if (!config.enabled) return 'Crash is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a bet, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest bet is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest bet is ${money(Number(config.maxStakeMinor))}`;
  const target = autoX100();
  if (Number.isNaN(target) || (target !== null && (target < config.minTargetX100 || target > config.maxMultiplierX100))) {
    return `Auto cash-out goes from ${x100(config.minTargetX100)} to ${x100(config.maxMultiplierX100)}`;
  }
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

async function placeBet() {
  if (busy || betProblem() || !snap?.round) return;
  busy = true;
  pressed = 'bet';
  paintControls();
  try {
    const target = autoX100();
    const response = await api.post(
      '/v1/crash/bets',
      {
        roundId: snap.round.id,
        stakeMinor: stakeMinor().toString(),
        ...(target === null ? {} : { autoCashoutX100: target }),
      },
      { idempotencyKey: idempotencyKey() },
    );
    snap.yourBet = response.bet;
    playSound('click');
    announce(`Bet placed: ${money(Number(response.bet.stakeMinor))}.`);
  } catch (error) {
    if (['ROUND_CHANGED', 'BETTING_CLOSED'].includes(error?.code)) {
      toast({ kind: 'gold', title: 'Crash', body: 'Bets for that round had closed. Nothing was taken.' });
    } else {
      toast({ kind: 'lose', title: 'Crash', body: error?.message || 'That bet did not go through' });
    }
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paintControls();
    void refresh();
  }
}

async function cashOut() {
  const bet = myBet();
  if (busy || !bet || bet.status !== 'active' || roundPhase() !== 'running') return;
  busy = true;
  pressed = 'cashout';
  paintControls();
  try {
    const response = await api.post('/v1/crash/cashout', { roundId: bet.roundId });
    snap.yourBet = response.bet;
    const won = BigInt(response.bet.payoutMinor || '0');
    playSound('coin');
    announce(`Cashed out at ${x100(response.bet.cashoutX100)} for ${money(Number(won))}.`);
  } catch (error) {
    if (error?.code === 'ROUND_CRASHED') {
      onBustSignal();
    } else {
      toast({ kind: 'lose', title: 'Crash', body: error?.message || 'That cash-out did not go through' });
    }
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paintControls();
    void refresh();
  }
}

function primary() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  const action = $('#crashGo', root)?.dataset.action;
  if (action === 'bet') void placeBet();
  else if (action === 'cashout') void cashOut();
  else if (action === 'queue') { queued = true; paintControls(); }
  else if (action === 'unqueue') { queued = false; paintControls(); }
}

/* ─────────── painting: controls ─────────── */

/** The one button, and what it does in this phase. */
function buttonState() {
  if (!state.authenticated) return { action: 'login', label: 'Log in to play', tone: 'go' };
  if (!snap) return { action: '', label: 'Loading…', tone: 'idle', disabled: true };
  const phase = roundPhase();
  const bet = myBet();
  if (phase === 'closed') return { action: '', label: 'Crash is closed', tone: 'idle', disabled: true };
  if (phase === 'betting') {
    if (bet) return { action: '', label: 'Bet placed', tone: 'idle', disabled: true };
    if (busy && pressed === 'bet') return { action: 'bet', label: 'Placing…', tone: 'go', disabled: true, busy: true };
    const problem = betProblem();
    return { action: 'bet', label: `Bet ${money(Number(stakeMinor() ?? 0n))}`, tone: 'go', disabled: Boolean(problem) };
  }
  if (phase === 'running' && bet?.status === 'active') {
    const payout = (BigInt(bet.stakeMinor) * BigInt(liveX100())) / 100n;
    if (busy && pressed === 'cashout') return { action: 'cashout', label: 'Cashing out…', tone: 'cash', disabled: true, busy: true };
    return { action: 'cashout', label: `Cash out ${money(Number(payout))}`, tone: 'cash' };
  }
  if (bet?.status === 'cashed_out') {
    return { action: '', label: `Cashed out ${x100(bet.cashoutX100)}`, tone: 'won', disabled: true };
  }
  if (phase === 'busted' && bet) return { action: '', label: 'Busted', tone: 'lost', disabled: true };
  return queued
    ? { action: 'unqueue', label: 'Queued for next round', tone: 'idle' }
    : { action: 'queue', label: 'Bet next round', tone: 'go', disabled: Boolean(betProblem()) };
}

function paintButton() {
  const button = $('#crashGo', root);
  if (!button) return;
  const next = buttonState();
  const label = $('#crashGoLabel', root);
  if (label.textContent !== next.label) label.textContent = next.label;
  button.dataset.action = next.action;
  button.dataset.tone = next.tone;
  button.disabled = Boolean(next.disabled);
  button.setAttribute('aria-busy', String(Boolean(next.busy)));
}

function paintControls() {
  if (!root) return;
  paintButton();
  const hint = $('#crashHint', root);
  const phase = roundPhase();
  const problem = state.authenticated && phase === 'betting' && !myBet() ? betProblem() : '';
  hint.textContent = problem;

  // What the player has riding, in words.
  const mine = $('#crashMine', root);
  const bet = myBet();
  const recent = lastBust && Date.now() - lastBust.at < BUST_HOLD_MS * 2 ? lastBust.mine : null;
  let line = '';
  let tone = '';
  if (bet?.status === 'cashed_out') {
    const profit = BigInt(bet.payoutMinor) - BigInt(bet.stakeMinor);
    line = `You cashed out at ${x100(bet.cashoutX100)} · +${money(Number(profit))}`;
    tone = 'won';
  } else if (bet) {
    line = `${money(Number(bet.stakeMinor))} in · ${bet.autoCashoutX100 ? `auto cash-out at ${x100(bet.targetX100)}` : `cashes out at ${x100(bet.targetX100)} at the latest`}`;
  } else if (recent) {
    if (recent.status === 'cashed_out') {
      line = `Last round: out at ${x100(recent.cashoutX100)} · +${money(Number(BigInt(recent.payoutMinor) - BigInt(recent.stakeMinor)))}`;
      tone = 'won';
    } else {
      line = `Last round: busted · −${money(Number(recent.stakeMinor))}`;
      tone = 'lost';
    }
  } else if (queued) {
    line = 'Your bet goes in as soon as the next round opens.';
  }
  mine.textContent = line;
  mine.dataset.tone = tone;
  mine.hidden = !line;

  // A bet already in this round cannot be changed; between rounds the fields set up the next one.
  const lockInputs = busy || (phase === 'betting' && Boolean(bet));
  for (const input of root.querySelectorAll('.crash__form input, .crash__form .crash__pick, .crash__form .crash__adj')) {
    input.disabled = lockInputs;
  }
  root.querySelectorAll('.crash__pick[data-target]').forEach((pick) => {
    const value = pick.dataset.target === '' ? null : Number(pick.dataset.target);
    pick.setAttribute('aria-pressed', String(value === autoX100()));
  });
}

/* ─────────── painting: the side panels ─────────── */

function band(point) {
  return point >= 1000 ? 'high' : point >= 200 ? 'mid' : 'low';
}

function paintHistory() {
  const strip = $('#crashHistory', root);
  if (!strip) return;
  const rows = (snap?.history || []).slice(0, 16);
  const key = rows.map((row) => row.id).join();
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  strip.replaceChildren(...rows.map((row) => {
    const chip = el('li', 'crash__past');
    chip.dataset.band = band(row.crashPointX100);
    chip.textContent = x100(row.crashPointX100);
    return chip;
  }));
}

function paintPlayers() {
  const list = $('#crashPlayers', root);
  if (!list) return;
  // While a bust is on the stage, the list is that round's: who got out and who went down with it.
  const showBust = Boolean(lastBust) && Date.now() - lastBust.at < BUST_HOLD_MS;
  const bets = showBust ? lastBust.bets : snap?.bets || [];
  const settledRound = showBust;
  const total = bets.reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
  $('#crashCount', root).textContent = bets.length
    ? `${bets.length} ${bets.length === 1 ? 'player' : 'players'} · ${money(Number(total))}`
    : 'No bets yet';
  list.replaceChildren(...bets.map((bet) => {
    const row = el('li', 'crash__player');
    if (bet.isViewer) row.dataset.viewer = '1';
    const who = el('span', 'crash__who');
    const head = el('span', 'crash__head');
    const initial = () => {
      const letter = el('i');
      letter.textContent = String(bet.player || '?').slice(0, 1).toUpperCase();
      head.replaceChildren(letter);
    };
    if (bet.playerId) {
      const art = document.createElement('img');
      art.alt = '';
      art.loading = 'lazy';
      art.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(bet.playerId)}?s=22`;
      art.addEventListener('error', initial, { once: true });
      head.append(art);
    } else {
      initial();
    }
    const name = el('span', 'mono');
    name.textContent = bet.isViewer ? 'You' : bet.player;
    who.append(head, name);
    const stake = el('span', 'crash__amt mono');
    stake.textContent = money(Number(bet.stakeMinor));
    const at = el('span', 'crash__at mono');
    const profit = el('span', 'crash__profit mono');
    if (bet.status === 'cashed_out') {
      row.dataset.state = 'won';
      at.textContent = x100(bet.cashoutX100);
      profit.textContent = `+${money(Number(BigInt(bet.payoutMinor) - BigInt(bet.stakeMinor)))}`;
    } else if (bet.status === 'lost' || settledRound) {
      row.dataset.state = 'lost';
      at.textContent = 'busted';
      profit.textContent = `−${money(Number(bet.stakeMinor))}`;
    } else {
      at.textContent = '—';
      profit.textContent = '';
    }
    row.append(who, stake, at, profit);
    return row;
  }));
}

function paintFairness() {
  const node = $('#crashFair', root);
  if (!node || !snap) return;
  const last = snap.history?.[0];
  const current = snap.round;
  $('#crashCommit', root).textContent = current?.serverSeedHash || '—';
  $('#crashLastId', root).textContent = last?.id || '—';
  $('#crashLastSeed', root).textContent = last?.serverSeed || '—';
  $('#crashLastPoint', root).textContent = last ? x100(last.crashPointX100) : '—';
  const edge = Number(snap.config?.houseEdgeBps ?? 1000) / 100;
  $('#crashEdge', root).textContent = `${edge}%`;
  $('#crashLimits', root).textContent =
    `${money(Number(snap.config?.minStakeMinor || 0))} – ${money(Number(snap.config?.maxStakeMinor || 0))} per bet · ` +
    `up to ${money(Number(snap.config?.maxPayoutMinor || 0))} paid per bet`;
}

/* ─────────── the stage ─────────── */

function readPalette() {
  const style = getComputedStyle(root);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  palette = {
    line: token('--crash-line', '#ffd700'),
    fillTop: token('--crash-fill-top', 'rgba(255, 170, 0, .34)'),
    fillBottom: token('--crash-fill-bottom', 'rgba(255, 170, 0, 0)'),
    bust: token('--crash-bust', '#ff4d5e'),
    win: token('--crash-win', '#3fd3ff'),
    grid: token('--crash-grid', 'rgba(255, 215, 0, .08)'),
    label: token('--crash-label', 'rgba(236, 237, 240, .45)'),
    head: token('--crash-head', '#fff6cc'),
    mono: token('--mono', 'ui-monospace, monospace'),
  };
}

function resize() {
  if (!canvas) return;
  const box = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  size = { w: Math.max(1, Math.floor(box.width)), h: Math.max(1, Math.floor(box.height)), dpr };
  canvas.width = size.w * dpr;
  canvas.height = size.h * dpr;
  canvas.style.width = `${size.w}px`;
  canvas.style.height = `${size.h}px`;
  lastDraw = 0;
}

/** A step for the multiplier grid that gives three to five lines between 1x and the top. */
function gridStep(span) {
  for (const step of [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500]) if (span / step <= 5) return step;
  return 1000;
}

function drawCurve(seconds, topX100, { bust = false, markers = [] } = {}) {
  const { w, h, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 44, r: 18, t: 20, b: 28 };
  const g = growth();
  const top = topX100 / 100;
  const spanX = Math.max(8, seconds * 1.18);
  const spanY = Math.max(1, (top - 1) * 1.28);
  const px = (t) => pad.l + (t / spanX) * (w - pad.l - pad.r);
  const py = (m) => h - pad.b - ((m - 1) / spanY) * (h - pad.t - pad.b);

  // Grid: multiplier lines with labels, and the time along the foot.
  ctx.font = `600 10px ${palette.mono}`;
  ctx.fillStyle = palette.label;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  const step = gridStep(spanY);
  for (let m = 1; m <= 1 + spanY + 1e-9; m += step) {
    const y = Math.round(py(m)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Number(m.toFixed(2))}×`, pad.l - 8, y);
  }
  const tStep = spanX > 60 ? 20 : spanX > 24 ? 10 : spanX > 12 ? 4 : 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= spanX; t += tStep) ctx.fillText(`${t}s`, px(t), h - pad.b + 8);

  if (seconds <= 0) return;
  // The curve and the area under it.
  const points = [];
  const samples = 72;
  for (let i = 0; i <= samples; i += 1) {
    const t = (seconds * i) / samples;
    points.push([px(t), py(Math.min(Math.exp(g * t), top))]);
  }
  const area = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  area.addColorStop(0, bust ? 'rgba(255, 77, 94, .22)' : palette.fillTop);
  area.addColorStop(1, palette.fillBottom);
  ctx.beginPath();
  ctx.moveTo(points[0][0], py(1));
  for (const [x, y] of points) ctx.lineTo(x, y);
  ctx.lineTo(points[points.length - 1][0], py(1));
  ctx.closePath();
  ctx.fillStyle = area;
  ctx.fill();

  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = bust ? palette.bust : palette.line;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = bust ? palette.bust : palette.line;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Cash-outs along the curve: the viewer's with its figure, everybody else's as a dot.
  for (const marker of markers) {
    const t = Math.log(marker.x100 / 100) / g;
    if (t > seconds) continue;
    const x = px(t);
    const y = py(marker.x100 / 100);
    ctx.fillStyle = palette.win;
    ctx.beginPath();
    ctx.arc(x, y, marker.mine ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    if (marker.mine) {
      ctx.font = `800 11px ${palette.mono}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`You ${x100(marker.x100)}`, x + 8, y - 6);
    }
  }

  // The head of the curve.
  const [hx, hy] = points[points.length - 1];
  ctx.fillStyle = bust ? palette.bust : palette.head;
  ctx.shadowColor = bust ? palette.bust : palette.line;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(hx, hy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

function markersFor(bets, limitX100) {
  return (bets || [])
    .filter((bet) => bet.status === 'cashed_out' && bet.cashoutX100 <= limitX100)
    .map((bet) => ({ x100: bet.cashoutX100, mine: Boolean(bet.isViewer) }));
}

function render(now) {
  frame = requestAnimationFrame(render);
  if (!root?.isConnected || view?.hidden || !ctx) return;
  // Reduced motion: the curve is redrawn four times a second, not sixty.
  if (reduceMotion() && now - lastDraw < 250) return;
  lastDraw = now;

  const phase = stagePhase();
  root.dataset.phase = phase;
  const big = $('#crashBig', root);
  const status = $('#crashStatus', root);
  const bar = $('#crashBar', root);

  if (phase === 'busted') {
    const bust = frozen && frozen.roundId === snap?.round?.id ? frozen : lastBust;
    const point = bust?.x100 ?? 100;
    const seconds = Math.log(point / 100) / growth();
    drawCurve(seconds, point, { bust: true, markers: markersFor(bust?.bets, point) });
    big.textContent = x100(point);
    status.textContent = bust === frozen ? 'Busted' : `Busted at ${x100(point)}`;
    bar.hidden = true;
  } else if (phase === 'betting') {
    const left = Math.max(0, Date.parse(snap.round.startedAt) - serverNow());
    const total = (snap.config?.bettingSeconds || 10) * 1000;
    drawCurve(0, 100);
    big.textContent = `${(left / 1000).toFixed(1)}s`;
    status.textContent = myBet() ? 'You are in. Launching in' : 'Place your bet. Launching in';
    bar.hidden = false;
    bar.style.transform = `scaleX(${Math.min(1, left / total)})`;
  } else if (phase === 'running') {
    const x = liveX100();
    const seconds = (serverNow() - Date.parse(snap.round.startedAt)) / 1000;
    drawCurve(seconds, x, { markers: markersFor(snap.bets, x) });
    big.textContent = x100(x);
    const bet = myBet();
    status.textContent = bet?.status === 'cashed_out'
      ? `You are out at ${x100(bet.cashoutX100)}`
      : bet
        ? `Current payout ${money(Number((BigInt(bet.stakeMinor) * BigInt(x)) / 100n))}`
        : 'In the air';
    bar.hidden = true;
  } else {
    drawCurve(0, 100);
    big.textContent = '—';
    status.textContent = snap ? 'Crash is closed right now' : 'Connecting…';
    bar.hidden = true;
  }

  if (phase !== lastPhase) {
    if (phase === 'running' && lastPhase === 'betting') announce('Launched.');
    lastPhase = phase;
    paintPlayers();
  }
  // The button carries the live payout while a bet is in the air.
  paintButton();
}

/* One polite, whole sentence per event -- never the number as it climbs. */
function announce(text) {
  const node = $('#crashSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── building ─────────── */

function build() {
  root.innerHTML = `
    <section class="crash__stage" aria-label="The round">
      <ol class="crash__history" id="crashHistory" aria-label="Recent crash points"></ol>
      <div class="crash__plot"><canvas id="crashCanvas" aria-hidden="true"></canvas></div>
      <div class="crash__readout">
        <b class="crash__big" id="crashBig">—</b>
        <span class="crash__status" id="crashStatus">Connecting…</span>
        <span class="crash__bar" aria-hidden="true"><i id="crashBar" hidden></i></span>
      </div>
    </section>

    <aside class="crash__panel" aria-label="Your bet">
      <form class="crash__form" id="crashForm" novalidate>
        <label class="crash__label" for="crashStake">Bet</label>
        <div class="crash__field">
          <span aria-hidden="true">$</span>
          <input id="crashStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="crash__adj" data-adj="half" aria-label="Halve the bet">½</button>
          <button type="button" class="crash__adj" data-adj="double" aria-label="Double the bet">2×</button>
        </div>
        <div class="crash__picks" role="group" aria-label="Quick bets">
          ${QUICK_STAKES.map((amount) => `<button type="button" class="crash__pick" data-stake="${amount}">${money(amount)}</button>`).join('')}
        </div>
        <label class="crash__label" for="crashAuto">Auto cash-out</label>
        <div class="crash__field">
          <input id="crashAuto" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Off" />
          <span aria-hidden="true">×</span>
        </div>
        <div class="crash__picks" role="group" aria-label="Auto cash-out targets">
          ${QUICK_TARGETS.map(([target, label]) => `<button type="button" class="crash__pick" data-target="${target ?? ''}" aria-pressed="false">${label}</button>`).join('')}
        </div>
        <button class="btn crash__go" id="crashGo" type="submit" aria-keyshortcuts="Space">
          <span id="crashGoLabel">Loading…</span><kbd aria-hidden="true">Space</kbd>
        </button>
        <p class="crash__hint" id="crashHint" aria-live="polite"></p>
        <p class="crash__mine" id="crashMine" hidden></p>
      </form>
    </aside>

    <section class="crash__players" aria-label="Players this round">
      <header><b>This round</b><span id="crashCount">No bets yet</span></header>
      <ol id="crashPlayers"></ol>
    </section>

    <details class="crash__fair" id="crashFair">
      <summary>Fairness and limits</summary>
      <dl>
        <dt>House edge</dt><dd id="crashEdge">10%</dd>
        <dt>Limits</dt><dd id="crashLimits">—</dd>
        <dt>This round's commitment (SHA-256 of its seed)</dt><dd class="mono" id="crashCommit">—</dd>
        <dt>Last round</dt><dd class="mono" id="crashLastId">—</dd>
        <dt>Its seed</dt><dd class="mono" id="crashLastSeed">—</dd>
        <dt>Its crash point</dt><dd class="mono" id="crashLastPoint">—</dd>
      </dl>
      <p>Every round's seed is committed before the first bet and revealed when it busts. The crash
        point is <code>floor(9000 · 2^52 / (100 · (2^52 − h))) / 100</code>, where <code>h</code> is the
        first 13 hex digits of HMAC-SHA256(seed, "roundId:0") -- so any cash-out target returns 90%
        of the stake on average, whatever it is.</p>
    </details>
    <div class="crash__say" id="crashSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#crashStake', root);
  const auto = $('#crashAuto', root);
  stake.value = stakeText;
  auto.value = autoText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  auto.addEventListener('input', () => { autoText = auto.value; paintControls(); });
  root.querySelectorAll('.crash__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paintControls();
  }));
  root.querySelectorAll('.crash__pick[data-stake]').forEach((button) => button.addEventListener('click', () => {
    stakeText = formatAmountInput(Number(button.dataset.stake));
    stake.value = stakeText;
    paintControls();
  }));
  root.querySelectorAll('.crash__pick[data-target]').forEach((button) => button.addEventListener('click', () => {
    autoText = button.dataset.target === '' ? '' : String(Number(button.dataset.target) / 100);
    auto.value = autoText;
    paintControls();
  }));
  $('#crashForm', root).addEventListener('submit', (event) => { event.preventDefault(); primary(); });

  /* Space places the bet or cashes out -- unless the player is typing, or the page is hidden. */
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    if (!root?.isConnected || view?.hidden) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    event.preventDefault();
    primary();
  });

  canvas = $('#crashCanvas', root);
  ctx = canvas.getContext('2d');
  readPalette();
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();
}

export function mountCrash(section) {
  view = section;
  root = $('#crashRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    window.addEventListener('donut:crash', () => { if (!view.hidden) void refresh(); });
    window.addEventListener('donut:crash-bust', () => { if (!view.hidden) onBustSignal(); });
    window.addEventListener('donut:live-status', (event) => { liveConnected = Boolean(event.detail?.connected); });
    bus.addEventListener('change', (event) => {
      if (['ready', 'login', 'logout'].includes(event.detail)) void refresh();
      else if (event.detail === 'balance') paintControls();
    });
    // The live stream is the normal path; this only repairs a missed event, faster when blind.
    let lastPoll = 0;
    window.setInterval(() => {
      if (view.hidden) return;
      const blind = !liveConnected && roundPhase() === 'running';
      if (Date.now() - lastPoll < (blind ? BLIND_POLL_MS : LIVE_POLL_MS)) return;
      lastPoll = Date.now();
      void refresh();
    }, 250);
    // Betting closes on the server's clock; ask again the moment it should have.
    window.setInterval(() => {
      if (view.hidden || !snap?.round) return;
      const left = Date.parse(snap.round.startedAt) - serverNow();
      if (left <= 0 && left > -300) void refresh();
    }, 150);
  }
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(render);
  resize();
  void refresh();
}
