/* stocks.js — the Stocks table: one shared live market, traded long or short on 1-second candles.
 *
 * The owner (2026-11-13): "its basically like a chart that goes up and down yk like crypto or stocks
 * and ppl can long or short it with a leverage of up to 1000x", then "i want it to be way more
 * volatile i want it to be made to trade on 1s timeframes", "it looks so laggy also make the candles
 * have nice animations", "remake the frontend like u did with other games" and "make sure its
 * volatile asf and risky asf and not some 2x leverage shit".
 *
 * So it is built as Limbo and Crash are (assets/css/stocks.css): the order in the shared betting
 * panel on the left -- long or short, the stake with ½ 2× Max, the leverage (10x and up) with its
 * picks, the liquidation price, the one gold button -- with your positions under it, as Crash lists
 * the round's players; the market on the stage to the right: the trades that just settled, the price,
 * and a chart of 1-second candles drawn every frame.
 *
 * Every figure that decides money is the server's (services/api-gateway/src/lib/stocks.ts). This page
 * draws the ticks the server publishes (`stocks_tick` on the live stream: past ticks only, never a
 * future one) and shows a position's running value with the formula the server settles with.
 */
import { api, idempotencyKey } from './api.js';
import { bus, refreshBalance, showBalance, state } from './store.js';
import { $, adjustStake, formatAmountInput, money, parseAmount } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

/* Nothing under 10x: the server refuses less (STOCKS_MIN_LEVERAGE). */
const LEVERAGE_PICKS = [10, 50, 100, 500, 1000];
/* `mark` every so many candles on the time axis; both divide an epoch's candles, so the marks stay
 * on the same seconds from one epoch to the next. */
const FRAMES = [
  { label: '1s', ticks: 10, candles: 90, mark: 15 },
  { label: '5s', ticks: 50, candles: 60, mark: 12 },
];
const KEEP_TICKS = 3200;
/** Settled trades in the strip at the top of the stage. */
const RECENT = 14;

let root = null;
let cfg = null;
let close = [];
let low = [];
let high = [];
let lastSeq = null;
let lastTick = null;
/** The tick of the newest close, counted from the first epoch: candles line up on it across epochs. */
let headTick = 0;
let epochTicks = 1200;
let epochStart = 0;
let positions = [];
let feed = [];
const fresh = new Set();
let side = 'long';
let leverage = 100;
let stakeText = '';
let frameIndex = 0;
let busy = false;
let loading = false;
let queued = [];

/* ─────────── motion ───────────
 * The server publishes a tick every 100ms; the chart is drawn every frame in between. Time scrolls the
 * candles continuously, the live price and the forming candle glide to each new tick, the price
 * range eases to fit, and a new candle grows in. The figures that matter (positions, liquidation)
 * are always the real last tick; only the drawing moves smoothly. */
const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let raf = 0;
let lastFrame = 0;
let arrivedAt = 0;
let chartW = 0;
let chartH = 0;
let bars = [];
let target = { lo: 0, hi: 1 };
let palette = null;
const view = { s: null, p: null, lo: null, hi: null, fh: 0, fl: 0, mix: 1, form: null, price: '' };
const lineBorn = new Map();

/* ─────────── the server's maths, for display ─────────── */

