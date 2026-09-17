/* upgrader.js — stake cash, chase a payout. The backend owns the roll.
 *
 * The layout is the nether-gold rig: a card, a dial, a card, and the button under them. Nothing
 * sits between them. A player needs four things here — what goes in, what they are chasing, the
 * odds, and the control — and every number has exactly one home.
 *
 * Cash in, cash out. The server still rolls a catalogue item, because that is what carries the
 * name, the rarity and the art the reveal needs, but it pays the item's full value straight to
 * the wallet. Nothing is ever held, so there is no inventory to manage and no sell step.
 *
 * Every figure below is read from state.upgradeConfig and every outcome comes back off
 * /v1/upgrades. The browser computes a quote; the server decides.
 */
import { RARITY, IMG } from './data.js';
import { state, bus, runBalanceUpgrade } from './store.js';
import {
  $, el, money, pct, itemTile, reduceMotion, parseAmount, formatAmountInput, safeImage,
} from './util.js';
import { toast, openModal, closeModal, broadcast, fairSheet } from './ui.js';
import { playReveal, warmReveal } from './reveal.js';
import { playSound } from './audio-engine.js';
import { createWheel } from './wheel.js';

const TICKS = 72;
const R = 50;                       // ring radius inside the 120-unit viewBox
const C = 2 * Math.PI * R;

let cashStake = 0;                  // minor units
/* Whether the text currently in the box parses.
 *
 * Keeping the last good number when the field goes unparseable seemed harmless and was not: the
 * box would read "-5" while the stake was still the 1,000,000,000,000 typed before it, and the
 * pull button would happily wager the latter. A control that displays one number and spends
 * another is the worst kind of bug on a page that moves money, so an unreadable field now means
 * NO stake at all until it reads as something again. */
let stakeInputValid = true;
let target = null;                  // the catalogue item being chased
let spinning = false;
let needleDeg = 0;
let root = null;
let dial = null;                    // the canvas dial; null means the SVG is doing the work
let fx = null;

export function mountUpgrader(view) {
  root = $('#upgRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
  }
  sync();
}

/* The mark. A stacked double chevron: the universal "this goes up" glyph, and the one thing on
 * the screen that appears at every scale — in the card, in the dial, and on the button — so the
 * whole component reads as one idea. */
const CHEV = `<svg viewBox="0 0 48 40" aria-hidden="true">
    <path d="M4 20 L24 4 L44 20 L36 20 L24 10 L12 20 Z"/>
    <path d="M4 36 L24 20 L44 36 L36 36 L24 26 L12 36 Z"/>
  </svg>`;

/* ─────────── maths ───────────
 * Money is minor units as a string off the API, so the arithmetic stays in BigInt and only the
 * final ratio is narrowed to a Number for display. */
function stakeMinor() {
  return BigInt(Math.max(0, Math.trunc(cashStake)));
}

function hasStake() {
  return stakeInputValid && stakeMinor() > 0n;
}

function stakeAffordable() {
  return stakeMinor() <= BigInt(state.balanceMinor || '0');
}

function targetValue() {
  return target ? BigInt(target.unitValueMinor) : 0n;
}

function chancePpm() {
  if (!hasStake() || !target || !state.upgradeConfig) return 0;
  const edge = BigInt(10_000 - Number(state.upgradeConfig.houseEdgeBps));
  const raw = (stakeMinor() * edge * 1_000_000n) / (targetValue() * 10_000n);
  const cap = BigInt(state.upgradeConfig.maxWinChancePpm);
  return Number(raw > cap ? cap : raw);
}

/* The multiplier window the server enforces. Showing a target it would refuse is worse than
 * showing fewer targets. */
function eligibleTargets() {
  if (!hasStake() || !state.upgradeConfig) return [];
  const source = stakeMinor();
  const min = BigInt(state.upgradeConfig.minMultiplierBps);
  const max = BigInt(state.upgradeConfig.maxMultiplierBps);
  return state.catalog.filter((item) => {
    if (item.availableQuantity < 1) return false;
    const value = BigInt(item.unitValueMinor);
    return value * 10_000n >= source * min && value * 10_000n <= source * max;
  });
}

