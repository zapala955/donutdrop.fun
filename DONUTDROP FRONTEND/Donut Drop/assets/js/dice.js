/* dice.js — a roll from 0.00 to 99.99, and a line the player draws through it.
 *
 * The server owns the roll. One request places the bet, draws the roll from the player's committed
 * fairness seed and pays a win, all at once (routes/dice.ts); this page draws the line, prices it
 * before anything is sent, and then shows a roll that already exists.
 *
 * The line can be set four ways, because dragging must never be the only one: the slider (arrow
 * keys move it a whole point, Shift+arrow a hundredth), the line's own field, the win chance, and
 * the multiplier. Every one of them moves the other three. Over and Under swap sides and keep the
 * chance, so the multiplier does not change under the player's hand.
 *
 * Over the track, in WebGL (dice3d.js, its own chunk), an archery range: the line drawn on a wall
 * between the winning lime and the losing red, and an arrow from Steve's bow where the roll lands.
 * The track and its slider stay as they are under it, the one way the line is set; a browser
 * without WebGL, or a player who switches to 2D (view3d.js), has the track alone.
 *
 * No line of text says how a roll went: the die, its colour, the strip and the balance do (the
 * operator's call, 2026-11-09); a screen reader hears it once from the status line (say).
 *
 * Motion: the die sliding to where the roll landed while its number runs up to the roll, a small
 * pop as it lands, the side it landed on flashing once, and the newest roll sliding into the strip.
 * Sound: a tick for every point the line moves, a rattle as the roll goes out, and a landing that
 * says win or miss before the eye has found the die. With reduced motion the die is simply there.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, adjustStake, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { fxColors, makeFx } from './pvfx.js';
import { autoFields, autoSwitch, wireAuto } from './autobet.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, sceneLoaded, sceneLoading, setWants3d, viewSwitch, wants3d } from './view3d.js';

/* Mirrors lib/dice.ts, so a line is priced before the server is asked. */
const SPAN = 10_000;
const EDGE_BPS = 1_000;
const MIN_CHANCE = 100; // 1.00%
const MAX_CHANCE = 8_900; // 89.00%
const RECENT = 8;
/* The die's run to the roll, as the preview times it: 640ms by hand, 260ms in Auto. */
const SLIDE_MS = 640;
const QUICK_SLIDE_MS = 260;
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

let root = null;
let config = null;
let seedHash = null;
let busy = false;
let stakeText = '1m';
let direction = 'under';
let target = 5_000; // the line, in hundredths: 50.00
let recent = []; // newest first
let last = null; // the last roll this page showed
let range3d = null; // the 3D range, once it is up
let rangeTried = null;
let tickPoint = null; // the whole point the line last ticked at
let tickAt = 0;
let fx = null; // the preview's effects over the flat range (pvfx.js)
let auto = null; // Manual or Auto (autobet.js)

/* ─────────── the maths, mirrored from lib/dice.ts ─────────── */

const chanceOf = (side, line) => (side === 'under' ? line : SPAN - line);
const multiplierBps = (chance) => Math.floor((10_000 * (10_000 - EDGE_BPS)) / chance);
const lineFor = (side, chance) => (side === 'under' ? chance : SPAN - chance);
const clampChance = (chance) => Math.min(MAX_CHANCE, Math.max(MIN_CHANCE, Math.round(chance)));
/** The line moved to where the chance it gives is one the table offers. */
const clampLine = (side, line) => lineFor(side, clampChance(chanceOf(side, line)));

const hundredths = (value) => (value / 100).toFixed(2);
const times = (bps) => `${(bps / 10_000).toFixed(4)}×`;

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function payoutMinor(stake) {
  return (stake * BigInt(multiplierBps(chanceOf(direction, target)))) / 10_000n;
}

/** The largest roll right now: the table's maximum, or what the payout limit allows at this line. */
function largestRoll() {
  if (!config) return 0n;
  const max = BigInt(config.maxStakeMinor);
  const ceiling = (BigInt(config.maxPayoutMinor) * 10_000n) / BigInt(multiplierBps(chanceOf(direction, target)));
  return ceiling < max ? ceiling : max;
}

