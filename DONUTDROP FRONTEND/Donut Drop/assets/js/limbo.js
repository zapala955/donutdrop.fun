/* limbo.js — pick a target multiplier; the server draws one, and the bet wins if it gets there.
 *
 * The server owns the draw. One request places the bet, draws the multiplier from the player's
 * committed fairness seed and pays a win, all at once (routes/limbo.ts, lib/limbo.ts); this page
 * prices the target before anything is sent, then shows a draw that already exists.
 *
 * The target can be set two ways, and each moves the other: the multiplier itself, and the win
 * chance it gives (exactly 90% divided by the target).
 *
 * The look (2026-11-10, the casino floor the other games were given): one big multiplier in the
 * middle of the stage that climbs from 1.00x to the draw on an exponential curve and lands green
 * when it reached the target, red when it did not; the strip of recent draws above it; the target
 * and the chance under it; the stake, the profit and the one button in the panel. No line of text
 * says how a bet went -- the number, its colour and the strip do; a screen reader hears it once from
 * the status line. Its own sounds: a rise as the number climbs, a win (a run of notes from 10x up),
 * a soft knock for a miss. Flat, no glow. With reduced motion the number is simply there.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, adjustStake, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

/* Mirrors lib/limbo.ts, so a target is priced before the server is asked. */
const EDGE_BPS = 1_000;
const MIN_TARGET = 101; // 1.01x, in hundredths
const MAX_TARGET = 100_000_000; // 1,000,000x
const RECENT = 10;

let root = null;
let config = null;
let seedHash = null;
let busy = false;
let stakeText = '1m';
let target = 200; // 2.00x
let recent = []; // newest first

/* ─────────── the maths, mirrored from lib/limbo.ts ─────────── */