function quoteFor(item) {
  const previous = target;
  target = item;
  const chance = chancePpm() / 1_000_000;
  target = previous;
  return chance;
}

/* ─────────── markup ─────────── */
function build() {
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    // the <svg> is already rotated -90deg, so index 0 lands at the top on its own
    const a = (i / TICKS) * Math.PI * 2;
    const r1 = R - 12, r2 = R - 7.5;
    return `<line class="tick" x1="${(60 + Math.cos(a) * r1).toFixed(2)}" y1="${(60 + Math.sin(a) * r1).toFixed(2)}"`
      + ` x2="${(60 + Math.cos(a) * r2).toFixed(2)}" y2="${(60 + Math.sin(a) * r2).toFixed(2)}"/>`;
  }).join('');

  root.innerHTML = `
    <div class="uwrap">
      <div class="utools" role="group" aria-label="Upgrader options">
        <button class="utool" id="upgFairBtn" type="button" title="Provably fair"
                aria-label="Provably fair">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.3-7.5 9.5-4.4-1.2-7.5-5.1-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>
        </button>
        <span class="utool__seed mono" id="upgSeed">—</span>
        <span class="utool__stat mono" id="telStat" data-s="idle">STANDBY</span>
        <button class="ihint" type="button" id="upgHint"></button>
      </div>

      <div class="ustage">
        <!-- LEFT · the stake. Cash off the wallet, nothing else. -->
        <section class="ucard ucard--src" id="bayStake" data-loaded="0" aria-label="Your stake">
          <span class="ucard__head">Your stake</span>
          <span class="ucard__sub mono" id="stakeSub">—</span>

          <span class="ucard__art" id="artStake" data-empty="1">
            <img src="${IMG}gold_ingot.png" alt="">
            <span class="ucard__glyph" aria-hidden="true">${CHEV}</span>
          </span>

          <div class="amountbox">
            <span class="amountbox__cur">$</span>
            <input class="amountbox__in mono" id="stakeIn" inputmode="text" autocomplete="off"
                   spellcheck="false" aria-label="Stake amount" aria-describedby="stakeHint"
                   value="0">
          </div>
          <!-- Empty unless something is actually wrong. It is a validation channel now, not a
               place to teach the field's syntax — the chips below do that by being pressable. -->
          <span class="ucard__hint" id="stakeHint"></span>
          <div class="qchips" id="stakeChips" role="group" aria-label="Quick stake"></div>
        </section>

        <!-- CENTRE · the dial, and only the dial -->
        <div class="udial" id="wheel">
          <div class="wheel__ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <defs>
                <linearGradient id="upgGrad" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0%"   stop-color="#ff6a00"/>
                  <stop offset="55%"  stop-color="#ffaa00"/>
                  <stop offset="100%" stop-color="#ffe45c"/>
                </linearGradient>
              </defs>
              <g class="wheel__ticks" id="wheelTicks">${ticks}</g>
              <circle class="wheel__track" cx="60" cy="60" r="${R}"/>
              <circle class="wheel__arc" id="wheelArc" cx="60" cy="60" r="${R}"
                      stroke-dasharray="0 ${C.toFixed(2)}" data-empty="1"/>
            </svg>
            <canvas class="wheel__3d" id="wheelGl" aria-hidden="true"></canvas>
            <canvas class="wheel__fx" id="wheelFx" aria-hidden="true"></canvas>
            <div class="wheel__needle" id="needle"><i></i></div>
            <div class="wheel__mid" id="wheelMid" data-state="">
              <span class="udial__glyph" aria-hidden="true">${CHEV}</span>
              <span class="wheel__pct" id="wheelPct">—</span>
              <span class="wheel__lbl" id="wheelLbl">WIN CHANCE</span>
            </div>
          </div>
        </div>

        <!-- RIGHT · the payout being chased -->
        <button class="ucard ucard--dst" id="bayTarget" data-loaded="0"
                aria-label="Choose the payout you are chasing">
          <span class="ucard__head">Chasing</span>
          <span class="ucard__sub mono" id="metaSub">—</span>
          <span class="ucard__art" id="artTarget" data-empty="1">
            <img src="${IMG}ender_chest_anim.gif" alt="">
            <span class="ucard__glyph" aria-hidden="true">${CHEV}</span>
          </span>
          <span class="ucard__meta" id="metaTarget"></span>
        </button>
      </div>

      <button class="btn" id="pullBtn" disabled>
        <span class="btn__chev" aria-hidden="true">${CHEV}</span>
        <span id="pullLabel">Upgrade</span>
      </button>
    </div>

    <section class="card" style="margin-top:16px">
      <h2 class="card__h">Everything you can chase
        <button class="ihint" type="button" aria-label="Each percentage is the real chance at that payout with the stake you have set."
                data-tip="Each percentage is the real chance at that payout with the stake you have set."></button>
      </h2>
      <div class="pickgrid" id="upgCat"></div>
    </section>`;

  $('#bayTarget', root).addEventListener('click', pickTarget);
  $('#upgFairBtn', root).addEventListener('click', showFairness);
  $('#pullBtn', root).addEventListener('click', pull);

  buildChips();

  const input = $('#stakeIn', root);
  input.addEventListener('input', () => {
    const parsed = parseAmount(input.value);
    stakeInputValid = parsed !== null;
    // An empty box is not an error, it is simply no stake yet.
    if (input.value.trim() === '') stakeInputValid = true;
    cashStake = parsed ?? 0;
    dropIneligibleTarget();
    sync({ keepInput: true });
  });
  input.addEventListener('blur', () => {
    const parsed = parseAmount(input.value);
    if (parsed === null) {
      // Snap back to the last figure the app actually holds, so the box and the stake agree.
      cashStake = 0;
      stakeInputValid = true;
    }
    input.value = formatAmountInput(cashStake);
    sync();
  });

  bus.addEventListener('change', () => {
    if (!root?.isConnected || spinning) return;
    if (target && !state.catalog.some((item) => item.catalogItemId === target.catalogItemId)) {
      target = null;
    }
    sync();
  });

  fx = makeFx($('#wheelFx', root));

  /* Decode the reveal sprites now, while the page is idle. Warming at pull time put the cost
   * inside the spin — the one moment it must not be spent. */
  const warm = () => warmReveal();
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2500 });
  else setTimeout(warm, 900);

  root.addEventListener('wheel:tense', () => { root.dataset.tense = '1'; });

  try {
    dial = createWheel($('#wheelGl', root));
    root.querySelector('.wheel__ring').dataset.mode = '2d';
    dial.setChance(chancePpm() / 1_000_000);
  } catch {
    dial = null;
  }
}

