/* dice.js — a roll from 0.00 to 99.99, and a line the player draws through it.
 *
 * The server owns every roll. One request takes the stake, draws the roll from the player's
 * committed fairness seed and pays a win; this page slides the marker to a number that already
 * exists. Each answer carries the commitment the next roll must be sent against.
 *
 * The wallet pill does not jump ahead of the marker: the live polls are held from the click, the
 * pill shows the balance less the payout while the marker travels, and the payout lands with it.
 *
 * Motion: the marker's slide and the number's count. With reduced motion both land at once.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const SPAN = 10_000; // the roll in hundredths
const RECENT = 10;
const SLIDE_MS = 520;

let root = null;
let config = null;
let seedHash = null;
let direction = 'under';
let target = 5_000; // the line, in hundredths
let stakeText = '1m';
let busy = false;
let lastRoll = null;
let recent = []; // newest first: { roll, win }

/* ─────────── numbers ─────────── */

const chance = () => (direction === 'under' ? target : SPAN - target);
const edgeBps = () => config?.houseEdgeBps ?? 1000;
/** 90% over the chance, floored to a basis point -- the server's own arithmetic. */
const multiplierBps = (c = chance()) => Math.floor((10_000 * (10_000 - edgeBps())) / c);
const minChance = () => config?.minChance ?? 100;
const maxChance = () => config?.maxChance ?? 8_900;
const twoDp = (hundredths) => (hundredths / 100).toFixed(2);
const times = (bps) => `${(Math.floor(bps / 100) / 100).toFixed(2)}×`;

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function maxStake() {
  if (!config) return 0n;
  const ceiling = (BigInt(config.maxPayoutMinor) * 10_000n) / BigInt(multiplierBps());
  const max = BigInt(config.maxStakeMinor);
  return ceiling < max ? ceiling : max;
}