const clampTarget = (value) => Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.round(value)));
/** The chance a target wins, in percent: 90 / T. */
const chancePct = (targetX100) => ((10_000 - EDGE_BPS) / 100) * (100 / targetX100);
/** A multiplier in hundredths as the page shows it: "2.00×", "1,240.55×". */
const times = (x100) => `${(Math.max(x100, 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
const pctText = (pct) => (pct >= 1 ? pct.toFixed(2) : pct >= 0.01 ? pct.toFixed(4) : pct.toPrecision(3));

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function payoutMinor(stake) {
  return (stake * BigInt(target)) / 100n;
}

/** The largest bet right now: the table's maximum, or what the payout limit allows at this target. */
function largestBet() {
  if (!config) return 0n;
  const max = BigInt(config.maxStakeMinor);
  const ceiling = (BigInt(config.maxPayoutMinor) * 100n) / BigInt(target);
  return ceiling < max ? ceiling : max;
}

function betProblem() {
  if (!config) return 'Limbo is not answering';
  if (!config.enabled) return 'Limbo is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest bet is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest bet is ${money(Number(config.maxStakeMinor))}`;
  const ceiling = (BigInt(config.maxPayoutMinor) * 100n) / BigInt(target);
  if (stake > ceiling) return `At ${times(target)} the largest bet is ${money(Number(ceiling))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/limbo/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    try {
      const { bets } = await api.get(`/v1/limbo/bets?limit=${RECENT}`);
      recent = bets || [];
    } catch {
      /* The strip stays as it was; the next bet fills it. */
    }
  } else {
    recent = [];
  }
  paint();
  if (recent[0] && !busy) showNumber(recent[0].result, recent[0].win ? 'won' : 'lost');
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function bet() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || betProblem()) return;
  busy = true;
  paintControls();
  /* Held from the click: the server's balance event can outrun its own answer, and the pill must
   * not move before the number lands. */
  const release = holdLiveFigures();
  try {
    const stake = stakeMinor().toString();
    // Sent once more against a fresh commitment if another game or tab spent this one.
    const response = await betOnCommitment(seedHash, (serverSeedHash, key) => api.post(
      '/v1/limbo/bets',
      { stakeMinor: stake, target, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    seedHash = response.nextServerSeedHash || null;
    const placed = response.bet;
    await land(placed);
    showBalance(response.balanceMinor);
    release();
    recent = [placed, ...recent.filter((row) => row.id !== placed.id)].slice(0, RECENT);
    const profit = BigInt(placed.payoutMinor) - BigInt(placed.stakeMinor);
    say(placed.win
      ? `Drew ${times(placed.result)}, target ${times(placed.target)}. A win: ${money(Number(placed.payoutMinor))}, ${money(Number(profit))} profit.`
      : `Drew ${times(placed.result)}, target ${times(placed.target)} needed. Lost ${money(Number(placed.stakeMinor))}.`);
  } catch (error) {
    release();
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    toast({ kind: 'lose', title: 'Limbo', body: error?.message || 'That bet did not go through' });
    void refreshBalance();
  } finally {
    busy = false;
    paint();
  }
}

/* ─────────── motion ─────────── */

/** The number at rest, in a tone: '' neutral, 'won' green, 'lost' red. */
function showNumber(resultX100, tone) {
  const node = $('#limboNum', root);
  if (!node) return;
  node.textContent = times(resultX100);
  node.dataset.tone = tone;
}

/**
 * The draw: the number climbs from 1.00x to the result on an exponential curve -- the way a
 * multiplier feels -- longer the further it goes, then lands in its colour with a pop. Resolves when
 * it has landed.
 */
function land(placed) {
  const node = $('#limboNum', root);
  const won = placed.win;
  const finalX100 = Math.max(100, placed.result);
  const sound = () => {
    playSound(won ? (placed.target >= 1_000 ? 'limboBig' : 'limboWin') : 'limboLose');
  };
  if (reduceMotion() || !node.animate) {
    showNumber(placed.result, won ? 'won' : 'lost');
    sound();
    return Promise.resolve();
  }
  const span = Math.log(finalX100 / 100);
  const duration = Math.min(1_100, 320 + span * 180);
  node.dataset.tone = 'rolling';
  playSound('limboRise', { rate: Math.max(0.7, Math.min(1.6, 900 / duration)) });
  const started = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - t) ** 3;
      node.textContent = times(Math.round(100 * Math.exp(span * eased)));
      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }
      showNumber(placed.result, won ? 'won' : 'lost');
      sound();
      node.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.35 }, { transform: 'scale(1)' }],
        { duration: 300, easing: 'cubic-bezier(.16, 1, .3, 1)' },
      );
      resolve();
    };
    requestAnimationFrame(step);
  });
}

/* One polite, whole sentence per bet. */
function say(text) {
  const node = $('#limboSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintTarget();
  paintRecent();
  paintControls();
}

/** The two fields that describe the target. `skip` leaves alone the one being typed in. */
function paintTarget(skip = null) {
  if (skip !== 'target') $('#limboTarget', root).value = (target / 100).toFixed(2);
  if (skip !== 'chance') $('#limboChance', root).value = pctText(chancePct(target));
}

function paintRecent() {
  const list = $('#limboRecent', root);
  const ids = recent.map((row) => row.id).join(',');
  if (list.dataset.ids === ids) return;
  const first = list.dataset.ids ? list.dataset.ids.split(',')[0] : null;
  list.dataset.ids = ids;
  list.replaceChildren(...recent.map((row) => {
    const item = document.createElement('li');
    item.className = 'limbo__chip';
    item.dataset.tone = row.win ? 'won' : 'lost';
    if (first && row.id !== first && row === recent[0]) item.dataset.fresh = '1';
    item.textContent = times(row.result);
    item.setAttribute('aria-label', `${times(row.result)}, ${row.win ? 'won' : 'lost'}`);
    return item;
  }));
}

function paintControls() {
  const go = $('#limboGo', root);
  const label = $('#limboGoLabel', root);
  const hint = $('#limboHint', root);
  const stake = stakeMinor();
  let text;
  if (!state.authenticated) text = 'Log in to play';
  else if (busy) text = 'Betting…';
  else text = `Bet · ${money(Number(stake ?? 0n))}`;
  if (label.textContent !== text) label.textContent = text;
  const problem = state.authenticated ? betProblem() : '';
  go.disabled = busy || Boolean(problem);
  go.setAttribute('aria-busy', String(busy));
  hint.textContent = problem;

  $('#limboProfit', root).value = stake && stake > 0n ? money(Number(payoutMinor(stake) - stake)) : '—';
  $('#limboProfitX', root).textContent = times(target);

  for (const node of root.querySelectorAll('.limbo__panel input, .limbo__adj, .limbo__stage input')) {
    node.disabled = busy;
  }
}

/* ─────────── building ─────────── */

function setTarget(value, skip) {
  target = clampTarget(value);
  paintTarget(skip);
  paintControls();
}

/* A typed number, or null while it is not one yet (an empty field, a lone "."). */
function typed(input) {
  const value = Number(String(input.value).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(value) && input.value.trim() !== '' ? value : null;
}

function build() {
  root.innerHTML = `
    <section class="limbo__stage" aria-label="The draw">
      <div class="limbo__top">
        <ol class="limbo__recent" id="limboRecent" aria-label="Your last draws, newest first"></ol>
      </div>

      <div class="limbo__show">
        <b class="limbo__num" id="limboNum" data-tone="">1.00×</b>
      </div>

      <div class="limbo__dials">
        <div class="limbo__dial">
          <label class="limbo__label" for="limboTarget">Target multiplier</label>
          <div class="limbo__field limbo__field--dial">
            <input id="limboTarget" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <span aria-hidden="true">×</span>
          </div>
        </div>
        <div class="limbo__dial">
          <label class="limbo__label" for="limboChance">Win chance</label>
          <div class="limbo__field limbo__field--dial">
            <input id="limboChance" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <span aria-hidden="true">%</span>
          </div>
        </div>
      </div>
    </section>

    <aside class="limbo__panel" aria-label="Your bet">
      <form class="limbo__form" id="limboForm" novalidate>
        <label class="limbo__label" for="limboStake">Stake</label>
        <div class="limbo__field">
          <span aria-hidden="true">$</span>
          <input id="limboStake" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off" spellcheck="false" />
          <button type="button" class="limbo__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="limbo__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="limbo__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
        </div>
        <label class="limbo__label limbo__label--row" for="limboProfit"><span>Profit on win</span><span class="limbo__profitx" id="limboProfitX"></span></label>
        <div class="limbo__field limbo__field--read">
          <output id="limboProfit" for="limboStake limboTarget">—</output>
        </div>
        <button class="btn limbo__go" id="limboGo" type="submit" data-sfx="none">
          <span id="limboGoLabel">Loading…</span>
        </button>
        <p class="limbo__hint" id="limboHint" aria-live="polite"></p>
      </form>
    </aside>
    <div class="limbo__say" id="limboSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#limboStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  root.querySelectorAll('.limbo__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(adjustStake(button.dataset.adj, current, state.balanceMinor, largestBet())));
    stake.value = stakeText;
    paintControls();
  }));

  /* The two fields: each moves the other live, and settles to its own exact value when the player
   * leaves it, so a half-typed number is never rewritten under the cursor. */
  const targetInput = $('#limboTarget', root);
  targetInput.addEventListener('input', () => {
    const value = typed(targetInput);
    if (value !== null && value >= 1.01) setTarget(value * 100, 'target');
  });
  const chanceInput = $('#limboChance', root);
  chanceInput.addEventListener('input', () => {
    const value = typed(chanceInput);
    if (value !== null && value > 0) setTarget(9_000 / value, 'chance');
  });
  for (const input of [targetInput, chanceInput]) {
    input.addEventListener('change', () => paintTarget());
    input.addEventListener('blur', () => paintTarget());
    // Enter in either field bets, the way it does in the stake field.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      paintTarget();
      void bet();
    });
  }

  $('#limboForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void bet();
  });
}

export function mountLimbo(section) {
  root = $('#limboRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments the player's own draws can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        recent = [];
        seedHash = null;
        showNumber(100, '');
      }
      if (!busy) paint();
    });
  }
  void load();
}
