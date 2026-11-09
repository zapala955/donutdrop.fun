/* upgrader.js — stake cash, chase a payout. The backend owns the roll.
 *
 * The layout is the site's game frame (2026-11-09): the panel on the left holds the stake, the
 * multiplier and the odds and the one button; the stage holds the stake, the dial and the payout
 * side by side, and every payout in range under them. On a phone the dial comes first, the panel
 * straight under it with the button, and the payouts after. The result lands on the dial itself --
 * no full-screen scene to dismiss, no toast -- and the payout stays chosen for the next round.
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
let band = 0;                       // index into BANDS; 0 is everything
let spinning = false;
let needleDeg = 0;
let root = null;
let dial = null;                    // the canvas dial; null means the SVG is doing the work
let resultTimer = 0;                // clears the dial's result back to the odds

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

/* The payout bands the picker groups by.
 *
 * The catalogue carries fifty-one fixed denominations, so a stake anywhere in the middle of the
 * ladder puts twenty-odd legal targets on screen at once. The question a player is actually asking
 * of that grid is not which artefact — every one of them pays cash and nothing else — but how far
 * they are reaching. These chips ask it once, above the tiles, instead of leaving it implicit in
 * twenty percentages.
 *
 * The bounds are multiples of the stake and not fixed prices, because the same tile is a short
 * reach at one stake and a longshot at another. `All` is first because it is the honest default:
 * a filter that starts narrowed hides targets the player never asked to hide. */
const BANDS = [
  ['All', 0, Infinity],
  ['Under 3x', 0, 3],
  ['3-10x', 3, 10],
  ['10-30x', 10, 30],
  ['Over 30x', 30, Infinity],
];