function rollProblem() {
  if (!config) return 'Dice is not answering';
  if (!config.enabled) return 'Dice is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest roll is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest roll is ${money(Number(config.maxStakeMinor))}`;
  const bps = multiplierBps(chanceOf(direction, target));
  const ceiling = (BigInt(config.maxPayoutMinor) * 10_000n) / BigInt(bps);
  if (stake > ceiling) return `At ${times(bps)} the largest roll is ${money(Number(ceiling))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/dice/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    try {
      const { bets } = await api.get(`/v1/dice/bets?limit=${RECENT}`);
      recent = bets || [];
    } catch {
      /* The strip stays as it was; the next roll fills it. */
    }
  } else {
    recent = [];
  }
  paint();
  if (config) void startRange();
  else sceneLoaded(root);
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function roll() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || rollProblem()) return;
  busy = true;
  paintControls();
  playSound('diceRoll');
  /* Held from the click: the server's balance event can outrun its own answer, and the pill must
   * not move before the marker lands. */
  const release = holdLiveFigures();
  try {
    const stake = stakeMinor().toString();
    // Sent once more against a fresh commitment if another game or tab spent this one.
    const response = await betOnCommitment(seedHash, (serverSeedHash, key) => api.post(
      '/v1/dice/bets',
      { stakeMinor: stake, direction, target, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    seedHash = response.nextServerSeedHash || null;
    const bet = response.bet;
    await land(bet);
    showBalance(response.balanceMinor);
    release();
    recent = [bet, ...recent.filter((row) => row.id !== bet.id)].slice(0, RECENT);
    const profit = BigInt(bet.payoutMinor) - BigInt(bet.stakeMinor);
    say(bet.win
      ? `Rolled ${hundredths(bet.roll)}, ${bet.direction} ${hundredths(bet.target)}. A win: ${money(Number(bet.payoutMinor))}, ${money(Number(profit))} profit.`
      : `Rolled ${hundredths(bet.roll)}, ${bet.direction} ${hundredths(bet.target)} needed. Lost ${money(Number(bet.stakeMinor))}.`);
    return bet;
  } catch (error) {
    release();
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    toast({ kind: 'lose', title: 'Dice', body: error?.message || 'That roll did not go through' });
    void refreshBalance();
  } finally {
    busy = false;
    paint();
  }
}

/* ─────────── motion ─────────── */

/** Where on the track a value sits, in pixels from its left edge.
 *
 * A native slider's thumb travels only between half a thumb in from each end, so 0 and 100 sit
 * there, not at the edges. The zones and the scale are inset the same way (dice.css), and so is
 * this, or the marker would land up to half a thumb away from the number it shows. */
function trackX(value) {
  const track = $('.dice__track', root);
  const rail = $('.dice__rail', root);
  if (!track || !rail) return 0;
  const thumb = parseFloat(getComputedStyle(track).getPropertyValue('--dice-thumb')) || 32;
  // The track sits inside the tray's padding; the die is placed from the rail's left edge.
  const inset = track.getBoundingClientRect().left - rail.getBoundingClientRect().left;
  return inset + thumb / 2 + (value / SPAN) * (track.clientWidth - thumb);
}

/** The landing's sound: a miss, a win, or a run of notes from 10x up. */
function landSound(bet) {
  playSound(bet.win ? (bet.multiplierBps >= 100_000 ? 'diceBig' : 'diceWin') : 'diceLose');
}

/** The preview's landing: a win bursts from the die with its profit rising; a miss puffs red. */
function landFx(bet, marker, quick = false) {
  if (!fx) return;
  const c = fxColors();
  const [x, y] = fx.at(marker);
  if (bet.win) {
    fx.burst(x, y, { n: quick ? 10 : 20, colors: [c.win, c.ink], speed: 280, size: 5, g: 800, life: 0.7 });
    const profit = Number(BigInt(bet.payoutMinor) - BigInt(bet.stakeMinor));
    if (!quick) fx.text(x, y - 44, `+${money(profit)}`, { color: c.win, size: 15 });
    if (bet.multiplierBps >= 100_000) fx.coins(24);
  } else {
    fx.puff(x, y + 20, { n: 4, color: c.loss, size: 10 });
  }
}

/** A win lights the winning side of the rail once, as the preview does; a miss does not. */
function flashSide(bet) {
  if (reduceMotion() || !bet.win) return;
  const zone = $(bet.roll < bet.target ? '.dice__zone--lo' : '.dice__zone--hi', root);
  const lit = 'inset 0 0 0 20px rgba(255, 250, 240, .55)';
  zone?.animate?.(
    [{ boxShadow: lit }, { boxShadow: lit, offset: 0.25 }, { boxShadow: 'inset 0 0 0 20px rgba(255, 250, 240, 0)' }],
    { duration: 700, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}

/** The pin the preview leaves in the track where the roll landed, until the next roll. */
function placePin(roll) {
  const track = $('.dice__track', root);
  if (!track) return;
  $('.dice__pin', track)?.remove();
  if (roll === null) return;
  const pin = document.createElement('i');
  pin.className = 'dice__pin';
  pin.setAttribute('aria-hidden', 'true');
  pin.style.setProperty('--x', String(roll / SPAN));
  // Under the handle, so the line can still be taken hold of where a roll landed.
  track.insertBefore(pin, $('.dice__range', track));
}

/** A tick for each whole point the line moves, pitched by where it is; never faster than a drum roll. */
function tickLine() {
  const point = Math.round(target / 100);
  const now = performance.now();
  if (point === tickPoint || now - tickAt < 30) return;
  tickPoint = point;
  tickAt = now;
  playSound('diceTick', { rate: 0.75 + (target / SPAN) * 0.7 });
}

/** Slides the marker to the roll, and resolves when it is there: in 3D, when the arrow is in the wall. */
async function land(bet) {
  const before = last;
  last = bet;
  const quick = Boolean(auto?.running);
  const slideMs = quick ? QUICK_SLIDE_MS : SLIDE_MS;
  if (range3d) {
    $('#diceMarker', root).hidden = false;
    paintMarker();
    await range3d.shoot(bet.roll, bet.win, bet.multiplierBps);
    landSound(bet);
    return;
  }
  const marker = $('#diceMarker', root);
  const die = $('.dice__die', marker);
  const number = $('b', marker);
  /* The preview's roll: the first one leaves from the middle of the rail, every later one from the
   * last roll. The die travels neutral, hopping and turning over once on the way while its number
   * runs to the roll, lands with a squash in the colour of the result, and leaves a pin in the
   * track where it landed. */
  const fresh = marker.hidden || !before;
  const fromRoll = fresh ? SPAN / 2 : before.roll;
  const from = fresh ? trackX(fromRoll) : Number(marker.dataset.x || trackX(fromRoll));
  const to = trackX(bet.roll);
  marker.hidden = false;
  placePin(null);
  if (reduceMotion() || !marker.animate) {
    paintMarker();
    placePin(bet.roll);
    landSound(bet);
    return;
  }
  marker.dataset.tone = 'rolling';
  marker.dataset.x = String(to);
  marker.style.transform = `translateX(${to}px)`;
  const slide = marker.animate(
    [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
    { duration: slideMs, easing: 'cubic-bezier(.2, .8, .2, 1)' },
  );
  const turn = bet.roll >= fromRoll ? 1 : -1;
  die.animate(
    [
      { transform: 'none' },
      { transform: `translateY(-18px) rotate(${turn * 190}deg)`, offset: 0.42 },
      { transform: `translateY(0) rotate(${turn * 330}deg)`, offset: 0.78 },
      { transform: `rotate(${turn * 360}deg)` },
    ],
    { duration: slideMs, easing: 'cubic-bezier(.3, .7, .4, 1)' },
  );
  const started = performance.now();
  const run = (now) => {
    if (last !== bet) return;
    const t = Math.min(1, (now - started) / slideMs);
    const eased = 1 - (1 - t) ** 3;
    number.textContent = hundredths(Math.round(fromRoll + (bet.roll - fromRoll) * eased));
    if (t < 1) requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
  await slide.finished.catch(() => undefined);
  if (last !== bet) return;
  paintMarker();
  placePin(bet.roll);
  landSound(bet);
  flashSide(bet);
  landFx(bet, marker, quick);
  die.animate(
    [{ transform: 'scale(1.2, .8)' }, { transform: 'scale(.94, 1.07)', offset: 0.5 }, { transform: 'none' }],
    { duration: 260, easing: 'ease-out' },
  );
}

/* ─────────── the animation test bench (devmenu.js) ───────────
 *
 * The marker's landing for a roll the bench asked for: the line and side on the page now, a win or
 * a miss as asked, priced from the page's stake. No request, no balance, and it stays out of the
 * recent rolls. `u` is the bench's own random number in [0, 1) that places the roll inside the
 * winning or the losing stretch: this module holds no source of chance. */
export async function playTestRoll({ won, u }) {
  if (!root || busy) return;
  busy = true;
  paintControls();
  playSound('diceRoll');
  try {
    // Under wins below the line, over wins at or above it; a miss is the other stretch.
    const [from, size] = won === (direction === 'under') ? [0, target] : [target, SPAN - target];
    const roll = Math.min(SPAN - 1, from + Math.floor(u * size));
    const bps = multiplierBps(chanceOf(direction, target));
    const stake = stakeMinor() ?? 1_000_000n;
    await land({
      id: 'test', roll, direction, target, win: won, multiplierBps: bps,
      stakeMinor: stake.toString(), payoutMinor: (won ? payoutMinor(stake) : 0n).toString(),
    });
  } finally {
    busy = false;
    paint();
  }
}

/* ─────────── the 3D range ─────────── */

function startRange() {
  if (rangeTried || !wants3d()) return rangeTried;
  rangeTried = (async () => {
    const host = $('.dice__scene', root);
    sceneLoading(root, host);
    try {
      const { createDice3d } = await import('./dice3d.js');
      const built = await createDice3d(host);
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        rangeTried = null;
        return;
      }
      if (!built) return;
      built.onLost = () => {
        if (range3d === built) range3d = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onCue = cue;
      range3d = built;
      range3d.setLine(target, direction);
      root.dataset.render = '3d';
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    } finally {
      sceneLoaded(root);
    }
  })();
  return rangeTried;
}

/** The range's sounds: the bow drawn and loosed, the arrow going in, fireworks for a big win. */
function cue(name) {
  if (name === 'draw') playSound('click', { rate: 0.6 });
  else if (name === 'shoot') playSound('cast', { rate: 1.3 });
  else if (name === 'hit') playSound('tick', { rate: 0.7 });
  else if (name === 'firework') playSound('shatter', { rate: 1.5 });
}

function setGraphics(value) {
  if (busy || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (range3d) {
    range3d.dispose();
    range3d = null;
    rangeTried = null;
    root.dataset.render = '2d';
    if (config) void startRange();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the range away and leaves the track, 3D builds it again. */
function setView(on) {
  if (busy) {
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
  if (!on && range3d) {
    range3d.dispose();
    range3d = null;
    rangeTried = null;
    root.dataset.render = '2d';
  }
  if (on && config) void startRange();
  paintGraphics();
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#diceView', root), { disabled: Boolean(busy) });
  const select = root && $('#diceGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = range3d?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
  select.disabled = busy;
}

/* One polite, whole sentence per roll. */
function say(text) {
  const node = $('#diceSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintLine();
  paintMarker();
  paintRecent();
  paintControls();
  paintGraphics();
}

/** The line, the two sides of it, and the three fields that describe it. */
function paintLine(skip = null) {
  const chance = chanceOf(direction, target);
  const bps = multiplierBps(chance);
  const track = $('.dice__track', root);
  track.dataset.side = direction;
  root.dataset.side = direction;
  range3d?.setLine(target, direction);
  track.style.setProperty('--line-ratio', String(target / SPAN));

  const range = $('#diceLine', root);
  if (Number(range.value) !== target) range.value = String(target);
  const side = direction === 'under' ? 'Roll under' : 'Roll over';
  range.setAttribute('aria-valuetext', `${side} ${hundredths(target)}, ${hundredths(chance)}% to win, pays ${times(bps)}`);

  $('#diceSideLabel', root).textContent = side;
  const swap = $('#diceSwap', root);
  swap.setAttribute('aria-label', direction === 'under' ? 'Switch to roll over' : 'Switch to roll under');
  if (skip !== 'target') $('#diceTarget', root).value = hundredths(target);
  if (skip !== 'chance') $('#diceChance', root).value = hundredths(chance);
  if (skip !== 'mult') $('#diceMult', root).value = (bps / 10_000).toFixed(4);
}

function paintMarker() {
  const marker = $('#diceMarker', root);
  if (!last) {
    marker.hidden = true;
    return;
  }
  const x = trackX(last.roll);
  marker.dataset.x = String(x);
  marker.style.transform = `translateX(${x}px)`;
  marker.dataset.tone = last.win ? 'won' : 'lost';
  $('b', marker).textContent = hundredths(last.roll);
  marker.setAttribute('aria-label', `Last roll ${hundredths(last.roll)}, ${last.win ? 'a win' : 'a loss'}`);
}

function paintRecent() {
  const list = $('#diceRecent', root);
  const ids = recent.map((bet) => bet.id).join(',');
  if (list.dataset.ids === ids) return;
  const first = list.dataset.ids ? list.dataset.ids.split(',')[0] : null;
  list.dataset.ids = ids;
  list.replaceChildren(...recent.map((bet) => {
    const item = document.createElement('li');
    item.className = 'dice__chip';
    item.dataset.tone = bet.win ? 'won' : 'lost';
    if (first && bet.id !== first && bet === recent[0]) item.dataset.fresh = '1';
    item.textContent = hundredths(bet.roll);
    item.setAttribute('aria-label', `${hundredths(bet.roll)}, ${bet.win ? 'won' : 'lost'}`);
    return item;
  }));
  if (!last && recent[0]) {
    last = recent[0];
    $('#diceMarker', root).hidden = false;
    paintMarker();
  }
}

function paintControls() {
  const go = $('#diceGo', root);
  const label = $('#diceGoLabel', root);
  const hint = $('#diceHint', root);
  const stake = stakeMinor();
  let text;
  if (!state.authenticated) text = 'Log in to play';
  else if (busy) text = 'Rolling…';
  else text = 'Bet';
  if (auto && state.authenticated) text = auto.label(text);
  if (label.textContent !== text) label.textContent = text;
  const problem = state.authenticated ? rollProblem() : '';
  // A run in Auto can always be stopped, mid-roll included.
  go.disabled = auto?.running ? false : busy || Boolean(problem);
  go.setAttribute('aria-busy', String(busy));
  hint.textContent = problem;

  const profit = $('#diceProfit', root);
  profit.value = stake && stake > 0n ? money(Number(payoutMinor(stake) - stake)) : '—';
  $('#diceProfitX', root).textContent = times(multiplierBps(chanceOf(direction, target)));

  const locked = busy || Boolean(auto?.running);
  for (const node of root.querySelectorAll('.dice__field input, .dice__panel .dice__adj, .dice__stage input, .dice__swap')) {
    node.disabled = locked;
  }
}

/* ─────────── building ─────────── */

function setLine(line, skip) {
  target = clampLine(direction, line);
  paintLine(skip);
  paintControls();
}

function swapSide() {
  if (busy) return;
  // Same chance on the other side: the multiplier stays where the player put it.
  const chance = chanceOf(direction, target);
  direction = direction === 'under' ? 'over' : 'under';
  target = lineFor(direction, chance);
  paintLine();
  paintControls();
}

/* A typed number, or null while it is not one yet (an empty field, a lone "."). */
function typed(input) {
  const value = Number(String(input.value).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(value) && input.value.trim() !== '' ? value : null;
}

function build() {
  root.innerHTML = `
    <section class="dice__stage" aria-label="The roll">
      <div class="dice__top">
        <ol class="dice__recent" id="diceRecent" aria-label="Your last rolls, newest first"></ol>
      </div>

      <div class="dice__scene"></div>

      <div class="dice__board">
        <div class="dice__rail">
          <div class="dice__marker" id="diceMarker" role="img" hidden><span class="dice__die"><b>50.00</b></span></div>
          <div class="dice__tray">
            <div class="dice__track" data-side="under">
              <span class="dice__zone dice__zone--lo" aria-hidden="true"></span>
              <span class="dice__zone dice__zone--hi" aria-hidden="true"></span>
              <input class="dice__range" id="diceLine" type="range" min="1" max="9999" step="1" value="5000"
                     aria-label="The line the roll is measured against" />
            </div>
            <div class="dice__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
          </div>
        </div>
      </div>

      <div class="dice__dials">
        <div class="dice__dial">
          <label class="dice__label" for="diceMult">Multiplier</label>
          <div class="dice__field dice__field--dial">
            <input id="diceMult" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <span aria-hidden="true">×</span>
          </div>
        </div>
        <div class="dice__dial">
          <label class="dice__label" for="diceTarget" id="diceSideLabel">Roll under</label>
          <div class="dice__field dice__field--dial">
            <input id="diceTarget" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <button type="button" class="dice__swap" id="diceSwap" aria-label="Switch to roll over">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3.5-3.5M17 17H6l3.5 3.5"/></svg>
            </button>
          </div>
        </div>
        <div class="dice__dial">
          <label class="dice__label" for="diceChance">Win chance</label>
          <div class="dice__field dice__field--dial">
            <input id="diceChance" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <span aria-hidden="true">%</span>
          </div>
        </div>
      </div>
    </section>

    <aside class="dice__panel" aria-label="Your roll">
      <form class="dice__form" id="diceForm" novalidate>
        ${autoSwitch('dice')}
        <label class="dice__label" for="diceStake">Bet amount</label>
        <div class="dice__field">
          <span aria-hidden="true">$</span>
          <input id="diceStake" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off" spellcheck="false" />
          <button type="button" class="dice__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="dice__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="dice__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
        </div>
        ${autoFields('dice')}
        <button class="btn dice__go" id="diceGo" type="submit" data-sfx="none">
          <span id="diceGoLabel">Loading…</span>
        </button>
        <label class="dice__label dice__label--row" for="diceProfit"><span>Profit on win</span><span class="dice__profitx" id="diceProfitX"></span></label>
        <div class="dice__field dice__field--read">
          <output id="diceProfit" for="diceStake diceLine">—</output>
        </div>
        <p class="dice__hint" id="diceHint" aria-live="polite"></p>
        ${viewSwitch('diceView')}
        <label class="dice__gfx" for="diceGfx">
          <span>Graphics</span>
          <select id="diceGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="dice__say" id="diceSay" role="status" aria-atomic="true"></div>`;

  fx = makeFx($('.dice__stage', root));

  const stake = $('#diceStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  root.querySelectorAll('.dice__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(adjustStake(button.dataset.adj, current, state.balanceMinor, largestRoll())));
    stake.value = stakeText;
    paintControls();
  }));

  /* The slider. Native, so a pointer, a finger and the keyboard all work; the arrows are taken
   * over only to move a whole point at a time, which is what a person means by "a bit higher". */
  const range = $('#diceLine', root);
  range.addEventListener('input', () => { setLine(Number(range.value)); tickLine(); });
  range.addEventListener('keydown', (event) => {
    const move = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (!move || busy) return;
    event.preventDefault();
    setLine(target + move * (event.shiftKey ? 1 : 100));
    tickLine();
  });

  /* The three fields: each moves the other two live, and settles to its own exact value when the
   * player leaves it, so a half-typed number is never rewritten under the cursor. */
  const fields = [
    ['#diceTarget', 'target', (value) => setLine(Math.round(value * 100), 'target')],
    ['#diceChance', 'chance', (value) => setLine(lineFor(direction, clampChance(value * 100)), 'chance')],
    ['#diceMult', 'mult', (value) => value > 1 && setLine(lineFor(direction, clampChance(9_000 / value)), 'mult')],
  ];
  for (const [selector, , apply] of fields) {
    const input = $(selector, root);
    input.addEventListener('input', () => {
      const value = typed(input);
      if (value !== null && value > 0) apply(value);
    });
    input.addEventListener('change', () => paintLine());
    input.addEventListener('blur', () => paintLine());
  }
  $('#diceSwap', root).addEventListener('click', swapSide);

  auto = wireAuto(root, 'dice', {
    betOnce: roll,
    getStake: stakeMinor,
    setStake: (minor) => {
      stakeText = formatAmountInput(Number(minor));
      stake.value = stakeText;
      paintControls();
    },
    paint: paintControls,
  });
  $('#diceForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (auto.mode === 'auto') auto.toggle();
    else void roll();
  });
  $('#diceGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#diceView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  // Enter in a dial rolls too, the way it does in the stake field.
  root.querySelectorAll('.dice__dials input').forEach((input) => input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    paintLine();
    void roll();
  }));
  // The marker is placed in pixels; keep it over its roll when the track changes width.
  window.addEventListener('resize', () => { if (root?.isConnected) paintMarker(); });
}

export function mountDice(section) {
  root = $('#diceRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments the player's own rolls can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        recent = [];
        last = null;
        seedHash = null;
      }
      if (!busy) paint();
    });
  }
  // A scene still to be built comes up behind the loading screen, not after the flat board.
  if (!rangeTried) sceneLoading(root, $('.dice__scene', root));
  void load();
}