function problem() {
  if (!config) return 'Dice is not answering';
  if (!config.enabled) return 'Dice is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor))
    return `The smallest bet is ${money(Number(config.minStakeMinor))}`;
  const max = maxStake();
  if (stake > max) return `At this multiplier the largest bet is ${money(Number(max))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0'))
    return 'That is more than your balance';
  return '';
}

/** Keeps the line inside the chances the server takes, for the side chosen. */
function clampTarget(value) {
  const lo = direction === 'under' ? minChance() : SPAN - maxChance();
  const hi = direction === 'under' ? maxChance() : SPAN - minChance();
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/* ─────────── the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/dice/config');
  } catch {
    config = null;
  }
  if (state.authenticated) await refreshSeed();
  target = clampTarget(target);
  paint();
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function send(key) {
  if (!seedHash) await refreshSeed();
  const body = () => ({
    stakeMinor: stakeMinor().toString(),
    direction,
    target,
    clientSeed: clientSeed(),
    serverSeedHash: seedHash,
  });
  try {
    return await api.post('/v1/dice/bets', body(), { idempotencyKey: key });
  } catch (error) {
    /* The commitment moved (another tab played something): pick up the new one and go again under
     * a new key, since the request itself is now a different one. */
    if (error?.code !== 'FAIRNESS_COMMITMENT_CHANGED') throw error;
    await refreshSeed();
    return api.post('/v1/dice/bets', body(), { idempotencyKey: idempotencyKey() });
  }
}

async function roll() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || problem()) return;
  busy = true;
  /* Held from the click: a poll landing between the click and the marker would print the result
   * before the dice has rolled. */
  const release = holdLiveFigures();
  playSound('click');
  paintControls();
  try {
    const response = await send(idempotencyKey());
    seedHash = response.nextServerSeedHash || null;
    const bet = response.bet;
    const balance = BigInt(response.balanceMinor);
    showBalance((balance - BigInt(bet.payoutMinor)).toString());
    await reveal(bet);
    showBalance(balance.toString());
    recent = [{ roll: bet.roll, win: bet.win }, ...recent].slice(0, RECENT);
    paintRecent();
  } catch (error) {
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    toast({ kind: 'lose', title: 'Dice', body: error?.message || 'That roll did not go through' });
  } finally {
    release();
    busy = false;
    void refreshBalance();
    paintControls();
  }
}

/** Slides the marker to the roll and counts the number up to it, then says how it landed. */
function reveal(bet) {
  const marker = $('#diceMarker', root);
  const readout = $('#diceRoll', root);
  const from = lastRoll ?? 5_000;
  lastRoll = bet.roll;
  root.dataset.outcome = '';
  marker.style.left = `${(bet.roll / SPAN) * 100}%`;
  const finish = () => {
    readout.textContent = twoDp(bet.roll);
    root.dataset.outcome = bet.win ? 'won' : 'lost';
    const say = $('#diceSay', root);
    say.textContent = bet.win
      ? `Rolled ${twoDp(bet.roll)} · won ${money(Number(bet.payoutMinor))}`
      : `Rolled ${twoDp(bet.roll)} · lost`;
    playSound(bet.win ? 'coin' : 'lose');
  };
  if (reduceMotion()) {
    marker.style.transition = 'none';
    finish();
    return Promise.resolve();
  }
  marker.style.transition = '';
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / SLIDE_MS);
      const eased = 1 - (1 - t) ** 3;
      readout.textContent = twoDp(Math.round(from + (bet.roll - from) * eased));
      if (t < 1) requestAnimationFrame(frame);
      else {
        finish();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  const c = chance();
  const zone = $('#diceZone', root);
  // The winning side of the line, in the track's own coordinates.
  if (direction === 'under') {
    zone.style.left = '0%';
    zone.style.width = `${(target / SPAN) * 100}%`;
  } else {
    zone.style.left = `${(target / SPAN) * 100}%`;
    zone.style.width = `${((SPAN - target) / SPAN) * 100}%`;
  }
  $('#diceLine', root).style.left = `${(target / SPAN) * 100}%`;
  const slider = $('#diceSlider', root);
  if (Number(slider.value) !== target) slider.value = String(target);

  const set = (id, value) => {
    const node = $(id, root);
    if (document.activeElement !== node) node.value = value;
  };
  set('#diceTarget', twoDp(target));
  set('#diceChance', twoDp(c));
  set('#diceMultiplier', (multiplierBps(c) / 10_000).toFixed(4).replace(/0{1,2}$/, ''));
  $('#diceTargetLabel', root).textContent = direction === 'under' ? 'Roll under' : 'Roll over';
  root.querySelectorAll('.dice__side').forEach((node) => {
    node.setAttribute('aria-pressed', String(node.dataset.side === direction));
  });
  paintControls();
}

function paintControls() {
  if (!root) return;
  const go = $('#diceGo', root);
  const hint = $('#diceHint', root);
  const issue = state.authenticated ? problem() : '';
  go.textContent = !state.authenticated ? 'Log in to play' : busy ? 'Rolling…' : 'Roll';
  go.disabled = state.authenticated && (Boolean(issue) || busy || !config);
  go.setAttribute('aria-busy', String(busy));
  hint.textContent = issue;
  const stake = stakeMinor();
  $('#diceProfit', root).textContent =
    stake && stake > 0n ? money(Number((stake * BigInt(multiplierBps())) / 10_000n - stake)) : '—';
  root.querySelectorAll('.dice__side, #diceSlider, .dice__num input').forEach((node) => {
    node.disabled = busy;
  });
}

function paintRecent() {
  const list = $('#diceRecent', root);
  list.replaceChildren(
    ...recent.map((entry) => {
      const chip = document.createElement('li');
      chip.className = 'dice__chip';
      chip.dataset.tone = entry.win ? 'won' : 'lost';
      chip.textContent = twoDp(entry.roll);
      return chip;
    }),
  );
}

/* ─────────── building ─────────── */

function build() {
  root.innerHTML = `
    <section class="dice__stage" aria-label="The roll">
      <div class="dice__readout">
        <b class="dice__roll mono" id="diceRoll" aria-live="off">50.00</b>
        <ol class="dice__recent" id="diceRecent" aria-label="Your last rolls, newest first"></ol>
      </div>
      <div class="dice__trackwrap">
        <div class="dice__track" id="diceTrack">
          <span class="dice__zone" id="diceZone"></span>
          <span class="dice__line" id="diceLine"></span>
          <span class="dice__marker" id="diceMarker"><i></i></span>
        </div>
        <input class="dice__slider" id="diceSlider" type="range" min="1" max="9999" step="1"
               value="5000" aria-label="The line the roll is measured against" />
        <div class="dice__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
      </div>
      <div class="dice__nums">
        <label class="dice__num"><span id="diceTargetLabel">Roll under</span>
          <input id="diceTarget" inputmode="decimal" autocomplete="off" /></label>
        <label class="dice__num"><span>Multiplier</span>
          <input id="diceMultiplier" inputmode="decimal" autocomplete="off" /></label>
        <label class="dice__num"><span>Win chance %</span>
          <input id="diceChance" inputmode="decimal" autocomplete="off" /></label>
      </div>
      <p class="dice__say" id="diceSay" role="status" aria-atomic="true"></p>
    </section>

    <aside class="dice__panel" aria-label="Your bet">
      <form class="dice__form" id="diceForm" novalidate>
        <label class="dice__label" for="diceStake">Stake</label>
        <div class="dice__field">
          <span aria-hidden="true">$</span>
          <input id="diceStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="dice__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="dice__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="dice__label" id="diceSideLabel">Side</span>
        <div class="dice__sides" role="group" aria-labelledby="diceSideLabel">
          <button type="button" class="dice__side" data-side="under" aria-pressed="true">Under</button>
          <button type="button" class="dice__side" data-side="over" aria-pressed="false">Over</button>
        </div>
        <div class="dice__profit"><span>Profit on win</span><b class="mono" id="diceProfit">—</b></div>
        <button class="btn dice__go" id="diceGo" type="submit">Loading…</button>
        <p class="dice__hint" id="diceHint" aria-live="polite"></p>
      </form>
    </aside>`;

  $('#diceMarker', root).style.left = '50%';
  const stake = $('#diceStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => {
    stakeText = stake.value;
    paintControls();
  });
  root.querySelectorAll('.dice__adj').forEach((button) =>
    button.addEventListener('click', () => {
      const current = stakeMinor() ?? 0n;
      stakeText = formatAmountInput(
        Number(button.dataset.adj === 'half' ? current / 2n : current * 2n),
      );
      stake.value = stakeText;
      paintControls();
    }),
  );
  root.querySelectorAll('.dice__side').forEach((button) =>
    button.addEventListener('click', () => {
      if (busy || button.dataset.side === direction) return;
      /* Flipping the side keeps the chance, not the line: the bet the player sized stays the same
       * bet, mirrored. */
      const keep = chance();
      direction = button.dataset.side;
      target = clampTarget(direction === 'under' ? keep : SPAN - keep);
      paint();
    }),
  );
  $('#diceSlider', root).addEventListener('input', (event) => {
    target = clampTarget(Number(event.target.value));
    paint();
  });
  const fromInput = (id, toTarget) => {
    const node = $(id, root);
    node.addEventListener('change', () => {
      const value = Number(String(node.value).replace(',', '.'));
      if (Number.isFinite(value) && value > 0) target = clampTarget(toTarget(value));
      paint();
    });
  };
  fromInput('#diceTarget', (value) => value * 100);
  fromInput('#diceChance', (value) => {
    const c = Math.min(maxChance(), Math.max(minChance(), Math.round(value * 100)));
    return direction === 'under' ? c : SPAN - c;
  });
  fromInput('#diceMultiplier', (value) => {
    const c = Math.round((10_000 - edgeBps()) / value);
    const bounded = Math.min(maxChance(), Math.max(minChance(), c));
    return direction === 'under' ? bounded : SPAN - bounded;
  });
  $('#diceForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void roll();
  });
}

export function mountDice(section) {
  root = $('#diceRoot', section);
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
        seedHash = null;
        recent = [];
        paintRecent();
      }
      if (root) paintControls();
    });
  }
  void load();
}