/** The eligible targets inside one band. Index 0 is every eligible target, unfiltered. */
function bandTargets(index) {
  const options = eligibleTargets();
  if (index === 0) return options;
  const entry = BANDS[index];
  if (!entry) return options;
  const [, low, high] = entry;
  const source = Number(stakeMinor());
  if (!source) return [];
  return options.filter((item) => {
    const multiple = item.value / source;
    return multiple >= low && multiple < high;
  });
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
    <section class="ug__duel" aria-label="The upgrade">
      <div class="ug__item ug__item--from" id="bayStake" data-loaded="0">
        <span class="ug__art" id="artStake" data-empty="1"><img src="${IMG}gold_ingot.png" alt=""></span>
        <span class="ug__cap">You stake</span>
        <b class="ug__amt mono" id="stakeSub">—</b>
      </div>

      <div class="ug__dial" id="wheel">
        <div class="ug__ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <g class="ug__ticks" id="wheelTicks">${ticks}</g>
            <circle class="ug__track" cx="60" cy="60" r="${R}"/>
            <circle class="ug__arc" id="wheelArc" cx="60" cy="60" r="${R}"
                    stroke-dasharray="0 ${C.toFixed(2)}" data-empty="1"/>
          </svg>
          <canvas class="ug__canvas" id="wheelGl" aria-hidden="true"></canvas>
          <div class="ug__needle" id="needle"><i></i></div>
          <div class="ug__mid" id="wheelMid" data-state="">
            <span class="ug__pct" id="wheelPct">—</span>
            <span class="ug__lbl" id="wheelLbl">Win chance</span>
          </div>
        </div>
      </div>

      <button class="ug__item ug__item--to" id="bayTarget" type="button" data-loaded="0"
              aria-label="Choose the payout you are chasing">
        <span class="ug__art" id="artTarget" data-empty="1">
          <img src="${IMG}ender_chest_anim.gif" alt="">
          <span class="ug__glyph" aria-hidden="true">${CHEV}</span>
        </span>
        <span class="ug__cap" id="metaSub">Pick a payout</span>
        <span class="ug__meta" id="metaTarget"></span>
      </button>
    </section>

    <aside class="ug__panel" aria-label="Your upgrade">
      <div class="ug__form">
        <label class="ug__label ug__label--row" for="stakeIn"><span>Stake</span><span class="ug__bal mono" id="upgBalance"></span></label>
        <div class="ug__field">
          <span aria-hidden="true">$</span>
          <input id="stakeIn" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off"
                 spellcheck="false" aria-label="Stake amount" aria-describedby="stakeHint" value="0">
          <button type="button" class="ug__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="ug__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="ug__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
        </div>
        <!-- Empty unless something is actually wrong: a validation channel, not a syntax lesson. -->
        <span class="ug__hint" id="stakeHint"></span>
        <div class="ug__adds" id="stakeChips" role="group" aria-label="Add to the stake"></div>
        <div class="ug__stats">
          <div class="ug__stat"><span class="ug__label">Multiplier</span><b class="mono" id="upgMult">—</b></div>
          <div class="ug__stat"><span class="ug__label">Win chance</span><b class="mono" id="upgChance">—</b></div>
        </div>
        <button class="btn ug__go" id="pullBtn" type="button" data-sfx="none" disabled>
          <span id="pullLabel">Upgrade</span>
        </button>
        <div class="ug__tools">
          <button class="ug__fair" id="upgFairBtn" type="button" aria-label="Provably fair">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.3-7.5 9.5-4.4-1.2-7.5-5.1-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>
            <span>Provably fair</span>
          </button>
          <button class="ihint" type="button" id="upgHint"></button>
        </div>
      </div>
    </aside>

    <section class="ug__pick" aria-label="Every payout you can chase">
      <h2 class="ug__h">Everything you can chase
        <button class="ihint" type="button" aria-label="Each percentage is the real chance at that payout with the stake you have set."
                data-tip="Each percentage is the real chance at that payout with the stake you have set."></button>
      </h2>
      <div class="ug__bands" id="upgBands" role="group" aria-label="Filter targets by payout"></div>
      <div class="pickgrid ug__grid" id="upgCat"></div>
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
    clearResult();
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

  /* ½, 2× and Max in the field, as every game has them; each is clamped by setStake. */
  root.querySelectorAll('.ug__adj').forEach((button) => button.addEventListener('click', () => {
    if (spinning) return;
    const adj = button.dataset.adj;
    setStake(adj === 'half' ? Math.floor(cashStake / 2) : adj === 'double' ? cashStake * 2 : state.balance);
  }));

  root.addEventListener('wheel:tense', () => { root.dataset.tense = '1'; });

  try {
    dial = createWheel($('#wheelGl', root));
    root.querySelector('.ug__ring').dataset.mode = '2d';
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
  // Added with the billion ceiling: reaching it from zero in ten-million steps is a hundred
  // presses, which is not a control, it is a chore.
  ['+$100M', 100_000_000],
];

/* The ceiling the server enforces, or no ceiling if it has not said yet.
 *
 * Read from the config the upgrader already fetches rather than written here, because a limit
 * typed in two places is a limit that disagrees with itself the first time one of them changes.
 * Until it arrives the balance is the only clamp, which is exactly what it was before. */
function maxStake() {
  const published = Number(state.upgradeConfig?.maxStakeMinor ?? 0);
  return Number.isFinite(published) && published > 0 ? published : Infinity;
}

function buildChips() {
  const chips = $('#stakeChips', root);
  chips.innerHTML = '';

  /* ½, 2× and Max live in the field now, as in every other game; the row is the additive steps. */
  for (const [label, step] of STAKE_STEPS) {
    const chip = el('button', 'ug__add', label);
    chip.type = 'button';
    chip.addEventListener('click', () => { if (!spinning) setStake(cashStake + step); });
    chips.appendChild(chip);
  }
}

function setStake(value) {
  const balance = Math.trunc(state.balance);
  stakeInputValid = true;
  cashStake = Math.max(0, Math.min(Math.trunc(Number(value) || 0), balance, maxStake()));
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

/* ─────────── target picker ─────────── */
function pickTarget() {
  if (spinning) return;
  if (!hasStake()) {
    $('#stakeIn', root)?.focus();
    return;
  }
  const options = bandTargets(band);
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
      button.addEventListener('click', () => { target = item; closeModal(); clearResult(); sync(); });
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
  paintChance(chance);

  // The dial shows the odds, unless a round's result is still on it (see showResult).
  if (!spinning && !resultTimer) {
    $('#wheelPct', root).textContent = ppm ? pct(chance, 2) : '—';
    $('#wheelLbl', root).textContent = 'Win chance';
    $('#wheelMid', root).dataset.state = '';
  }
  const multiple = hasStake() && target ? Number(targetValue()) / Number(stakeMinor()) : 0;
  $('#upgMult', root).textContent = multiple > 0 ? `${multiple.toFixed(2)}×` : '—';
  $('#upgChance', root).textContent = ppm ? pct(chance, 2) : '—';

  const armed = hasStake() && !!target;

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
  button.setAttribute('aria-busy', String(spinning));
  $('#pullLabel', root).textContent = !state.authenticated ? 'Log in first'
    : spinning ? 'Rolling…'
    : !stakeInputValid ? 'Not an amount'
    : !hasStake() ? 'Set a stake'
    : !stakeAffordable() ? `Need ${money(Number(stakeMinor()))}`
    : !target ? 'Pick a payout'
    : `Upgrade · ${money(Number(stakeMinor()))}`;
  for (const node of root.querySelectorAll('#stakeIn, .ug__adj, .ug__add')) node.disabled = spinning;

  paintCatalog();
}

/* The win band on the ring: the SVG arc, the lit ticks and the canvas dial. */
function paintChance(chance) {
  const arc = $('#wheelArc', root);
  arc.setAttribute('stroke-dasharray', `${(chance * C).toFixed(2)} ${C.toFixed(2)}`);
  // a zero-length arc still paints a cap, so hide it outright
  arc.setAttribute('data-empty', chance > 0 ? '0' : '1');
  const lit = Math.round(chance * TICKS);
  [...$('#wheelTicks', root).children].forEach((tick, i) => tick.classList.toggle('on', i < lit));
  if (dial) dial.setChance(chance);
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

  $('#stakeSub', root).textContent = hasStake() ? money(Number(stakeMinor())) : '—';
  $('#upgBalance', root).textContent = state.authenticated ? money(state.balance) : '';

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
    sub.textContent = multiple > 0 ? `${multiple.toFixed(2)}× payout` : RARITY[target.rarity].name;
    meta.innerHTML =
      `<b class="ug__name">${escapeText(target.name)}</b>` +
      `<b class="ug__amt mono">${money(target.value)}</b>`;
  } else {
    card.dataset.loaded = '0';
    card.style.removeProperty('--rar');
    art.dataset.empty = '1';
    art.querySelector('img').src = IMG + 'ender_chest_anim.gif';
    sub.textContent = 'Pick a payout';
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

/**
 * Why nothing is in range, and what stake would fix it.
 *
 * "Nothing is in range for that stake" is true and useless: it leaves the player guessing at a
 * number in a range five orders of magnitude wide. The server only accepts a target between
 * minMultiplierBps and maxMultiplierBps of the stake, so given the catalogue's cheapest and
 * dearest rows the workable stake range is arithmetic, and saying it costs nothing.
 *
 * Returns a sentence, or null when the range is genuinely unknowable (no config, no catalogue).
 */
function outOfRangeReason() {
  const config = state.upgradeConfig;
  if (!config || !state.catalog.length) return null;
  const source = Number(stakeMinor());
  const min = Number(config.minMultiplierBps) / 10_000;
  const max = Number(config.maxMultiplierBps) / 10_000;
  if (!(source > 0) || !(min > 0) || !(max > min)) return null;
  const values = state.catalog.map((item) => item.value).filter((value) => value > 0);
  if (!values.length) return null;
  const cheapest = Math.min(...values);
  const dearest = Math.max(...values);

  // Too small: even the top of the catalogue is under the smallest payout this stake may chase.
  if (dearest < source * min) {
    const ceiling = Math.floor(dearest / min);
    return 'The biggest prize is ' + money(dearest) + '. Drop your stake to ' + money(ceiling)
      + ' or less.';
  }
  // Too large the other way: the cheapest row is still more than this stake may reach.
  if (cheapest > source * max) {
    const floor = Math.ceil(cheapest / max);
    return 'The cheapest prize is ' + money(cheapest) + '. Raise your stake to ' + money(floor)
      + ' or more.';
  }
  return null;
}

function paintBands(counts) {
  const rail = $('#upgBands', root);
  if (!rail) return;
  rail.replaceChildren();
  BANDS.forEach(([label], index) => {
    const count = counts[index];
    const chip = el('button', 'bandchip');
    chip.type = 'button';
    /* The count is part of the label, not a badge. An empty band that looks pressable is a dead
     * click, and one that is merely dimmed does not say why. */
    chip.textContent = label + ' (' + count + ')';
    chip.setAttribute('aria-pressed', String(index === band));
    chip.disabled = count === 0 && index !== band;
    chip.addEventListener('click', () => { band = index; paintCatalog(); });
    rail.appendChild(chip);
  });
}

function paintCatalog() {
  const grid = $('#upgCat', root);
  const rail = $('#upgBands', root);
  grid.innerHTML = '';
  if (rail) rail.replaceChildren();
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
    const message = el('p', 'card__p');
    message.textContent = outOfRangeReason() ?? 'Nothing is in range for that stake.';
    grid.appendChild(message);
    return;
  }

  /* A band the stake has emptied falls back to All rather than showing a filtered blank.
   * A sticky filter that silently hides every target is indistinguishable from a broken page. */
  const counts = BANDS.map((entry, index) => bandTargets(index).length);
  if (counts[band] === 0) band = 0;
  paintBands(counts);

  bandTargets(band).forEach((item) => {
    const button = el('button');
    button.type = 'button';
    if (target && target.catalogItemId === item.catalogItemId) button.dataset.on = '1';
    button.appendChild(itemTile(item, { size: 'sm', sub: pct(quoteFor(item), 2) }));
    button.addEventListener('click', () => { target = item; clearResult(); sync(); });
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
  clearResult();
  sync();
  playSound('upgStart');

  let response;
  try {
    /* Deferred: the wheel spins for four and a half seconds after this resolves, and the wallet
     * pill must not move until it stops. See runBalanceUpgrade. */
    response = await runBalanceUpgrade(wagered.toString(), destination, { defer: true });
  } catch (error) {
    spinning = false;
    showError(error);
    sync();
    return;
  }

  const round = response.round;

  await spinRound({
    won: round.outcome === 'win',
    chance: Number(round.chance_ppm) / 1_000_000,
    landing: (Number(round.roll_ppm) / 1_000_000) * 360,
    destination,
    stake: Number(wagered),
    payout: Number(round.payout_minor ?? 0),
    label: 'VERIFIED ROLL',
    announce: true,
    /* The money moves HERE, on the frame the wheel stops, alongside the colour, the sound and the
     * toast. Deliberately not awaited: settle applies the round's own closing balance before its
     * first await, so the pill is already correct, and the refreshes behind it are reconciliation
     * that nobody is waiting to read. Awaiting would stall the win behind a network round trip. */
    onStop: () => { void response.settle(); },
  });

  /* The safety net. If the animation threw before onStop, the round is still settled and the
   * player still gets their balance — a broken animation must never cost somebody a payout.
   * Idempotent, so this is a no-op on the ordinary path. */
  await response.settle();

  spinning = false;
  /* The stake and the payout both survive the round: going again is the common next action. The
   * payout is dropped only if the new balance has moved it out of the window. */
  dropIneligibleTarget();
  sync();
}

/* ─────────── the test bench's spin ───────────
 * The dial, the burst, the sounds and the reveal exactly as a real round plays them, with an
 * outcome the animation test bench hands in instead of one off /v1/upgrades. Nothing is staked,
 * nothing settles, and nothing is announced: no toast and no chat line, because both would report
 * cash that never moved. The centre reads TEST SPIN rather than VERIFIED ROLL for the same reason.
 *
 * The bench's stake and item are swapped into the real fields for the length of the spin, so the
 * cards, the band and the odds all come out of the same code a real round uses, and the player's
 * own figures are put back afterwards. The roll comes from the caller: this module holds no source
 * of chance, test path or not. */

// bench items come from data.js, which prices in `value`; the upgrader reads unitValueMinor
function asTarget(item) {
  return { ...item, unitValueMinor: String(Math.trunc(item.value)) };
}

/** The live formula's chance for a made-up stake. 0 until the upgrader config has loaded. */
export function quoteTestSpin({ item, stake }) {
  const saved = [cashStake, stakeInputValid, target];
  cashStake = stake;
  stakeInputValid = true;
  target = asTarget(item);
  try {
    return chancePpm() / 1_000_000;
  } finally {
    [cashStake, stakeInputValid, target] = saved;
  }
}

/* `roll` is uniform in [0, 1). The band is [0, B) clockwise from the datum, so a hit lands inside it
 * and a miss anywhere past it; near misses turn up on their own. */
export async function playTestSpin({ won, roll, item, stake }) {
  if (!root?.isConnected) throw new Error('the upgrader is not mounted');
  if (spinning) throw new Error('the upgrader is mid-round');
  const chance = quoteTestSpin({ item, stake });
  if (!(chance > 0)) throw new Error('no win chance at that stake');
  if (!won && chance >= 1) throw new Error('a 100% chance cannot miss');
  const band = chance * 360;
  const landing = won ? roll * band : band + roll * (360 - band);

  const saved = [cashStake, stakeInputValid, target];
  spinning = true;
  cashStake = stake;
  stakeInputValid = true;
  target = asTarget(item);
  sync();
  // the made-up stake may be over the real balance; that is not something to warn about here
  const hint = $('#stakeHint', root);
  delete hint.dataset.bad;
  hint.textContent = '';
  $('#pullLabel', root).textContent = 'Test spin';
  playSound('upgStart');

  try {
    await spinRound({
      won, chance, landing, destination: target, stake,
      payout: won ? item.value : 0, label: 'TEST SPIN', announce: false,
    });
  } finally {
    [cashStake, stakeInputValid, target] = saved;
    spinning = false;
    sync();
  }
}

/* The spin itself, from release to the end of the reveal. Shared by the real round and the test
 * bench so the bench cannot drift from what ships. `landing` is in degrees clockwise from the
 * datum; `onStop` fires on the frame the wheel stops. */
async function spinRound({ won, chance, landing, destination, stake, payout, label, announce, onStop }) {
  const wheel = $('#wheel', root);
  const mid = $('#wheelMid', root);
  const needle = $('#needle', root);
  clearResult();
  wheel.classList.add('is-spinning');
  mid.dataset.state = 'spin';
  $('#wheelPct', root).textContent = pct(chance, 2);
  $('#wheelLbl', root).textContent = label;

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

    onStop?.();
    showResult({ won, chance, payout, stake, destination });
    if (won) {
      playSound(payout >= 50_000_000 ? 'jackpot' : 'upgWin');
      if (announce) {
        broadcast({
          who: 'you', color: RARITY[destination.rarity].color, img: destination.img,
          text: `turned ${money(stake)} into ${money(payout)} at ${pct(chance, 2)}`,
        });
      }
    } else {
      playSound('upgLose');
    }
    // A beat to read it before the button is live again.
    await wait(reduceMotion() ? 0 : 650);
  } catch (error) {
    console.error('upgrade animation failed', error);
  }
}

/* The result, on the dial: a hit shows what it paid in the win green and the payout card lights; a
 * miss turns the odds red. It stays a few seconds, or until the next round or any change. */
function showResult({ won, chance, payout, destination }) {
  const wheel = $('#wheel', root);
  const mid = $('#wheelMid', root);
  wheel.classList.add(won ? 'is-win' : 'is-lose');
  mid.dataset.state = won ? 'win' : 'lose';
  $('#wheelPct', root).textContent = won ? money(payout) : pct(chance, 2);
  $('#wheelLbl', root).textContent = won ? destination.name : 'Missed';
  if (!reduceMotion()) {
    mid.animate(
      [{ transform: 'scale(.8)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)' }],
      { duration: 360, easing: 'cubic-bezier(.16, 1, .3, 1)' },
    );
    if (won) {
      $('#bayTarget', root).animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.05)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' },
      );
    }
  }
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => { resultTimer = 0; clearResult(); sync(); }, 3200);
}

function clearResult() {
  window.clearTimeout(resultTimer);
  resultTimer = 0;
  $('#wheel', root)?.classList.remove('is-win', 'is-lose');
  dial?.reset();
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
