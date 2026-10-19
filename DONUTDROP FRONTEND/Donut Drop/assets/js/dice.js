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
 * Motion is one thing: the marker sliding to where the roll landed. With reduced motion it is
 * simply there.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

/* Mirrors lib/dice.ts, so a line is priced before the server is asked. */
const SPAN = 10_000;
const EDGE_BPS = 1_000;
const MIN_CHANCE = 100; // 1.00%
const MAX_CHANCE = 8_900; // 89.00%
const RECENT = 8;

let root = null;
let config = null;
let seedHash = null;
let busy = false;
let stakeText = '1m';
let direction = 'under';
let target = 5_000; // the line, in hundredths: 50.00
let recent = []; // newest first
let last = null; // the last roll this page showed

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
  playSound('click');
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
    const x = bet.multiplierBps / 10_000;
    playSound(bet.win ? (x >= 10 ? 'reward' : 'win') : 'lose');
    say(bet.win
      ? `Rolled ${hundredths(bet.roll)}, ${bet.direction} ${hundredths(bet.target)}. A win: ${money(Number(bet.payoutMinor))}, ${money(Number(profit))} profit.`
      : `Rolled ${hundredths(bet.roll)}, ${bet.direction} ${hundredths(bet.target)} needed. Lost ${money(Number(bet.stakeMinor))}.`);
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
  if (!track) return 0;
  const thumb = parseFloat(getComputedStyle(track).getPropertyValue('--dice-thumb')) || 32;
  return thumb / 2 + (value / SPAN) * (track.clientWidth - thumb);
}

/** Slides the marker to the roll, and resolves when it is there. */
function land(bet) {
  last = bet;
  const marker = $('#diceMarker', root);
  const from = marker.hidden ? trackX(bet.roll) : Number(marker.dataset.x || 0);
  const to = trackX(bet.roll);
  marker.hidden = false;
  paintMarker();
  if (reduceMotion() || !marker.animate) return Promise.resolve();
  const animation = marker.animate(
    [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
    { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
  return animation.finished.then(() => undefined, () => undefined);
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
  playSound('click');
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
    playSound(won ? (bps / 10_000 >= 10 ? 'reward' : 'win') : 'lose');
  } finally {
    busy = false;
    paint();
  }
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
}

/** The line, the two sides of it, and the three fields that describe it. */
function paintLine(skip = null) {
  const chance = chanceOf(direction, target);
  const bps = multiplierBps(chance);
  const track = $('.dice__track', root);
  track.dataset.side = direction;
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

  const now = $('#diceNow', root);
  const profit = BigInt(last.payoutMinor) - BigInt(last.stakeMinor);
  now.dataset.tone = last.win ? 'won' : 'lost';
  now.textContent = last.win ? `+${money(Number(profit))}` : `−${money(Number(last.stakeMinor))}`;
  $('#diceNext', root).textContent = `Rolled ${hundredths(last.roll)} · ${last.direction} ${hundredths(last.target)} · ${times(last.multiplierBps)}`;
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
  else text = `Roll · ${money(Number(stake ?? 0n))}`;
  if (label.textContent !== text) label.textContent = text;
  const problem = state.authenticated ? rollProblem() : '';
  go.disabled = busy || Boolean(problem);
  go.setAttribute('aria-busy', String(busy));
  hint.textContent = problem;

  const profit = $('#diceProfit', root);
  profit.value = stake && stake > 0n ? money(Number(payoutMinor(stake) - stake)) : '—';

  for (const node of root.querySelectorAll('.dice__panel input, .dice__panel .dice__adj, .dice__stage input, .dice__swap')) {
    node.disabled = busy;
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
        <div class="dice__readout">
          <b id="diceNow" data-tone="">No rolls yet</b>
          <span id="diceNext">Draw a line, pick a side, roll.</span>
        </div>
        <ol class="dice__recent" id="diceRecent" aria-label="Your last rolls, newest first"></ol>
      </div>

      <div class="dice__board">
        <div class="dice__rail">
          <div class="dice__marker" id="diceMarker" role="img" hidden><b>50.00</b></div>
          <div class="dice__track" data-side="under">
            <span class="dice__zone dice__zone--lo" aria-hidden="true"></span>
            <span class="dice__zone dice__zone--hi" aria-hidden="true"></span>
            <input class="dice__range" id="diceLine" type="range" min="1" max="9999" step="1" value="5000"
                   aria-label="The line the roll is measured against" />
          </div>
        </div>
        <div class="dice__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
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
        <label class="dice__label" for="diceStake">Stake</label>
        <div class="dice__field">
          <span aria-hidden="true">$</span>
          <input id="diceStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="dice__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="dice__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <label class="dice__label" for="diceProfit">Profit on win</label>
        <div class="dice__field dice__field--read">
          <output id="diceProfit" for="diceStake diceLine">—</output>
        </div>
        <button class="btn dice__go" id="diceGo" type="submit">
          <span id="diceGoLabel">Loading…</span>
        </button>
        <p class="dice__hint" id="diceHint" aria-live="polite"></p>
      </form>
    </aside>
    <div class="dice__say" id="diceSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#diceStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  root.querySelectorAll('.dice__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paintControls();
  }));

  /* The slider. Native, so a pointer, a finger and the keyboard all work; the arrows are taken
   * over only to move a whole point at a time, which is what a person means by "a bit higher". */
  const range = $('#diceLine', root);
  range.addEventListener('input', () => setLine(Number(range.value)));
  range.addEventListener('keydown', (event) => {
    const move = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (!move || busy) return;
    event.preventDefault();
    setLine(target + move * (event.shiftKey ? 1 : 100));
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

  $('#diceForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void roll();
  });
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
  void load();
}
