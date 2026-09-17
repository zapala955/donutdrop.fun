/* crates.js — the crate bench.
 *
 * Three regions that never move:
 *
 *   LEFT   the bench. What is selected, how many, what it costs, and the one button that spends
 *          money. It stays put while you browse, so the commitment is always in the same place
 *          and never scrolls away mid-decision.
 *   RIGHT  the wall. Search, sort, two range filters, and the grid.
 *   FOOT   the drop table of whatever is selected, always open.
 *
 * The drop table used to live behind an Inspect modal. Odds you have to click to see are odds
 * most people never look at, which is the wrong default for the one number that decides whether
 * a crate is worth opening. It is now simply on screen, beside the button that charges you.
 */
import { state, bus, openCase as requestCaseOpen, refreshCases } from './store.js';
import { $, el, money, pct, safeImage, grouped } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { playReel, warmReel } from './reel.js';
import { playCutscene, warmCutscene, isJackpot } from './cutscene.js';
import {
  playMystery, dismissReveals, isMystery, mysteryOdds, mysteryDrops, ordinaryDrops,
  mysteryPayloads, mysteryFloor, mysteryWorstMultiple,
} from './mystery.js';

/* The five profiles the seed generates, coldest to wildest. The order IS the risk axis: the
 * slider below indexes straight into it. */
const RISK_ORDER = ['safe', 'balanced', 'wild', 'degen', 'jackpot'];
const RISK_LABEL = {
  safe: 'Safe',
  balanced: 'Balanced',
  wild: 'Wild',
  degen: 'Degen',
  jackpot: 'Jackpot',
};
/* Gold through amber to ember, keyed to the VOLATILITY PERCENTAGE rather than to the profile
 * name. Colour and number therefore always agree: a crate reading 29% cannot be painted the shade
 * a crate reading 80% gets, which is exactly what happened while the colour came from the profile
 * and the number came from the solved distribution.
 *
 * Cool to hot reads as "how wild", not "good to bad" — a calm crate is not a better crate, and
 * every one of these returns the same 90%. Zero green, zero purple. */
const RISK_RAMP = [
  { upTo: 25, color: '#ffd700' },
  { upTo: 45, color: '#ffc400' },
  { upTo: 65, color: '#ffaa00' },
  { upTo: 82, color: '#ff7b00' },
  { upTo: 101, color: '#ff3b1f' },
];

function riskColorFor(percent) {
  return (RISK_RAMP.find((band) => percent < band.upTo) ?? RISK_RAMP[RISK_RAMP.length - 1]).color;
}

const SORTS = [
  { code: 'price-asc', label: 'Price ascending' },
  { code: 'price-desc', label: 'Price descending' },
  { code: 'top-desc', label: 'Biggest top prize' },
  { code: 'risk-asc', label: 'Calmest first' },
  { code: 'risk-desc', label: 'Wildest first' },
];

const QUANTITIES = [1, 2, 3, 4, 5];

/* Filter and selection state live here rather than in the DOM, so a repaint driven by a balance
 * change cannot reset what the player was looking at mid-scroll. */
const view = {
  search: '',
  sort: 'price-asc',
  riskLow: 0,
  riskHigh: RISK_ORDER.length - 1,
  pricePercentLow: 0,
  pricePercentHigh: 100,
  quantity: 1,
  quickOpen: false,
};

let root = null;
let selected = null;
let opening = false;

export function mountCrates(node) {
  root = $('#crateRoot', node);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', () => {
      if (!root.isConnected || opening) return;
      // A crate that vanished from the catalogue must not stay selected on the bench.
      if (selected && !state.cases.some((crate) => crate.id === selected.id)) selected = null;
      paintAll();
    });
    if (!state.cases.length) refreshCases().catch(() => undefined);

    /* Decode the reveal art while the player is still choosing, not inside their first open. */
    const warm = () => {
      warmReel().catch(() => undefined);
      warmCutscene().catch(() => undefined);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1200);
  }
  paintAll();
}