/* The quick-stake row.
 *
 * Additive amounts rather than fractions of the wallet. The fractions were a fair answer to
 * balances that span several orders of magnitude, but they are not the thing a player is
 * actually reaching for: somebody who wants to put a million in wants a million, not "whatever
 * ten percent of me happens to be today", and they would have to read their own balance to find
 * out what they just pressed. A chip that names the figure it adds needs no reading at all.
 *
 * The multipliers stay, because doubling after a loss and halving after a win are the two moves
 * people repeat, and both are relative to the stake rather than to the wallet.
 *
 * Every one of them is clamped to the balance by setStake, so MAX is not a special case — it is
 * simply the largest number that survives the clamp. */
const STAKE_STEPS = [
  ['+$100K', 100_000],
  ['+$1M', 1_000_000],
  ['+$10M', 10_000_000],
];

function buildChips() {
  const chips = $('#stakeChips', root);
  chips.innerHTML = '';

  for (const [label, step] of STAKE_STEPS) {
    const chip = el('button', 'qchip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => setStake(cashStake + step));
    chips.appendChild(chip);
  }

  const half = el('button', 'qchip', '&frac12;x');
  half.type = 'button';
  half.addEventListener('click', () => setStake(Math.floor(cashStake / 2)));

  const double = el('button', 'qchip', '2x');
  double.type = 'button';
  double.addEventListener('click', () => setStake(cashStake * 2));

  const max = el('button', 'qchip qchip--max', 'MAX');
  max.type = 'button';
  max.addEventListener('click', () => setStake(state.balance));

  chips.append(half, double, max);
}

function setStake(value) {
  const balance = Math.trunc(state.balance);
  stakeInputValid = true;
  cashStake = Math.max(0, Math.min(Math.trunc(Number(value) || 0), balance));
  const input = $('#stakeIn', root);
  if (input) input.value = formatAmountInput(cashStake);
  dropIneligibleTarget();
  sync();
}

/* A stake change moves the multiplier window, so a target that was legal a keystroke ago may not
 * be now. Dropping it beats showing a payout the server is about to refuse. */
function dropIneligibleTarget() {
  if (target && !eligibleTargets().some((item) => item.catalogItemId === target.catalogItemId)) {
    target = null;
  }
}

/* ─────────── particle layer over the ring ───────────
 * Scatter for the sparks, and nothing else. Every outcome on this page is the server's, so no
 * part of this module may look like a source of chance. Keeping the platform's general-purpose
 * random number generator out of this file entirely is what makes that checkable by grep — the
 * frontend contract test asserts it. This xorshift feeds pixel positions and never touches a
 * result. */
let fxSeed = 0x2f6e2b1;
function fxRand() {
  fxSeed ^= fxSeed << 13;
  fxSeed ^= fxSeed >>> 17;
  fxSeed ^= fxSeed << 5;
  return (fxSeed >>> 0) / 4294967296;
}

function makeFx(canvas) {
  const bits = [];
  let raf = 0;
  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width)) canvas.width = Math.max(1, Math.round(rect.width));
    if (canvas.height !== Math.round(rect.height)) canvas.height = Math.max(1, Math.round(rect.height));
  };
  const frame = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.life -= 1 / 60;
      if (b.life <= 0) { bits.splice(i, 1); continue; }
      b.vy += b.grav / 60;
      b.x += b.vx / 60; b.y += b.vy / 60;
      b.vx *= 0.97; b.vy *= 0.97;
      ctx.globalAlpha = Math.max(0, b.life / b.max);
      ctx.fillStyle = b.col;
      const s = b.size * (0.4 + b.life / b.max);
      ctx.fillRect(b.x - s / 2, b.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    raf = bits.length ? requestAnimationFrame(frame) : 0;
  };
  return {
    burst(col, { n = 60, spd = 260, grav = 240, size = 4 } = {}) {
      if (reduceMotion()) return;
      fit();
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const ring = Math.min(cx, cy) * 0.82;
      for (let i = 0; i < n; i++) {
        const a = fxRand() * Math.PI * 2;
        const v = spd * (0.4 + fxRand());
        bits.push({
          x: cx + Math.cos(a) * ring, y: cy + Math.sin(a) * ring,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          life: 0.9 + fxRand() * 0.5, max: 1.4, col, size, grav,
        });
      }
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}

/* ─────────── target picker ─────────── */
function pickTarget() {
  if (spinning) return;
  if (!hasStake()) {
    $('#stakeIn', root)?.focus();
    return;
  }
  const options = eligibleTargets();
  openModal('What are you chasing?', (body) => {
    body.innerHTML = options.length
      ? '<div class="pickgrid" id="pt"></div>'
      : '<p class="card__p">Nothing is in range for that stake.</p>';
    const grid = $('#pt', body);
    if (!grid) return;
    options.forEach((item) => {
      const button = el('button');
      button.type = 'button';
      if (target && target.catalogItemId === item.catalogItemId) button.dataset.on = '1';
      button.appendChild(itemTile(item, { size: 'sm', sub: pct(quoteFor(item), 2) }));
      button.addEventListener('click', () => { target = item; closeModal(); sync(); });
      grid.appendChild(button);
    });
  });
}

/* ─────────── render ─────────── */
function sync({ keepInput = false } = {}) {
  if (!root?.isConnected) return;

  paintStake(keepInput);
  paintTarget();

  const ppm = chancePpm();
  const chance = ppm / 1_000_000;
  const arc = $('#wheelArc', root);
  arc.setAttribute('stroke-dasharray', `${(chance * C).toFixed(2)} ${C.toFixed(2)}`);
  // a zero-length arc still paints a cap, so hide it outright
  arc.setAttribute('data-empty', chance > 0 ? '0' : '1');
  const lit = Math.round(chance * TICKS);
  [...$('#wheelTicks', root).children].forEach((tick, i) => tick.classList.toggle('on', i < lit));
  if (dial) dial.setChance(chance);

  if (!spinning) {
    $('#wheelPct', root).textContent = ppm ? pct(chance, 2) : '—';
    $('#wheelLbl', root).textContent = 'WIN CHANCE';
    $('#wheelMid', root).dataset.state = '';
  }

  $('#upgSeed', root).textContent = state.fairness
    ? `${state.fairness.serverSeedHash.slice(0, 8)}…·${state.fairness.nonce}`
    : '—';

  const armed = hasStake() && !!target;
  const status = $('#telStat', root);
  status.dataset.s = spinning ? 'fire' : !stakeAffordable() ? 'warn' : armed ? 'armed' : 'idle';
  status.textContent = spinning ? 'SERVER ROLL'
    : !stakeAffordable() ? 'OVER BALANCE'
    : armed ? 'ARMED' : 'STANDBY';

  /* The sentence is set on both the tooltip and the accessible name: the bubble is CSS-generated
   * content, which assistive tech does not reliably announce, so the name has to carry it too. */
  const hint = $('#upgHint', root);
  if (hint) {
    const text = hintText();
    hint.dataset.tip = text;
    hint.setAttribute('aria-label', text);
  }

  const button = $('#pullBtn', root);
  button.disabled = spinning || !armed || ppm < 1 || !stakeAffordable();
  $('#pullLabel', root).textContent = !state.authenticated ? 'Log in first'
    : !stakeInputValid ? 'Not an amount'
    : !hasStake() ? 'Set a stake'
    : !stakeAffordable() ? `Need ${money(Number(stakeMinor()))}`
    : !target ? 'Pick a payout'
    : `Stake ${money(Number(stakeMinor()))}`;

  paintCatalog();
}

function paintStake(keepInput) {
  const card = $('#bayStake', root);
  const art = $('#artStake', root);
  const input = $('#stakeIn', root);
  const hint = $('#stakeHint', root);

  if (!keepInput && input && document.activeElement !== input) {
    input.value = formatAmountInput(cashStake);
  }
  card.dataset.loaded = cashStake > 0 ? '1' : '0';
  art.dataset.empty = cashStake > 0 ? '0' : '1';

  $('#stakeSub', root).textContent = state.authenticated ? money(state.balance) : '—';

  /* Silent while the figure is usable. The hint used to restate the field's syntax on every
   * render, which meant the one time it had something urgent to say — you cannot afford this —
   * the player had already learned to stop reading it. */
  if (!stakeInputValid) {
    hint.dataset.bad = '1';
    hint.textContent = 'Not an amount';
  } else if (!stakeAffordable()) {
    hint.dataset.bad = '1';
    hint.textContent = `Over ${money(state.balance)}`;
  } else {
    delete hint.dataset.bad;
    hint.textContent = '';
  }
}

function paintTarget() {
  const card = $('#bayTarget', root);
  const art = $('#artTarget', root);
  const meta = $('#metaTarget', root);
  const sub = $('#metaSub', root);

  if (target) {
    card.dataset.loaded = '1';
    card.style.setProperty('--rar', RARITY[target.rarity].color);
    art.dataset.empty = '0';
    art.querySelector('img').src = safeImage(target.img);
    /* The multiplier, not the rarity name. Rarity is already carried by the card's border colour
     * and by the art; the jump from stake to payout is the figure the choice actually turns on,
     * and it had nowhere else on the card to live. */
    const multiple = stakeMinor() > 0n ? Number(targetValue()) / Number(stakeMinor()) : 0;
    sub.textContent = multiple > 0 ? `${multiple.toFixed(2)}x` : RARITY[target.rarity].name;
    meta.innerHTML =
      `<b class="ucard__name">${escapeText(target.name)}</b>` +
      `<b class="ucard__val mono">${money(target.value)}</b>`;
  } else {
    card.dataset.loaded = '0';
    card.style.removeProperty('--rar');
    art.dataset.empty = '1';
    art.querySelector('img').src = IMG + 'ender_chest_anim.gif';
    sub.textContent = '—';
    meta.innerHTML = '';
  }
}

/* One sentence, behind the info icon, quoting the live server config rather than a hard-coded
 * edge so it cannot drift from what the backend will actually apply.
 *
 * This is what is left of a four-line paragraph that sat under the wheel on every render. The
 * formula was the only part of it a player could not read off the dial directly — the chance, the
 * multiplier and the outcome are all already on screen as numbers — so the formula is the part
 * that survived. */
function hintText() {
  const config = state.upgradeConfig;
  if (!config) return 'The server recalculates every roll from locked values after you commit.';
  const edge = (Number(config.houseEdgeBps) / 100).toFixed(2);
  const cap = (Number(config.maxWinChancePpm) / 10_000).toFixed(2);
  return `Chance = (stake ÷ payout) × (1 − ${edge}% edge), capped at ${cap}%.`;
}

function paintCatalog() {
  const grid = $('#upgCat', root);
  grid.innerHTML = '';
  /* Logged out is checked FIRST, and it is a different sentence.
   *
   * The catalogue only loads for an authenticated session, so a logged-out player used to fall
   * through to "nothing is in range for that stake" — which is a statement about the catalogue that
   * is not true, and sends somebody hunting for a stake size that will never work. The picker has
   * three empty states because there are three reasons it can be empty. */
  if (!state.authenticated) {
    grid.innerHTML = '<p class="card__p">Log in to pick a target.</p>';
    return;
  }
  if (!hasStake()) {
    grid.innerHTML = '<p class="card__p">Set a stake.</p>';
    return;
  }
  if (!state.catalog.length) {
    grid.innerHTML = '<p class="card__p">No catalogue yet.</p>';
    return;
  }
  const options = eligibleTargets();
  if (!options.length) {
    grid.innerHTML = '<p class="card__p">Nothing is in range for that stake.</p>';
    return;
  }
  options.forEach((item) => {
    const button = el('button');
    button.type = 'button';
    if (target && target.catalogItemId === item.catalogItemId) button.dataset.on = '1';
    button.appendChild(itemTile(item, { size: 'sm', sub: pct(quoteFor(item), 2) }));
    button.addEventListener('click', () => { target = item; sync(); });
    grid.appendChild(button);
  });
}

/* ─────────── the pull ─────────── */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pull() {
  if (spinning || !hasStake() || !target || !stakeAffordable()) return;
  const destination = target;
  const wagered = stakeMinor();
  spinning = true;
  sync();
  playSound('anvil');

  let response;
  try {
    response = await runBalanceUpgrade(wagered.toString(), destination);
  } catch (error) {
    spinning = false;
    showError(error);
    sync();
    return;
  }

  const round = response.round;
  const won = round.outcome === 'win';
  const chance = Number(round.chance_ppm) / 1_000_000;
  const landing = (Number(round.roll_ppm) / 1_000_000) * 360;
  const payout = Number(round.payout_minor ?? 0);

  const wheel = $('#wheel', root);
  const mid = $('#wheelMid', root);
  const needle = $('#needle', root);
  wheel.classList.remove('is-win', 'is-lose');
  wheel.classList.add('is-spinning');
  mid.dataset.state = 'spin';
  $('#wheelPct', root).textContent = pct(chance, 2);
  $('#wheelLbl', root).textContent = 'VERIFIED ROLL';

  /* How close this one came, in ticks. The band runs [0, B) clockwise from the datum, so its two
   * edges are at 0 and B and the landing can be near either — including by wrapping past 360 back
   * to 0. A win one tick inside the edge and a loss one tick outside it are the same moment to
   * watch, which is why this is measured regardless of outcome. */
  const band = chance * 360;
  const edgeTicks = Math.min(landing, Math.abs(landing - band), 360 - landing) / (360 / TICKS);

  try {
    const reduce = reduceMotion();
    if (dial) {
      dial.reset();
      await dial.spin((landing * Math.PI) / 180, won ? 'win' : 'lose', edgeTicks);
    } else {
      needleDeg += (reduce ? 0 : 4 * 360) + (((landing - (needleDeg % 360)) + 360) % 360);
      needle.style.transition = reduce ? 'none' : '';
      needle.style.transform = `rotate(${needleDeg}deg)`;
      await wait(reduce ? 60 : 4400);
    }
    wheel.classList.remove('is-spinning');
    delete root.dataset.tense;

    if (won) {
      wheel.classList.add('is-win');
      mid.dataset.state = 'win';
      $('#wheelPct', root).textContent = 'HIT';
      $('#wheelLbl', root).textContent = destination.name.toUpperCase();
      if (fx) fx.burst('#ffd700', { n: 70 });
      playSound(payout >= 50_000_000 ? 'jackpot' : 'win');
      toast({
        kind: 'win', img: destination.img, title: `Hit ${destination.name}`,
        body: `+${money(payout)} cash`,
      });
      broadcast({
        who: 'you', color: RARITY[destination.rarity].color, img: destination.img,
        text: `turned ${money(Number(wagered))} into ${money(payout)} at ${pct(chance, 2)}`,
      });
    } else {
      wheel.classList.add('is-lose');
      mid.dataset.state = 'lose';
      $('#wheelPct', root).textContent = 'MISSED';
      $('#wheelLbl', root).textContent = money(Number(wagered)) + ' GONE';
      if (fx) fx.burst('#ff2222', { n: 40 });
      playSound('lose');
      toast({
        kind: 'lose', img: destination.img, title: `Missed ${destination.name}`,
        body: `${pct(chance, 2)} was not enough.`,
      });
    }

    await playReveal({ won, item: destination, stake: Number(wagered), payout: destination.value });
  } catch (error) {
    console.error('upgrade animation failed', error);
  }

  spinning = false;
  wheel.classList.remove('is-win', 'is-lose');
  /* The stake survives the round: the amount is still valid and re-staking it is the common next
   * action. Only the target clears, because the window may have moved with the new balance. */
  target = null;
  sync();
}

/* The commitment is the server's, so there is nothing to show until one has been issued. Shaped
 * to the sheet's field names rather than the API's — the client seed is minted per request and
 * never held, so it is described, not printed. */
function showFairness() {
  if (!state.fairness) {
    toast({ kind: 'lose', title: 'No fairness commitment', body: 'Log in to request the active server commitment.' });
    return;
  }
  fairSheet({
    server: state.fairness.serverSeedHash,
    client: 'generated securely for each request',
    nonce: state.fairness.nonce,
    algorithm: state.fairness.algorithm,
  });
}

function showError(error) {
  toast({
    kind: 'lose',
    title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Upgrade failed',
    body: error?.message || 'The server rejected the upgrade.',
  });
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