const ratio = (stepPpm = cfg.stepPpm) => 1 + stepPpm / 1_000_000;
const priceOf = (level, stepPpm) => cfg.basePrice * ratio(stepPpm) ** level;
/** Two decimals while the price is in the hundreds or more; more as it falls, so a move still shows. */
const fmtPrice = (value) => {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const minLeverage = () => cfg?.minLeverage ?? 10;
const maxLeverage = () => cfg?.maxLeverage ?? 1000;

/** The grid level of liquidation nearest to where the loss reaches the stake (lib/stocks.ts). */
function liquidationLevels(sideName, lev) {
  const lnU = Math.log(ratio());
  const room = 1 - cfg.edgeBps / 10_000;
  const exact = sideName === 'long' ? -Math.log(1 - room / lev) / lnU : Math.log(1 + room / lev) / lnU;
  return Math.round(exact);
}
/** The leverage that makes the fee exactly the edge at that level. */
function effectiveLeverage(sideName, n, stepPpm = cfg.stepPpm, feePpm = cfg.edgeBps * 100) {
  const u = ratio(stepPpm);
  const room = 1 - feePpm / 1_000_000;
  return sideName === 'long' ? room / (1 - u ** -n) : room / (u ** n - 1);
}
function payoutAt(p, level) {
  const u = ratio(p.stepPpm);
  const delta = level - p.openLevel;
  const n = Math.abs(p.liquidationLevel - p.openLevel);
  const share = p.side === 'long' ? u ** delta - u ** -n : u ** n - u ** delta;
  const value = Number(p.stakeMinor) * p.effectiveLeverage * share;
  return Math.max(0, Math.min(Number(p.maxPayoutMinor), Math.floor(value)));
}
const levText = (lev) => (Math.abs(lev - Math.round(lev)) < 0.05 ? `${Math.round(lev)}×` : `${lev.toFixed(1)}×`);
const nowLevel = () => (close.length ? close[close.length - 1] : 0);
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const arrow = (sideName) => (sideName === 'long' ? '▲' : '▼');
/** Candles on screen: half as many on a narrow chart, so each stays readable. */
function visibleCandles() {
  const frame = FRAMES[frameIndex];
  return (chartW || 800) < 480 ? Math.round(frame.candles / 2) : frame.candles;
}

/* ─────────── data ─────────── */

/** After an epoch ends: its successor's details, leaving the chart running. */
let refreshing = false;
async function refreshEpoch() {
  if (refreshing || loading || !cfg) return;
  refreshing = true;
  try {
    const data = await api.get('/v1/stocks?span=10');
    if (!loading && data.now.seq === lastSeq) {
      cfg = data;
      epochStart = Date.parse(data.epoch.startsAt);
    }
  } catch {
    // The next epoch's change tries again.
  } finally {
    refreshing = false;
  }
}

/** The whole market, and every tick that arrives meanwhile after it. */
async function load() {
  if (loading) return;
  loading = true;
  try {
    const data = await api.get(`/v1/stocks?span=${KEEP_TICKS}`);
    cfg = data;
    close = data.history.close;
    low = data.history.low;
    high = data.history.high;
    lastSeq = data.now.seq;
    lastTick = data.now.tick;
    epochTicks = data.epoch.ticks;
    epochStart = Date.parse(data.epoch.startsAt);
    headTick = lastSeq * epochTicks + lastTick;
    arrivedAt = performance.now();
    positions = data.positions;
    feed = (data.feed ?? []).slice(0, RECENT);
    leverage = Math.max(minLeverage(), Math.min(maxLeverage(), leverage));
    paint();
  } catch (error) {
    if (root) $('#stocksHint', root).textContent = error?.message || 'The market could not be reached.';
  } finally {
    loading = false;
    // Ticks that came in while the market was being read: whatever is newer than it, in order.
    const waiting = queued;
    queued = [];
    if (cfg) for (const d of waiting) takeTicks(d);
  }
}

/**
 * One of YOUR positions changed (the server sends `stocks` to its owner only): read them again, and
 * say so when the market ended one -- a liquidation, or the payout cap.
 */
let mineTimer = 0;
function onMine() {
  if (!root?.isConnected || mineTimer) return;
  mineTimer = setTimeout(async () => {
    mineTimer = 0;
    try {
      const data = await api.get('/v1/stocks?span=10');
      const before = new Map(positions.map((p) => [p.id, p.status]));
      positions = data.positions;
      for (const p of positions) {
        if (before.get(p.id) !== 'open' || p.status === 'open') continue;
        if (p.status === 'liquidated') {
          playSound('lose');
          toast({ kind: 'lose', title: 'Liquidated', body: `${p.side === 'long' ? 'Long' : 'Short'} ${levText(p.effectiveLeverage)} · −${money(Number(p.stakeMinor))}` });
          say(`Your ${p.side} position was liquidated.`);
        } else if (p.status === 'capped') {
          playSound('win');
          toast({ kind: 'win', title: `${signed(Number(p.payoutMinor) - Number(p.stakeMinor))}`, body: 'Closed at the most a position can win' });
        }
      }
      rebuildBars();
      paintBook(false);
      void refreshBalance();
    } catch {
      // The next change reads them again.
    }
  }, 120);
}

/** Trades that just settled, anyone's, for the strip (the server's `stocks_feed`). */
function onFeed(event) {
  if (!root?.isConnected || !cfg) return;
  const rows = Array.isArray(event.detail?.rows) ? event.detail.rows : [];
  const known = new Set(feed.map((row) => row.id));
  const added = rows.filter((row) => row && !known.has(row.id));
  if (!added.length) return;
  for (const row of added) fresh.add(row.id);
  feed = [...added, ...feed].slice(0, RECENT);
  paintStrip();
}

/** New ticks from the live stream. */
function onTicks(event) {
  if (!root?.isConnected) return;
  const d = event.detail || {};
  if (!Array.isArray(d.levels) || !d.levels.length) return;
  if (loading || !cfg) {
    queued.push(d);
    if (queued.length > 50) queued.shift();
    if (!loading) void load();
    return;
  }
  takeTicks(d);
}

/** Adds the ticks after the newest one held, into the next epoch too; a gap reads the market again. */
function takeTicks(d) {
  const count = d.seq === lastSeq
    ? d.tick - lastTick
    : d.seq === lastSeq + 1
      ? d.tick + 1 + (epochTicks - 1 - lastTick)
      : null;
  if (count === null || d.levels.length < count) {
    void load();
    return;
  }
  if (count <= 0) return;
  close.push(...d.levels.slice(-count));
  low.push(...(d.lows ?? d.levels).slice(-count));
  high.push(...(d.highs ?? d.levels).slice(-count));
  if (close.length > KEEP_TICKS) {
    close = close.slice(-KEEP_TICKS);
    low = low.slice(-KEEP_TICKS);
    high = high.slice(-KEEP_TICKS);
  }
  if (d.seq !== lastSeq) {
    // The next epoch, announced in advance; its own details are read again a moment later.
    epochStart = cfg.nextEpoch?.seq === d.seq ? Date.parse(cfg.nextEpoch.startsAt) : epochStart + epochTicks * cfg.tickMs;
    lastSeq = d.seq;
    setTimeout(() => void refreshEpoch(), 300 + Math.random() * 1500);
  }
  lastTick = d.tick;
  headTick = lastSeq * epochTicks + lastTick;
  arrivedAt = performance.now();
  rebuildBars();
  paintQuote();
  paintBook(true);
  paintLiquidation();
  wake();
}

/* ─────────── orders ─────────── */

const stakeMinor = () => {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(Math.floor(value));
};

function orderProblem() {
  if (!cfg) return 'Loading the market…';
  if (!cfg.enabled) return 'Stocks is closed right now.';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake.';
  if (stake < BigInt(cfg.minStakeMinor)) return `The smallest stake is ${money(Number(cfg.minStakeMinor))}.`;
  if (stake > BigInt(cfg.maxStakeMinor)) return `The largest stake is ${money(Number(cfg.maxStakeMinor))}.`;
  if (stake > BigInt(state.balanceMinor || '0')) return 'Your balance is too low for that.';
  return '';
}

function say(text) {
  const live = root && $('#stocksSay', root);
  if (live) live.textContent = text;
}

async function placeOrder() {
  if (busy) return;
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (orderProblem()) return;
  busy = true;
  paintOrder();
  try {
    const response = await api.post(
      '/v1/stocks/positions',
      { side, stakeMinor: String(stakeMinor()), leverage },
      { idempotencyKey: idempotencyKey() },
    );
    if (response.balanceAfterMinor) showBalance(response.balanceAfterMinor);
    playSound('coin');
    positions = [response.position, ...positions.filter((p) => p.id !== response.position.id)];
    say(`${side === 'long' ? 'Long' : 'Short'} ${leverage}x opened at ${fmtPrice(response.position.entryPrice)}.`);
  } catch (error) {
    toast({ kind: 'lose', title: 'Order not placed', body: error?.message || 'Try again.' });
  } finally {
    busy = false;
    paint();
  }
}

async function closePosition(id) {
  const button = root.querySelector(`[data-close="${id}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = 'Closing';
  }
  try {
    const response = await api.post('/v1/stocks/close', { positionId: id });
    if (response.balanceAfterMinor) showBalance(response.balanceAfterMinor);
    const p = response.position;
    positions = positions.map((row) => (row.id === p.id ? p : row));
    const profit = Number(p.payoutMinor) - Number(p.stakeMinor);
    if (p.status === 'liquidated') {
      playSound('lose');
      toast({ kind: 'lose', title: 'Liquidated', body: 'The price reached your liquidation level first.' });
    } else {
      playSound(profit > 0 ? 'win' : 'coin');
      toast({ kind: profit > 0 ? 'win' : 'lose', title: signed(profit), body: `${p.side === 'long' ? 'Long' : 'Short'} ${levText(p.effectiveLeverage)} closed` });
    }
    say(`Position closed: ${signed(profit)}.`);
  } catch (error) {
    toast({ kind: 'lose', title: 'Could not close', body: error?.message || 'Try again.' });
  } finally {
    void refreshBalance();
    paint();
  }
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root?.isConnected) return;
  rebuildBars();
  paintQuote();
  paintOrder();
  paintBook(false);
  paintStrip();
  wake();
}

/** The change over the candles on screen; the price itself is painted every frame (`step`). */
function paintQuote() {
  if (!cfg || !close.length) return;
  const frame = FRAMES[frameIndex];
  const span = Math.min(close.length, frame.ticks * visibleCandles());
  const first = close[close.length - span];
  const change = (priceOf(nowLevel()) / priceOf(first) - 1) * 100;
  const delta = $('#stocksChange', root);
  delta.textContent = `${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%`;
  delta.dataset.dir = change > 0 ? 'up' : change < 0 ? 'down' : '';
  delta.title = `Over the last ${visibleCandles() * frame.ticks / 10} seconds`;
}

/** The one figure of the order that moves with the price. */
function paintLiquidation() {
  if (!cfg) return;
  const n = liquidationLevels(side, leverage);
  const level = nowLevel();
  const liq = side === 'long' ? level - n : level + n;
  const move = (priceOf(liq) / priceOf(level) - 1) * 100;
  $('#stocksLiq', root).textContent = fmtPrice(priceOf(liq));
  $('#stocksLiqMove', root).textContent = `${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(Math.abs(move) < 1 ? 3 : 2)}% away`;
}

function paintOrder() {
  if (!cfg) return;
  const sides = $('.stocks__sides', root);
  sides.dataset.side = side;
  for (const b of root.querySelectorAll('[data-side-pick]')) {
    b.setAttribute('aria-checked', String(b.dataset.sidePick === side));
    b.tabIndex = b.dataset.sidePick === side ? 0 : -1;
    b.disabled = busy;
  }
  const levInput = $('#stocksLev', root);
  if (document.activeElement !== levInput) levInput.value = String(leverage);
  for (const pick of root.querySelectorAll('[data-lev]')) {
    const value = Number(pick.dataset.lev);
    pick.hidden = value > maxLeverage() || value < minLeverage();
    pick.setAttribute('aria-pressed', String(value === leverage));
    pick.disabled = busy;
  }
  for (const key of root.querySelectorAll('.stocks__adj')) key.disabled = busy;
  $('#stocksStake', root).disabled = busy;
  levInput.disabled = busy;

  const stake = stakeMinor();
  const n = liquidationLevels(side, leverage);
  const runs = n >= 1 ? effectiveLeverage(side, n) : leverage;
  /* Not the position's size (the owner, 11-13: players "will think they are betting 20b"): what a 1%
   * move their way would win, on the formula the server settles with, within the payout cap. */
  if (stake && n >= 1) {
    const u = ratio();
    const share = side === 'long' ? 1.01 - u ** -n : u ** n - 0.99;
    const paid = Math.min(Number(cfg.maxPayoutMinor), Math.floor(Number(stake) * runs * share));
    $('#stocksWin', root).textContent = `+${money(Math.max(0, paid - Number(stake)))}`;
  } else {
    $('#stocksWin', root).textContent = '—';
  }
  $('#stocksFee', root).textContent = stake ? `fee ${money(Number(stake) * cfg.edgeBps / 10_000)} (10%)` : 'fee 10%';
  $('#stocksRuns', root).textContent = `runs at ${levText(runs)}`;
  paintLiquidation();

  const go = $('#stocksGo', root);
  const problem = state.authenticated ? orderProblem() : '';
  go.disabled = busy || (state.authenticated && Boolean(problem));
  go.setAttribute('aria-busy', String(busy));
  $('#stocksGoLabel', root).textContent = !state.authenticated
    ? 'Log in to trade'
    : busy
      ? 'Placing order…'
      : `${side === 'long' ? 'Long' : 'Short'} ${leverage}× · ${money(Number(stake ?? 0n))}`;
  $('#stocksHint', root).textContent = problem;
}

/** Your positions. `live` repaints only the running results, so a Close key keeps its focus. */
function paintBook(live) {
  const book = $('#stocksBook', root);
  const open = positions.filter((p) => p.status === 'open');
  const done = positions.filter((p) => p.status !== 'open').slice(0, 3);
  $('#stocksOpenN', root).textContent = open.length ? `${open.length} open` : '';
  if (live) {
    for (const p of open) {
      const row = book.querySelector(`[data-id="${p.id}"]`);
      if (row) fillRunning(row, p);
    }
    return;
  }
  if (!state.authenticated) {
    book.replaceChildren(empty('Log in to trade. Your positions show here.'));
    return;
  }
  if (!open.length && !done.length) {
    book.replaceChildren(empty('None yet. Pick long or short, a stake and a leverage.'));
    return;
  }
  book.replaceChildren(...open.map(openRow), ...done.map(doneRow));
}

function empty(text) {
  const li = document.createElement('li');
  li.className = 'stocks__empty';
  li.textContent = text;
  return li;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tagOf(p) {
  const tag = el('b', 'stocks__tag');
  tag.dataset.side = p.side;
  tag.append(el('i', '', arrow(p.side)), `${p.side === 'long' ? 'Long' : 'Short'} ${levText(p.effectiveLeverage)}`);
  tag.querySelector('i').setAttribute('aria-hidden', 'true');
  return tag;
}

function openRow(p) {
  const row = el('li', 'stocks__pos');
  row.dataset.id = p.id;
  row.dataset.side = p.side;
  const head = el('div', 'stocks__posrow');
  head.append(tagOf(p), el('span', 'stocks__pnl'));
  const sub = el('div', 'stocks__posrow');
  const facts = el('span', 'stocks__sub');
  facts.append(el('b', '', money(Number(p.stakeMinor))), ` at ${fmtPrice(p.entryPrice)} · liq. ${fmtPrice(p.liquidationPrice)}`);
  const button = el('button', 'stocks__close', 'Close');
  button.type = 'button';
  button.dataset.close = p.id;
  button.setAttribute('aria-label', `Close the ${p.side} at ${levText(p.effectiveLeverage)}`);
  sub.append(facts, button);
  row.append(head, sub);
  fillRunning(row, p);
  return row;
}

function fillRunning(row, p) {
  const value = payoutAt(p, nowLevel());
  const profit = value - Number(p.stakeMinor);
  const pct = (profit / Number(p.stakeMinor)) * 100;
  const pnl = $('.stocks__pnl', row);
  pnl.textContent = `${signed(profit)}  ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
  pnl.dataset.dir = profit > 0 ? 'up' : profit < 0 ? 'down' : '';
}

function doneRow(p) {
  const row = el('li', 'stocks__pos');
  row.dataset.side = p.side;
  row.dataset.done = '1';
  const profit = Number(p.payoutMinor) - Number(p.stakeMinor);
  const head = el('div', 'stocks__posrow');
  const result = el('span', 'stocks__pnl', p.status === 'liquidated' ? `Liquidated  −${money(Number(p.stakeMinor))}` : signed(profit));
  result.dataset.dir = profit > 0 ? 'up' : 'down';
  head.append(tagOf(p), result);
  const sub = el('div', 'stocks__posrow');
  const facts = el('span', 'stocks__sub');
  facts.append(el('b', '', money(Number(p.stakeMinor))), ` at ${fmtPrice(p.entryPrice)} → ${p.closePrice ? fmtPrice(p.closePrice) : '—'}`);
  sub.append(facts, el('span', 'stocks__state', p.status === 'capped' ? 'Max win' : p.status === 'liquidated' ? 'Liquidated' : 'Closed'));
  row.append(head, sub);
  return row;
}

/** The strip: settled trades as what they paid on the stake, newest first, as Crash's rounds. */
function paintStrip() {
  const strip = root && $('#stocksRecent', root);
  if (!strip) return;
  if (!feed.length) {
    strip.replaceChildren(el('li', 'stocks__quiet', 'Trades show here as they settle.'));
    return;
  }
  strip.replaceChildren(...feed.map((row) => {
    const stake = Number(row.stakeMinor);
    const paid = Number(row.payoutMinor ?? 0);
    const multiple = stake > 0 ? paid / stake : 0;
    const chip = el('li', 'stocks__chip');
    chip.dataset.tone = paid > stake ? 'won' : 'lost';
    if (fresh.has(row.id)) chip.dataset.fresh = '1';
    const mark = el('i', '', arrow(row.side));
    mark.setAttribute('aria-hidden', 'true');
    chip.append(mark, `${multiple.toFixed(2)}×`);
    chip.title = `${row.player} · ${row.side === 'long' ? 'Long' : 'Short'} ${row.leverage}× · ${money(stake)} → ${row.status === 'liquidated' ? 'liquidated' : money(paid)}`;
    return chip;
  }));
  fresh.clear();
}

/* ─────────── the chart: candles ─────────── */

const token = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - (1 - x) ** 3;

function rgbOf(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
  }
  return null;
}

/** The theme's colours, read once a mount (a theme can change on the settings page). */
function readPalette() {
  const up = token('--stocks-up', '#3fbf86');
  const down = token('--stocks-down', '#e5544b');
  palette = {
    ink: token('--lx-ink', '#eee'),
    mute: token('--lx-mute', '#888'),
    line: token('--lx-2', '#222'),
    up,
    down,
    upRgb: rgbOf(up),
    downRgb: rgbOf(down),
    gold: token('--lx-gold', '#f5b800'),
    onGold: token('--lx-on-gold', '#1a1300'),
    ui: token('--lx-ui', 'sans-serif'),
  };
}

/** Between down (0) and up (1), for the forming candle as its price crosses its open. */
function candleColor(mix) {
  const { upRgb, downRgb, up, down } = palette;
  if (!upRgb || !downRgb) return mix >= 0.5 ? up : down;
  const c = upRgb.map((u, i) => Math.round(downRgb[i] + (u - downRgb[i]) * mix));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * The candles of `per` ticks around the screen, oldest first, from the ticks held; the newest is
 * still forming. Each carries the tick it starts on, counted from the first epoch, so time moves
 * them, and the range they need on screen is worked out here, once a tick, not once a frame.
 */
function rebuildBars() {
  if (!cfg || !close.length) return;
  const per = FRAMES[frameIndex].ticks;
  const want = visibleCandles() + 3;
  const end = close.length;
  const firstTick = headTick - (end - 1);
  const out = [];
  for (let start = headTick - (headTick % per); out.length < want; start -= per) {
    const i0 = Math.max(0, start - firstTick);
    const i1 = Math.min(end, start - firstTick + per);
    if (i1 <= i0) break;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < i1; i += 1) {
      if (low[i] < lo) lo = low[i];
      if (high[i] > hi) hi = high[i];
    }
    const open = i0 > 0 ? close[i0 - 1] : close[i0];
    out.push({ start, open, close: close[i1 - 1], low: Math.min(lo, open), high: Math.max(hi, open) });
  }
  bars = out.reverse();

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars.slice(-visibleCandles())) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  const span = Math.max(hi - lo, 30);
  for (const p of positions) {
    if (p.status !== 'open') continue;
    for (const level of [p.openLevel, p.liquidationLevel]) {
      if (level >= lo - span * 0.5 && level <= hi + span * 0.5) {
        lo = Math.min(lo, level);
        hi = Math.max(hi, level);
      }
    }
  }
  if (hi - lo < 30) {
    const mid = (hi + lo) / 2;
    lo = mid - 15;
    hi = mid + 15;
  }
  const pad = Math.max(4, (hi - lo) * 0.12);
  target = { lo: lo - pad, hi: hi + pad };
}

/* ── the frame loop: runs while the chart is on screen, stops when it is not ── */

function wake() {
  if (raf || !root?.isConnected || !cfg || chartW <= 0 || document.hidden) return;
  lastFrame = 0;
  if (!palette) readPalette();
  raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  if (!root?.isConnected || !cfg || chartW <= 0 || document.hidden) return;
  step(now);
  drawChart(now);
  raf = requestAnimationFrame(frame);
}

/** Moves everything drawn a little toward where the market is; snaps after a pause. */
function step(now) {
  const dt = lastFrame ? Math.min(250, now - lastFrame) : 1000;
  lastFrame = now;
  const still = Boolean(calm?.matches);
  const ease = (tau) => (still ? 1 : 1 - Math.exp(-dt / tau));
  const real = nowLevel();

  // Time, in ticks: the newest tick plus however long ago it came, never more than two ahead.
  const tickMs = cfg.tickMs || 100;
  const s = still ? headTick : headTick + Math.min(2, (now - arrivedAt) / tickMs);
  view.s = view.s === null || Math.abs(s - view.s) > 20 ? s : view.s + (s - view.s) * ease(90);

  const jump = view.p === null || Math.abs(real - view.p) > 2000;
  view.p = jump ? real : view.p + (real - view.p) * ease(70);

  const form = bars[bars.length - 1];
  if (form && form.start !== view.form) {
    view.form = form.start;
    view.fh = view.fl = form.open;
  }
  if (form) {
    view.fh += (form.high - view.fh) * ease(70);
    view.fl += (form.low - view.fl) * ease(70);
    view.mix += ((view.p >= form.open ? 1 : 0) - view.mix) * ease(110);
  }

  // The range: out quickly when the price breaks it, back in slowly.
  if (view.lo === null || jump) {
    view.lo = target.lo;
    view.hi = target.hi;
  } else {
    const lo = Math.min(target.lo, view.p - 4);
    const hi = Math.max(target.hi, view.p + 4);
    view.lo += (lo - view.lo) * ease(lo < view.lo ? 80 : 320);
    view.hi += (hi - view.hi) * ease(hi > view.hi ? 80 : 320);
  }

  const text = fmtPrice(priceOf(view.p));
  if (text !== view.price) {
    view.price = text;
    $('#stocksPrice', root).textContent = text;
  }
}

function clockOf(tick) {
  const at = new Date(epochStart + (tick - lastSeq * epochTicks) * (cfg.tickMs || 100));
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** A step of 1, 2, 2.5 or 5 times a power of ten near `raw`, for the price lines. */
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * power;
}

function drawChart(now = performance.now()) {
  const canvas = root && $('#stocksCanvas', root);
  if (!canvas || !cfg || !palette || !bars.length || chartW <= 0 || view.s === null) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(240, Math.floor(chartW));
  const height = Math.max(200, Math.floor(chartH));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const { ink, mute, line, down, gold, onGold, ui } = palette;
  const still = Boolean(calm?.matches);

  const frameDef = FRAMES[frameIndex];
  const per = frameDef.ticks;
  const shown = visibleCandles();
  const axis = 76;
  const plotW = width - axis;
  const top = 10;
  const plotH = height - 26;
  const { lo, hi } = view;
  const y = (level) => top + (1 - (level - lo) / (hi - lo)) * plotH;
  const lnU = Math.log(ratio());
  const levelOf = (price) => Math.log(price / cfg.basePrice) / lnU;
  const slot = plotW / shown;
  // The forming candle sits a little in from the axis; older ones slide left as time passes.
  const anchor = plotW - slot * 1.6;
  const xOf = (start) => anchor - ((view.s - (start + per / 2)) / per) * slot;

  // Price lines on round prices, so they glide with the range rather than renumber.
  const pLo = priceOf(target.lo);
  const pHi = priceOf(target.hi);
  const priceStep = niceStep(Math.max(1e-6, (pHi - pLo) / 5));
  const lines = [];
  for (let v = Math.ceil(priceOf(lo) / priceStep) * priceStep; v <= priceOf(hi) && lines.length < 40; v += priceStep) lines.push(v);
  ctx.lineWidth = 1;
  ctx.font = `600 11px ${ui}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const v of lines) {
    const yy = Math.round(y(levelOf(v))) + 0.5;
    const fade = clamp01((yy - top) / 14) * clamp01((top + plotH - yy) / 14);
    if (fade <= 0) continue;
    ctx.globalAlpha = fade;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW, yy);
    ctx.stroke();
    ctx.fillStyle = mute;
    ctx.fillText(fmtPrice(v), plotW + 10, yy);
  }
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, plotW, height);
  ctx.clip();

  // The time axis: clock marks on whole candles, moving with them.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = mute;
  for (const b of bars) {
    if ((b.start / per) % frameDef.mark !== 0) continue;
    const x = xOf(b.start) - slot / 2;
    const fade = clamp01((x - 20) / 40) * clamp01((plotW - 24 - x) / 30);
    if (fade <= 0) continue;
    ctx.globalAlpha = fade;
    ctx.fillText(clockOf(b.start), x, height - 6);
  }
  ctx.globalAlpha = 1;

  // Candles. The newest grows in, follows the live price and turns as it crosses its open.
  const bodyW = Math.max(1, slot * 0.62);
  const form = bars[bars.length - 1];
  for (const b of bars) {
    const x = xOf(b.start);
    if (x < -slot || x > plotW + slot) continue;
    const forming = b === form;
    let open = b.open;
    let shut = b.close;
    let top_ = b.high;
    let bottom = b.low;
    let color = shut >= open ? palette.up : down;
    let w = bodyW;
    let alpha = 1;
    if (forming) {
      shut = view.p;
      top_ = Math.max(view.fh, view.p, open);
      bottom = Math.min(view.fl, view.p, open);
      color = candleColor(view.mix);
      const grown = still ? 1 : easeOut(clamp01(((view.s - b.start) * (cfg.tickMs || 100)) / 260));
      w = bodyW * (0.35 + 0.65 * grown);
      alpha = 0.25 + 0.75 * grown;
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const yHigh = y(top_);
    const yLow = y(bottom);
    ctx.fillRect(x - 0.5, yHigh, 1, Math.max(1, yLow - yHigh));
    const yTop = y(Math.max(open, shut));
    const yBottom = y(Math.min(open, shut));
    ctx.fillRect(x - w / 2, yTop, w, Math.max(1, yBottom - yTop));
  }
  ctx.globalAlpha = 1;

  // Your positions: entry and liquidation, dashed, drawn in from the right when they open.
  const open = positions.filter((p) => p.status === 'open');
  const live = new Set(open.map((p) => p.id));
  for (const id of lineBorn.keys()) if (!live.has(id)) lineBorn.delete(id);
  ctx.setLineDash([4, 4]);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const marks = [];
  for (const p of open) {
    if (!lineBorn.has(p.id)) lineBorn.set(p.id, now);
    const drawn = still ? 1 : easeOut(clamp01((now - lineBorn.get(p.id)) / 420));
    for (const [level, color, label] of [[p.openLevel, ink, 'Entry'], [p.liquidationLevel, down, 'Liq.']]) {
      if (level < lo || level > hi) continue;
      const yy = Math.round(y(level)) + 0.5;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55 * drawn;
      ctx.beginPath();
      ctx.moveTo(plotW, yy);
      ctx.lineTo(plotW * (1 - drawn), yy);
      ctx.stroke();
      marks.push({ yy, label, color, drawn, at: yy - 2 });
    }
  }
  // Their labels, kept clear of each other when entries sit close together.
  marks.sort((a, b) => a.yy - b.yy);
  for (let k = 1; k < marks.length; k += 1) marks[k].at = Math.max(marks[k].at, marks[k - 1].at + 12);
  for (const m of marks) {
    ctx.globalAlpha = m.drawn;
    ctx.fillStyle = m.color;
    ctx.fillText(m.label, 6, m.at);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // The live price: a hairline across, and a dot on the forming candle.
  const yNow = y(view.p);
  ctx.strokeStyle = gold;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(yNow) + 0.5);
  ctx.lineTo(plotW, Math.round(yNow) + 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (form) {
    ctx.fillStyle = gold;
    ctx.beginPath();
    ctx.arc(xOf(form.start) + bodyW / 2 + 5, yNow, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Its tag on the axis, gliding with it.
  const tagH = 20;
  const tagY = Math.min(top + plotH - tagH / 2, Math.max(top + tagH / 2, yNow));
  ctx.fillStyle = gold;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(plotW + 4, tagY - tagH / 2, axis - 6, tagH, 4);
  else ctx.rect(plotW + 4, tagY - tagH / 2, axis - 6, tagH);
  ctx.fill();
  ctx.fillStyle = onGold;
  ctx.font = `800 11px ${ui}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(view.price || fmtPrice(priceOf(view.p)), plotW + 10, tagY + 0.5);
}

/* ─────────── building ─────────── */

function build() {
  root.innerHTML = `
    <section class="stocks__stage" aria-label="The DONUT market">
      <div class="stocks__top">
        <ol class="stocks__recent" id="stocksRecent" aria-label="Trades that just settled, newest first"></ol>
      </div>
      <div class="stocks__head">
        <div class="stocks__quote">
          <span class="stocks__sym"><img src="assets/img/items/game-stocks.svg" alt="" width="16" height="16" />DONUT</span>
          <div class="stocks__line">
            <b class="stocks__price" id="stocksPrice">—</b>
            <span class="stocks__change" id="stocksChange"></span>
          </div>
        </div>
        <div class="stocks__frames" role="group" aria-label="Candle size">
          ${FRAMES.map((f, i) => `<button type="button" class="stocks__pick" data-frame="${i}" aria-pressed="${i === frameIndex}">${f.label}</button>`).join('')}
        </div>
      </div>
      <div class="stocks__chart"><canvas id="stocksCanvas" role="img" aria-label="The DONUT price in candles"></canvas></div>
    </section>

    <aside class="stocks__panel" aria-label="Your order and positions">
      <form class="stocks__form" id="stocksForm" novalidate>
        <div class="stocks__sides" role="radiogroup" aria-label="Direction" data-side="long">
          <button type="button" class="stocks__side" role="radio" data-side-pick="long" aria-checked="true"><i aria-hidden="true">▲</i>Long</button>
          <button type="button" class="stocks__side" role="radio" data-side-pick="short" aria-checked="false"><i aria-hidden="true">▼</i>Short</button>
        </div>
        <label class="stocks__label" for="stocksStake">Stake</label>
        <div class="stocks__field">
          <span aria-hidden="true">$</span>
          <input id="stocksStake" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off" spellcheck="false" placeholder="0" />
          <button type="button" class="stocks__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="stocks__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="stocks__adj" data-adj="max" aria-label="Stake the most you can">Max</button>
        </div>
        <label class="stocks__label stocks__label--row" for="stocksLev"><span>Leverage</span><span class="stocks__labelx" id="stocksRuns"></span></label>
        <div class="stocks__field stocks__field--lev">
          <input id="stocksLev" inputmode="numeric" autocomplete="off" spellcheck="false" />
          <span aria-hidden="true">×</span>
        </div>
        <div class="stocks__picks" role="group" aria-label="Leverage picks">
          ${LEVERAGE_PICKS.map((v) => `<button type="button" class="stocks__pick" data-lev="${v}">${v}×</button>`).join('')}
        </div>
        <label class="stocks__label stocks__label--row" for="stocksWin"><span>Win if it moves 1% your way</span><span class="stocks__labelx" id="stocksFee"></span></label>
        <div class="stocks__field stocks__field--read"><output id="stocksWin" for="stocksStake stocksLev">—</output></div>
        <label class="stocks__label stocks__label--row" for="stocksLiq"><span>Lose your stake at</span><span class="stocks__labelx" id="stocksLiqMove"></span></label>
        <div class="stocks__field stocks__field--read"><output id="stocksLiq" for="stocksLev">—</output></div>
        <button class="btn stocks__go" id="stocksGo" type="submit" data-sfx="none"><span id="stocksGoLabel">Loading…</span></button>
        <p class="stocks__hint" id="stocksHint" aria-live="polite"></p>
      </form>
      <section class="stocks__book" aria-labelledby="stocksBookH">
        <header class="stocks__bookhead"><h2 id="stocksBookH">Your positions</h2><span id="stocksOpenN"></span></header>
        <ul class="stocks__list" id="stocksBook"></ul>
      </section>
    </aside>
    <div class="stocks__say" id="stocksSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#stocksStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintOrder(); });
  root.querySelectorAll('.stocks__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    const largest = cfg ? BigInt(cfg.maxStakeMinor) : 0n;
    stakeText = formatAmountInput(Number(adjustStake(button.dataset.adj, current, state.balanceMinor, largest)));
    stake.value = stakeText;
    paintOrder();
  }));

  // Long or short: a radio group, so the arrow keys move between the two.
  const picks = [...root.querySelectorAll('[data-side-pick]')];
  const choose = (name, focus = false) => {
    side = name;
    paintOrder();
    rebuildBars();
    if (focus) picks.find((b) => b.dataset.sidePick === name)?.focus();
  };
  picks.forEach((b) => {
    b.addEventListener('click', () => choose(b.dataset.sidePick));
    b.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      choose(side === 'long' ? 'short' : 'long', true);
    });
  });

  const setLeverage = (value) => {
    leverage = Math.max(minLeverage(), Math.min(maxLeverage(), Math.round(value) || minLeverage()));
    paintOrder();
  };
  const levInput = $('#stocksLev', root);
  levInput.addEventListener('input', () => {
    const value = Number(String(levInput.value).replace(/[^\d]/g, ''));
    if (value >= minLeverage()) {
      leverage = Math.min(maxLeverage(), value);
      paintOrder();
    }
  });
  levInput.addEventListener('blur', () => setLeverage(Number(String(levInput.value).replace(/[^\d]/g, '')) || leverage));
  root.querySelectorAll('[data-lev]').forEach((b) => b.addEventListener('click', () => setLeverage(Number(b.dataset.lev))));

  root.querySelectorAll('[data-frame]').forEach((b) => b.addEventListener('click', () => {
    frameIndex = Number(b.dataset.frame);
    root.querySelectorAll('[data-frame]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    view.form = null;
    paint();
  }));
  $('#stocksForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void placeOrder();
  });
  $('#stocksBook', root).addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-close]');
    if (button && !button.disabled) void closePosition(button.dataset.close);
  });
  // The chart's size, kept here so a frame never has to measure; zero while the page is hidden.
  new ResizeObserver(([entry]) => {
    const wasHidden = chartW <= 0;
    chartW = entry.contentRect.width;
    chartH = entry.contentRect.height;
    if (wasHidden && chartW > 0) readPalette();
    rebuildBars();
    if (raf === 0 && chartW > 0) drawChart();
    wake();
  }).observe($('.stocks__chart', root));
}

export function mountStocks(section) {
  root = $('#stocksRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    window.addEventListener('donut:stocks-tick', onTicks);
    window.addEventListener('donut:stocks', onMine);
    window.addEventListener('donut:stocks-feed', onFeed);
    document.addEventListener('visibilitychange', () => wake());
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['ready', 'login', 'logout'].includes(event.detail)) void load();
      else if (!busy) paintOrder();
    });
  }
  readPalette();
  void load();
}