/* ─────────── shape ─────────── */
function build() {
  root.innerHTML = `
    <div class="bench">
      <!-- LEFT · the bench -->
      <aside class="bench__rail" aria-label="Selected crate">
        <div class="rail" id="railRoot"></div>
      </aside>

      <!-- RIGHT · the wall -->
      <div class="bench__wall">
        <div class="wallbar">
          <label class="wallbar__search">
            <span class="sronly">Search crates</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
            <input type="search" id="crateSearch" placeholder="Search for crates…" autocomplete="off" spellcheck="false">
          </label>
          <label class="wallbar__sort">
            <span class="sronly">Sort crates</span>
            <select id="crateSort">
              ${SORTS.map((sort) => `<option value="${sort.code}">${sort.label}</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="ranges">
          <div class="range">
            <span class="range__label">Risk</span>
            <span class="range__pill range__pill--lo mono" id="riskLowOut">Safe</span>
            <span class="range__pill range__pill--hi mono" id="riskHighOut">Jackpot</span>
            <div class="range__track">
              <i class="range__rail range__rail--risk"></i>
              <i class="range__fill" id="riskFill"></i>
              <input type="range" id="riskLow" min="0" max="${RISK_ORDER.length - 1}" step="1" value="0" aria-label="Lowest risk">
              <input type="range" id="riskHigh" min="0" max="${RISK_ORDER.length - 1}" step="1" value="${RISK_ORDER.length - 1}" aria-label="Highest risk">
            </div>
          </div>

          <div class="range">
            <span class="range__label">Price</span>
            <span class="range__pill range__pill--lo mono" id="priceLowOut">—</span>
            <span class="range__pill range__pill--hi mono" id="priceHighOut">—</span>
            <div class="range__track">
              <i class="range__rail range__rail--price"></i>
              <i class="range__fill" id="priceFill"></i>
              <input type="range" id="priceLow" min="0" max="100" step="1" value="0" aria-label="Lowest price">
              <input type="range" id="priceHigh" min="0" max="100" step="1" value="100" aria-label="Highest price">
            </div>
          </div>
        </div>

        <p class="wallcount mono" id="crateCount">—</p>
        <div class="cratewall" id="crateWall"></div>
      </div>
    </div>

    <!-- FOOT · the drop table of whatever is selected -->
    <section class="drawer" id="crateDrawer" aria-label="Drop table" hidden></section>`;

  $('#crateSearch', root).addEventListener('input', (event) => {
    view.search = event.target.value.trim().toLowerCase();
    paintWall();
  });
  $('#crateSort', root).addEventListener('change', (event) => {
    view.sort = event.target.value;
    paintWall();
  });

  wireDualRange('risk', (low, high) => {
    view.riskLow = low;
    view.riskHigh = high;
    paintWall();
  });
  wireDualRange('price', (low, high) => {
    view.pricePercentLow = low;
    view.pricePercentHigh = high;
    paintWall();
  });
}

/**
 * Two sliders stacked on one track.
 *
 * A native range input cannot express a span, so the pair is overlaid and each is clamped against
 * the other. Dragging the low thumb past the high one would otherwise invert the range and the
 * filter would silently match nothing — so the crossed thumb PUSHES the other rather than
 * refusing to move, because refusing feels broken under the hand.
 */
function wireDualRange(name, onChange) {
  const low = $(`#${name}Low`, root);
  const high = $(`#${name}High`, root);
  const fill = $(`#${name}Fill`, root);

  const apply = (event) => {
    let lowValue = Number(low.value);
    let highValue = Number(high.value);
    if (lowValue > highValue) {
      if (event?.target === low) highValue = lowValue;
      else lowValue = highValue;
      low.value = String(lowValue);
      high.value = String(highValue);
    }
    const span = Number(low.max) - Number(low.min) || 1;
    const from = ((lowValue - Number(low.min)) / span) * 100;
    const to = ((highValue - Number(low.min)) / span) * 100;
    fill.style.left = `${from}%`;
    fill.style.width = `${Math.max(0, to - from)}%`;
    onChange(lowValue, highValue);
  };

  low.addEventListener('input', apply);
  high.addEventListener('input', apply);
  apply();
}

function priceBounds() {
  const prices = state.cases.map((crate) => crate.price).filter((price) => price > 0);
  if (!prices.length) return { min: 0, max: 0 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/* The price slider is logarithmic.
 *
 * Crate prices span 5,000 to 150,000,000 — nearly five orders of magnitude. On a linear track
 * every crate under ten million would be crushed into the first three pixels, leaving 90% of the
 * slider to separate the four most expensive ones. */
function priceAtPercent(bounds, percent) {
  if (!bounds.max) return percent <= 0 ? 0 : Infinity;
  if (percent <= 0) return bounds.min;
  if (percent >= 100) return bounds.max;
  const lowLog = Math.log10(Math.max(1, bounds.min));
  const highLog = Math.log10(Math.max(1, bounds.max));
  return Math.round(10 ** (lowLog + ((highLog - lowLog) * percent) / 100));
}

/* ─────────── data ─────────── */
function riskOf(crate) {
  const risk = crate.metadata?.risk;
  return RISK_ORDER.includes(risk) ? risk : 'balanced';
}

/* The volatility figure the server solved from the crate's own distribution. Falls back to the
 * profile's position on the ladder only when a crate predates the measured field. */
function riskPercentOf(crate) {
  const stated = Number(crate.metadata?.riskPercent ?? 0);
  if (stated > 0) return Math.round(stated);
  return [15, 35, 55, 75, 92][RISK_ORDER.indexOf(riskOf(crate))] ?? 50;
}

function riskWordOf(crate) {
  const stated = crate.metadata?.riskLabel;
  if (typeof stated === 'string' && stated) return stated;
  const percent = riskPercentOf(crate);
  if (percent < 25) return 'Low';
  if (percent < 45) return 'Medium';
  if (percent < 65) return 'High';
  if (percent < 82) return 'Very High';
  return 'Extreme';
}

/* The best ORDINARY outcome, as a multiple of the price.
 *
 * The mystery payload is deliberately excluded. Every crate hides the same god-tier item behind
 * the same one-in-a-million slot, so including it would print "78000x top" on a 5,000 crate and
 * on nothing else — a number that is true, useless for comparing crates, and reads as a promise. */
function topMultiple(crate) {
  const best = ordinaryDrops(crate).reduce((most, drop) => Math.max(most, drop.value), 0);
  if (best > 0 && crate.price > 0) return best / crate.price;
  const stated = Number(crate.metadata?.topMultiple || 0);
  return stated > 0 ? stated : 0;
}

function visibleCrates() {
  const bounds = priceBounds();
  const low = priceAtPercent(bounds, view.pricePercentLow);
  const high = priceAtPercent(bounds, view.pricePercentHigh);

  const list = state.cases.filter((crate) => {
    const index = RISK_ORDER.indexOf(riskOf(crate));
    if (index < view.riskLow || index > view.riskHigh) return false;
    if (crate.price < low || crate.price > high) return false;
    if (view.search && !crate.name.toLowerCase().includes(view.search)) return false;
    return true;
  });

  const byRisk = (crate) => RISK_ORDER.indexOf(riskOf(crate));
  switch (view.sort) {
    case 'price-desc': return list.sort((a, b) => b.price - a.price);
    case 'top-desc': return list.sort((a, b) => topMultiple(b) - topMultiple(a));
    case 'risk-asc': return list.sort((a, b) => byRisk(a) - byRisk(b) || a.price - b.price);
    case 'risk-desc': return list.sort((a, b) => byRisk(b) - byRisk(a) || a.price - b.price);
    default: return list.sort((a, b) => a.price - b.price);
  }
}

/* ─────────── painting ─────────── */
function paintAll() {
  paintWall();
  paintRail();
  paintDrawer();
}

function paintRangeLabels() {
  const bounds = priceBounds();
  $('#riskLowOut', root).textContent = RISK_LABEL[RISK_ORDER[view.riskLow]] ?? '—';
  $('#riskHighOut', root).textContent = RISK_LABEL[RISK_ORDER[view.riskHigh]] ?? '—';
  $('#priceLowOut', root).textContent = bounds.max
    ? money(priceAtPercent(bounds, view.pricePercentLow))
    : '—';
  $('#priceHighOut', root).textContent = bounds.max
    ? money(priceAtPercent(bounds, view.pricePercentHigh))
    : '—';
}

function paintWall() {
  if (!root?.isConnected) return;
  paintRangeLabels();

  const wall = $('#crateWall', root);
  const crates = visibleCrates();
  $('#crateCount', root).textContent = `${crates.length} of ${state.cases.length} crates`;

  wall.innerHTML = '';
  if (!crates.length) {
    const empty = el('p', 'empty', 'Nothing matches those filters. Widen the risk or price range.');
    wall.appendChild(empty);
    return;
  }

  for (const crate of crates) {
    const risk = riskOf(crate);
    const top = topMultiple(crate);
    const chosen = selected?.id === crate.id;

    const card = el('button', 'cratecard');
    card.type = 'button';
    card.style.setProperty('--risk', riskColorFor(riskPercentOf(crate)));
    card.dataset.on = chosen ? '1' : '0';
    card.setAttribute('aria-pressed', String(chosen));

    /* The badge is the figure alone.
     *
     * It read "70% Very High" — two encodings of one fact, the longer of which forced the pill
     * wide enough to crowd the art on a 164px card and wrapped outright on a phone. The colour
     * already carries the band (gold through amber to ember), so the word was the third copy.
     * The full wording stays on the tooltip for anyone who wants it spelled out. */
    const percent = riskPercentOf(crate);
    const badge = el('span', 'cratecard__risk');
    badge.textContent = `${percent}%`;
    badge.title = `Volatility ${percent}% · ${riskWordOf(crate)} · ${RISK_LABEL[risk]} profile`;

    const art = document.createElement('img');
    art.className = 'cratecard__art';
    art.src = safeImage(crate.art);
    art.alt = '';
    art.loading = 'lazy';

    const name = el('span', 'cratecard__name');
    name.textContent = crate.name;

    const price = el('span', 'cratecard__price mono');
    price.append(coin(), document.createTextNode(compact(crate.price)));

    const foot = el('span', 'cratecard__top mono');
    foot.textContent = `${top >= 10 ? top.toFixed(0) : top.toFixed(1)}× top`;

    card.append(badge, art, name, price, foot);
    card.addEventListener('click', () => {
      selected = crate;
      paintAll();
      playSound('click');
    });
    wall.appendChild(card);
  }
}

function paintRail() {
  const rail = $('#railRoot', root);
  if (!rail) return;

  if (!selected) {
    rail.innerHTML = `
      <div class="rail__empty">
        <span class="rail__label">Selected crate</span>
        <p>&mdash;</p>
      </div>`;
    return;
  }

  const risk = riskOf(selected);
  const total = selected.price * view.quantity;
  const affordable = state.authenticated && state.balance >= total;

  rail.innerHTML = `
    <div class="rail__sec">
      <span class="rail__label">Selected crate</span>
      <div class="rail__pick">
        <img alt="">
        <span class="rail__pickmeta">
          <b class="rail__name"></b>
          <span class="rail__price mono"></span>
        </span>
      </div>
    </div>

    <div class="rail__sec">
      <span class="rail__label">Quantity</span>
      <div class="qty" role="group" aria-label="How many to open">
        ${QUANTITIES.map((n) => `
          <button class="qty__b" type="button" data-n="${n}"
                  aria-pressed="${n === view.quantity}">${n}</button>`).join('')}
      </div>
    </div>

    <button class="quick" id="railQuick" type="button" role="switch"
            aria-checked="${view.quickOpen}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4.5 13H11l-1 9 8.5-11H12z"/></svg>
      <span>Quick unbox</span>
      <i class="quick__sw" aria-hidden="true"></i>
    </button>

    <div class="rail__cost">
      <span class="rail__label">Total cost</span>
      <b class="rail__total mono"></b>
    </div>

    <button class="btn btn--go rail__go" id="railOpen" ${affordable ? '' : 'disabled'}></button>
    <p class="rail__note" id="railNote"></p>`;

  rail.querySelector('.rail__pick').style.setProperty('--risk', riskColorFor(riskPercentOf(selected)));
  rail.querySelector('.rail__pick img').src = safeImage(selected.art);
  // Server-supplied strings go in as text, never as markup.
  $('.rail__name', rail).textContent = selected.name;
  $('.rail__price', rail).append(coin(), document.createTextNode(compact(selected.price)));
  $('.rail__total', rail).append(coin(), document.createTextNode(compact(total)));

  $('#railOpen', rail).textContent = !state.authenticated
    ? 'Log in to open'
    : affordable
      ? view.quantity > 1 ? `Open ${view.quantity} crates` : 'Open crate'
      : 'Insufficient balance';

  /* The wallet figure, or nothing. A logged-out player is told to log in by the button directly
   * above this line; restating the platform's integrity policy underneath it was a sentence
   * nobody read in the one place it could not act on. */
  $('#railNote', rail).textContent = state.authenticated ? money(state.balance) : '';

  rail.querySelectorAll('.qty__b').forEach((button) => {
    button.addEventListener('click', () => {
      view.quantity = Number(button.dataset.n);
      paintRail();
      playSound('click');
    });
  });

  $('#railQuick', rail).addEventListener('click', () => {
    view.quickOpen = !view.quickOpen;
    paintRail();
  });

  if (affordable) $('#railOpen', rail).addEventListener('click', openSelected);
}

function paintDrawer() {
  const drawer = $('#crateDrawer', root);
  if (!drawer) return;

  if (!selected) {
    drawer.hidden = true;
    drawer.innerHTML = '';
    return;
  }
  drawer.hidden = false;

  const totalWeight = selected.drops.reduce((sum, drop) => sum + drop.weight, 0) || 1;
  /* The mystery slot is pulled out and drawn first as a single golden `?`. It stays in the
   * expected-value arithmetic below, because it is a real outcome with a real weight and leaving
   * it out would understate what the crate returns. */
  const hidden = mysteryDrops(selected);
  const sorted = ordinaryDrops(selected).sort((a, b) => b.value - a.value);
  const expected = selected.drops
    .reduce((sum, drop) => sum + (drop.weight / totalWeight) * drop.value, 0);
  const edge = (1 - expected / selected.price) * 100;
  const odds = mysteryOdds(selected);

  drawer.innerHTML = `
    <header class="drawer__head">
      <span class="drawer__title mono"></span>
      <span class="drawer__facts mono">
        <span>avg return <b></b></span>
        <span>house edge <b></b></span>
        <span>mystery <b></b></span>
        <span class="drawer__count"></span>
      </span>
    </header>
    <div class="drawer__rows" id="drawerRows"></div>`;

  $('.drawer__title', drawer).textContent = `${selected.name} · items`;
  const facts = drawer.querySelectorAll('.drawer__facts b');
  facts[0].textContent = money(Math.round(expected));
  facts[1].textContent = `${edge.toFixed(2)}%`;
  /* The slot's own frequency, next to the edge, because it is no longer the same on every crate:
   * it scales with price, so two crates side by side genuinely differ here and a player
   * comparing them has to be able to see it. */
  facts[2].textContent = odds ? `1 in ${grouped(odds)}` : '—';
  $('.drawer__count', drawer).textContent = hidden.length
    ? `${sorted.length} items + 1 mystery (${hidden.length} payloads)`
    : `${sorted.length} items`;

  const rows = $('#drawerRows', drawer);

  /* Vertical wheel scrolls the strip sideways.
   *
   * A horizontal overflow container only responds to shift+wheel or a trackpad swipe, so on a
   * mouse the row reads as a dead end: tiles are visibly cut off at the edge and nothing the
   * pointer does moves them. Mapping deltaY onto scrollLeft is what makes it feel scrollable
   * rather than merely be scrollable.
   *
   * passive: false because this calls preventDefault — without the explicit flag the browser
   * assumes passive on a wheel listener and ignores the call, so the page would scroll behind the
   * strip at the same time. */
  rows.addEventListener('wheel', (event) => {
    // A real horizontal gesture (trackpad, tilt wheel) is left alone; the browser handles it.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const scrollable = rows.scrollWidth > rows.clientWidth + 1;
    if (!scrollable) return;
    event.preventDefault();
    rows.scrollLeft += event.deltaY;
  }, { passive: false });

  // Reachable by keyboard, and announced, rather than being a mouse-only region.
  rows.tabIndex = 0;
  rows.setAttribute('role', 'group');
  rows.setAttribute('aria-label', 'Drop table — scroll sideways for the full list');

  /* The fades at each end are the affordance that says "there is more this way". They are toggled
   * from the real scroll position, so a strip that fits shows neither and a strip scrolled to the
   * end stops advertising a direction it cannot go. */
  const paintEdges = () => {
    const max = rows.scrollWidth - rows.clientWidth;
    rows.dataset.more = max > 1 ? '1' : '0';
    rows.dataset.atStart = rows.scrollLeft <= 1 ? '1' : '0';
    rows.dataset.atEnd = rows.scrollLeft >= max - 1 ? '1' : '0';
  };
  rows.addEventListener('scroll', paintEdges, { passive: true });
  requestAnimationFrame(paintEdges);

  /* ONE `?` tile for the whole mystery slot.
   *
   * The sub-pool holds seven payloads, and this drew a tile for each of them — seven identical
   * question marks in a row, all reading "$100M+ / 1 in 9.34K", which is wrong twice over. It is
   * visually absurd, and the number was a lie: each tile printed the odds of the SLOT while
   * appearing to describe one payload, so the strip claimed seven independent one-in-nine-thousand
   * chances where there is exactly one.
   *
   * The slot is one outcome from the player's side. What is behind it is a detail of that one
   * outcome, and it belongs in the tooltip and the reveal — not as seven tiles pretending to be
   * seven drops. Naming the payloads on the strip would defeat the slot anyway; hiding the ODDS
   * would make it a lottery with unpublished chances, which is the part that has to be verifiable.
   */
  if (hidden.length) {
    const hiddenWeight = hidden.reduce((sum, drop) => sum + drop.weight, 0);
    const tile = el('div', 'droptile droptile--myst');
    /* The tooltip carries the whole sub-pool: what can come out, how likely each payload is
     * given the slot landed, and the true chance of each one from a single open. The `?` is the
     * only outcome on this page whose contents are not drawn on screen, so it is the one that
     * most needs its odds written out rather than implied. */
    const floor = mysteryFloor(selected);
    const worst = mysteryWorstMultiple(selected);
    tile.title = [
      `Mystery slot — 1 in ${grouped(odds)} per open`,
      `every payload is at least ${money(floor)} — ${worst.toFixed(1)}x this crate's price`,
      '',
      ...mysteryPayloads(selected).map((payload) => {
        const share = payload.shareOfPool * 100;
        return `${payload.name}  ${money(payload.value)}  `
          + `${share < 0.01 ? '<0.01' : share.toFixed(2)}% of hits  `
          + `1 in ${grouped(Math.round(1 / payload.chancePerOpen))} per open`;
      }),
    ].join('\n');

    const glyph = el('span', 'droptile__q');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '?';

    /* The crate's OWN floor. A flat "$100M+" understated the high tiers by nearly four times. */
    const value = el('span', 'droptile__val mono');
    value.textContent = `${money(floor)}+`;

    const chance = el('span', 'droptile__odds mono');
    /* Compact, because the tile is 84px wide and "1 in 1,000,000" clips to "1 in 1,000,0" — which
     * reads as a different, much better number than the real one. The full figure stays on the
     * tile title and in the reveal. */
    chance.textContent = odds ? `1 in ${shortOdds(odds)}` : '1 in 1M';

    /* The guaranteed multiple, but only while it is a figure anyone would compare. On a 5,000
     * crate the floor is twenty thousand times the price, and "20000.0x min" is noise — the
     * number only earns its place on the tile once the crate is expensive enough that a player
     * might reasonably wonder whether the slot is still worth hitting. */
    const label = el('span', 'droptile__name');
    label.textContent = worst > 0 && worst < 1000
      ? `Mystery · ${worst >= 100 ? Math.round(worst) : worst.toFixed(1)}x min`
      : 'Mystery slot';

    tile.append(glyph, value, chance, label);
    rows.appendChild(tile);
    // The combined weight of every payload behind the slot. Real and published; only the
    // identities are withheld.
    tile.dataset.weight = String(hiddenWeight);
    tile.dataset.payloads = String(hidden.length);
  }
  for (const drop of sorted) {
    const chance = drop.weight / totalWeight;
    const tile = el('div', 'droptile');
    tile.style.setProperty('--rar', chanceColor(chance));

    const art = document.createElement('img');
    art.src = safeImage(drop.img);
    art.alt = '';
    art.loading = 'lazy';

    const value = el('span', 'droptile__val mono');
    value.append(coin(), document.createTextNode(compact(drop.value)));

    const odds = el('span', 'droptile__odds mono');
    odds.textContent = chance < 0.0001 ? '<0.01%' : pct(chance, chance < 0.01 ? 2 : 1);

    const name = el('span', 'droptile__name');
    name.textContent = drop.name;

    tile.append(art, value, odds, name);
    rows.appendChild(tile);
  }
}

/* Rarer is hotter. Derived from the real chance rather than a stored rarity label, so the colour
 * can never disagree with the number printed beneath it. */
function chanceColor(chance) {
  if (chance < 0.005) return '#ff2222';
  if (chance < 0.03) return '#ff6a00';
  if (chance < 0.12) return '#ffaa00';
  if (chance < 0.35) return '#ffd700';
  return '#ffd700';
}

/* ─────────── opening ─────────── */
async function openSelected() {
  if (opening || !selected) return;
  const crate = selected;
  const runs = view.quantity;
  const total = crate.price * runs;

  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Link your account to open crates.' });
    return;
  }
  if (state.balance < total) {
    toast({
      kind: 'lose',
      title: 'Not enough balance',
      body: `${runs}× ${crate.name} costs ${money(total)}.`,
    });
    return;
  }

  opening = true;
  const button = $('#railOpen', root);
  if (button) button.disabled = true;
  playSound('click');

  let paidOut = 0;
  let winners = 0;
  try {
    /* Each crate is its own request, its own idempotency key and its own provably-fair round.
     * Batching five into one server call would mean one seed covering five outcomes, which cannot
     * be verified independently — and independent verification is the entire point of the
     * fairness hub. */
    for (let run = 0; run < runs; run += 1) {
      const result = await requestCaseOpen(crate);
      const payout = Number(result.round?.payoutMinor ?? 0);
      paidOut += payout;
      if (payout >= crate.price) winners += 1;

      const item = { ...result.item, name: result.item.displayName ?? result.item.name };
      const pool = crate.drops.length ? crate.drops : [item];
      const landedMystery = isMystery(result.item);
      const jackpot = isJackpot(item, crate);

      /* Which film plays.
       *
       * These are the presets from the dev animation bench, picked by what actually landed:
       *
       *   mystery  → preset 2, "Gold tier tease → keynote": the reel runs with the winning tile
       *              replaced by the gold slot (the item is never drawn onto that canvas), then
       *              the keynote cinematic names it.
       *   jackpot  → the same pairing, but the reel shows the real sprite, because a big multiple
       *              is not a secret — only the `?` is.
       *   anything → preset 1, the plain CS:GO ticker scroll.
       *   else
       *
       * Quick unbox skips the reel. The round settled either way — this only decides whether it
       * is dramatised, and on a five-crate run nobody wants thirty seconds of ceremony.
       *
       * A landed mystery is the one thing quick unbox does NOT skip entirely. It fires once in a
       * million openings; someone who turned the reel off to grind five at a time still wants to
       * be told when the `?` came up, so they get the keynote without the tease in front of it.
       */
      try {
        if (landedMystery) {
          await withTimeout(
            playMystery({ item, crate, pool, skipReel: view.quickOpen }),
            view.quickOpen ? 180_000 : 240_000,
          );
        } else if (!view.quickOpen) {
          await withTimeout(playReel({ item, crate, pool, mystery: false }), 180_000);
          if (jackpot) await withTimeout(playCutscene({ item, crate, pool }), 180_000);
        }
      } catch (animationError) {
        // A failed reveal must never swallow a settled round; the result still has to land.
        console.error('[crates] reveal failed', animationError);
      }

      if (runs === 1) {
        playSound(jackpot ? 'jackpot' : payout >= crate.price ? 'win' : 'lose');
        toast({
          kind: payout >= crate.price ? 'win' : 'lose',
          img: item.img,
          title: item.name,
          body: payout ? `+${money(payout)} cash` : 'Opened',
        });
      }
    }

    if (runs > 1) {
      const net = paidOut - total;
      playSound(net > 0 ? 'win' : 'lose');
      toast({
        kind: net > 0 ? 'win' : 'lose',
        title: `${runs} crates · ${winners} paid over cost`,
        body: `${money(paidOut)} back on ${money(total)} — ${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`,
      });
    }
  } catch (error) {
    toast({
      kind: 'lose',
      title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not open',
      body: error?.message || 'The server rejected the request.',
    });
  } finally {
    opening = false;
    paintRail();
  }
}

/* A ceiling on the reveal, so an animation that never settles cannot leave the bench disabled for
 * the rest of the session while the round is already paid.
 *
 * The ceiling is deliberately generous. These reveals resolve when the PLAYER presses Collect,
 * not on a timer, so a short timeout would fire during a perfectly healthy reveal that someone is
 * simply still looking at. What the timeout catches is a genuinely stuck animation, and when it
 * fires it also dismisses whatever is on screen — otherwise the race resolves, the page
 * re-enables, and a full-screen canvas stays up with its own render loop still running. */
function withTimeout(promise, milliseconds) {
  let timer = 0;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => {
      dismissReveals();
      resolve();
    }, milliseconds);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

/* ─────────── bits ─────────── */
function coin() {
  const mark = el('i', 'coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/* 1M / 250K / 1.5B — odds denominators, shortened to fit a drop tile. */
function shortOdds(value) {
  const n = Math.round(Number(value) || 0);
  if (n >= 1e9) return trim(n / 1e9) + 'B';
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'K';
  return String(n);
}

function compact(value) {
  const n = Math.abs(Math.round(Number(value) || 0));
  if (n >= 1e12) return trim(n / 1e12) + 't';
  if (n >= 1e9) return trim(n / 1e9) + 'b';
  if (n >= 1e6) return trim(n / 1e6) + 'm';
  if (n >= 1e3) return trim(n / 1e3) + 'k';
  return String(n);
}

function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x.toFixed(2);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
