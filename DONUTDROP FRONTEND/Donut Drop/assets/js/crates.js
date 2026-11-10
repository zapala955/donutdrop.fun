/* crates.js — the Cases page.
 *
 * Laid out as every game is (2026-11-10, "rewrite cases like u did with mines"):
 *
 *   PANEL  left: which case, how many, quick unbox, and the one gold button that spends money.
 *   STAGE  right, on the dark: the case itself -- its art, name, price, what it returns on
 *          average, its edge, its best prize -- and every item in it with its odds. The odds are on
 *          screen beside the button that charges you, never behind a click.
 *   BAR    under both: the page's name and "How it works" (index.html, as every game has).
 *   BROWSE under the bar: every case, with search, sort and the risk and price filters. Picking
 *          one puts it on the stage.
 *
 * The opening itself -- the reel, the cutscene, the mystery keynote, the settlement deferred to the
 * reel -- is the same code as before, untouched: openSelected() below and reel.js, cutscene.js,
 * mystery.js. Only the page around it changed.
 */
import { state, bus, openCase as requestCaseOpen, refreshCases } from './store.js';
import { $, el, money, pct, safeImage, grouped, reduceMotion } from './util.js';
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

let root = null; // the frame: panel and stage
let browse = null; // every case, under the bar
let selected = null;
let opening = false;

export function mountCrates(node) {
  root = $('#crateRoot', node);
  browse = $('#crateBrowse', node);
  if (!root || !browse) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', () => {
      if (!root.isConnected || opening) return;
      // A crate that vanished from the catalogue must not stay on the stage.
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
    <section class="cases__stage" aria-label="The case">
      <div class="cases__show" id="casesShow">
        <div class="cases__slot"><img class="cases__art" id="casesArt" alt="" width="128" height="128"></div>
        <div class="cases__meta">
          <span class="cases__risk mono" id="casesRisk"></span>
          <h2 class="cases__name" id="casesName">Loading cases…</h2>
          <span class="cases__price mono" id="casesPrice"></span>
          <dl class="cases__facts">
            <div><dt>Avg return</dt><dd class="mono" id="casesAvg">—</dd></div>
            <div><dt>House edge</dt><dd class="mono" id="casesEdge">—</dd></div>
            <div><dt>Top prize</dt><dd class="mono" id="casesTop">—</dd></div>
            <div><dt>Mystery</dt><dd class="mono" id="casesMyst">—</dd></div>
          </dl>
        </div>
      </div>
      <div class="cases__items">
        <div class="cases__itemshead">
          <h3>In this case</h3>
          <span class="cases__count mono" id="casesCount"></span>
        </div>
        <div class="cases__grid" id="casesItems" role="list" aria-label="Every item in this case, with its odds"></div>
      </div>
    </section>

    <aside class="cases__panel" aria-label="Open the case">
      <div class="cases__form">
        <span class="cases__label">Case</span>
        <div class="cases__pick">
          <img id="casesPickArt" alt="" width="32" height="32">
          <span class="cases__pickname" id="casesPickName">—</span>
          <button type="button" class="cases__change" id="casesChange">Change</button>
        </div>

        <span class="cases__label" id="casesQtyLabel">Quantity</span>
        <div class="cases__qty" role="group" aria-labelledby="casesQtyLabel">
          ${QUANTITIES.map((n) => `<button type="button" class="cases__n" data-n="${n}" aria-pressed="${n === view.quantity}">${n}</button>`).join('')}
        </div>

        <button class="cases__quick" id="casesQuick" type="button" role="switch" aria-checked="${view.quickOpen}">
          <span>Quick unbox</span>
          <i aria-hidden="true"></i>
        </button>

        <button class="btn btn--go cases__go" id="casesGo" type="button">Open case</button>
        <p class="cases__hint mono" id="casesHint" aria-live="polite"></p>
      </div>
    </aside>`;

  browse.innerHTML = `
    <div class="lxrow__head">
      <h2 class="lxrow__h" id="crateBrowseH">All cases</h2>
      <span class="wallcount mono" id="crateCount">—</span>
    </div>
    <div class="wallbar">
      <label class="wallbar__search">
        <span class="sronly">Search cases</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
        <input type="search" id="crateSearch" placeholder="Search for cases…" autocomplete="off" spellcheck="false">
      </label>
      <label class="wallbar__sort">
        <span class="sronly">Sort cases</span>
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

    <div class="cratewall" id="crateWall"></div>`;

  $('#crateSearch', browse).addEventListener('input', (event) => {
    view.search = event.target.value.trim().toLowerCase();
    paintWall();
  });
  $('#crateSort', browse).addEventListener('change', (event) => {
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

  for (const button of root.querySelectorAll('.cases__n')) {
    button.addEventListener('click', () => {
      view.quantity = Number(button.dataset.n);
      paintPanel();
    });
  }
  $('#casesQuick', root).addEventListener('click', () => {
    view.quickOpen = !view.quickOpen;
    paintPanel();
  });
  $('#casesChange', root).addEventListener('click', () => {
    browse.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    $('#crateSearch', browse).focus({ preventScroll: true });
  });
  $('#casesGo', root).addEventListener('click', () => {
    if (!state.authenticated) {
      $('#loginBtn')?.click();
      return;
    }
    void openSelected();
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
  const low = $(`#${name}Low`, browse);
  const high = $(`#${name}High`, browse);
  const fill = $(`#${name}Fill`, browse);

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
  /* The stage is never empty while there are cases: the cheapest one stands on it until the player
   * picks another. Showing a case is not spending on it; only the gold button does that. */
  if (!selected && state.cases.length) {
    selected = [...state.cases].sort((a, b) => a.price - b.price)[0];
  }
  paintWall();
  paintStage();
  paintPanel();
}

function paintRangeLabels() {
  const bounds = priceBounds();
  $('#riskLowOut', browse).textContent = RISK_LABEL[RISK_ORDER[view.riskLow]] ?? '—';
  $('#riskHighOut', browse).textContent = RISK_LABEL[RISK_ORDER[view.riskHigh]] ?? '—';
  $('#priceLowOut', browse).textContent = bounds.max
    ? money(priceAtPercent(bounds, view.pricePercentLow))
    : '—';
  $('#priceHighOut', browse).textContent = bounds.max
    ? money(priceAtPercent(bounds, view.pricePercentHigh))
    : '—';
}

function paintWall() {
  if (!browse?.isConnected) return;
  paintRangeLabels();

  const wall = $('#crateWall', browse);
  const crates = visibleCrates();
  $('#crateCount', browse).textContent = `${crates.length} of ${state.cases.length}`;

  wall.innerHTML = '';
  if (!crates.length) {
    // Before the catalogue arrives there is nothing to filter yet; say so rather than blame the filters.
    const empty = el('p', 'empty', state.cases.length
      ? 'Nothing matches those filters. Widen the risk or price range.'
      : 'Loading cases…');
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

    /* The badge is the figure alone: the colour already carries the band, and the full wording
     * stays on the tooltip for anyone who wants it spelled out. */
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
      if (opening) return;
      selected = crate;
      paintAll();
      playSound('click');
      // Up to the stage, if it has scrolled away: the case just picked is shown there.
      if (root.getBoundingClientRect().top < 0) {
        root.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
      }
    });
    wall.appendChild(card);
  }
}

/** The case on the stage: art, name, price, its numbers, and every item in it. */
function paintStage() {
  if (!root?.isConnected) return;
  const show = $('#casesShow', root);
  const items = $('#casesItems', root);
  if (!selected) {
    show.dataset.empty = '1';
    $('#casesName', root).textContent = state.cases.length ? 'Pick a case' : 'Loading cases…';
    items.replaceChildren();
    return;
  }
  delete show.dataset.empty;

  const percent = riskPercentOf(selected);
  show.style.setProperty('--risk', riskColorFor(percent));
  $('#casesArt', root).src = safeImage(selected.art);
  // Server-supplied strings go in as text, never as markup.
  $('#casesName', root).textContent = selected.name;
  $('#casesRisk', root).textContent = `${percent}% · ${riskWordOf(selected)}`;
  $('#casesRisk', root).title = `Volatility ${percent}% · ${RISK_LABEL[riskOf(selected)]} profile`;
  $('#casesPrice', root).replaceChildren(coin(), document.createTextNode(money(selected.price)));

  const totalWeight = selected.drops.reduce((sum, drop) => sum + drop.weight, 0) || 1;
  /* The mystery slot is drawn first as a single golden `?`. It stays in the expected-value
   * arithmetic, because it is a real outcome with a real weight and leaving it out would
   * understate what the case returns. */
  const hidden = mysteryDrops(selected);
  const sorted = ordinaryDrops(selected).sort((a, b) => b.value - a.value);
  const expected = selected.drops
    .reduce((sum, drop) => sum + (drop.weight / totalWeight) * drop.value, 0);
  const edge = (1 - expected / selected.price) * 100;
  const odds = mysteryOdds(selected);
  const top = topMultiple(selected);

  $('#casesAvg', root).textContent = money(Math.round(expected));
  $('#casesEdge', root).textContent = `${edge.toFixed(2)}%`;
  $('#casesTop', root).textContent = sorted.length
    ? `${money(sorted[0].value)} · ${top >= 10 ? top.toFixed(0) : top.toFixed(1)}×`
    : '—';
  /* The slot's own frequency: it scales with price, so two cases side by side genuinely differ
   * here and a player comparing them has to be able to see it. */
  $('#casesMyst', root).textContent = odds ? `1 in ${grouped(odds)}` : '—';
  $('#casesCount', root).textContent = hidden.length
    ? `${sorted.length} items + 1 mystery`
    : `${sorted.length} items`;

  items.replaceChildren();

  /* ONE `?` tile for the whole mystery slot. The slot is one outcome from the player's side; what
   * is behind it belongs in the tooltip and the reveal, not as seven tiles pretending to be seven
   * drops. Its ODDS are always shown: a lottery with unpublished chances is the part that has to
   * stay verifiable. */
  if (hidden.length) {
    const tile = el('div', 'cases__item cases__item--myst');
    tile.setAttribute('role', 'listitem');
    const floor = mysteryFloor(selected);
    const worst = mysteryWorstMultiple(selected);
    tile.title = [
      `Mystery slot — 1 in ${grouped(odds)} per open`,
      `every payload is at least ${money(floor)} — ${worst.toFixed(1)}x this case's price`,
      '',
      ...mysteryPayloads(selected).map((payload) => {
        const share = payload.shareOfPool * 100;
        return `${payload.name}  ${money(payload.value)}  `
          + `${share < 0.01 ? '<0.01' : share.toFixed(2)}% of hits  `
          + `1 in ${grouped(Math.round(1 / payload.chancePerOpen))} per open`;
      }),
    ].join('\n');

    const glyph = el('span', 'cases__q');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '?';

    // The case's OWN floor: a flat "$100M+" understated the high tiers by nearly four times.
    const value = el('span', 'cases__ival mono');
    value.textContent = `${money(floor)}+`;

    const name = el('span', 'cases__iname');
    name.textContent = worst > 0 && worst < 1000
      ? `Mystery · ${worst >= 100 ? Math.round(worst) : worst.toFixed(1)}x min`
      : 'Mystery slot';

    const chance = el('span', 'cases__iodds mono');
    chance.textContent = odds ? `1 in ${shortOdds(odds)}` : '1 in 1M';

    tile.append(glyph, value, name, chance);
    tile.dataset.weight = String(hidden.reduce((sum, drop) => sum + drop.weight, 0));
    tile.dataset.payloads = String(hidden.length);
    items.appendChild(tile);
  }

  for (const drop of sorted) {
    const chance = drop.weight / totalWeight;
    const tile = el('div', 'cases__item');
    tile.setAttribute('role', 'listitem');
    tile.style.setProperty('--rar', chanceColor(chance));

    const art = document.createElement('img');
    art.src = safeImage(drop.img);
    art.alt = '';
    art.loading = 'lazy';
    art.width = 48;
    art.height = 48;

    const value = el('span', 'cases__ival mono');
    value.append(coin(), document.createTextNode(compact(drop.value)));

    const name = el('span', 'cases__iname');
    name.textContent = drop.name;

    const odds = el('span', 'cases__iodds mono');
    odds.textContent = chance < 0.0001 ? '<0.01%' : pct(chance, chance < 0.01 ? 2 : 1);

    tile.append(art, value, name, odds);
    items.appendChild(tile);
  }
}

/** The panel: the case in hand, how many, quick unbox, and the button that spends. */
function paintPanel() {
  if (!root?.isConnected) return;
  const pickArt = $('#casesPickArt', root);
  if (selected) {
    pickArt.src = safeImage(selected.art);
    pickArt.hidden = false;
  } else {
    pickArt.hidden = true;
  }
  $('#casesPickName', root).textContent = selected ? selected.name : 'No case picked';

  for (const button of root.querySelectorAll('.cases__n')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.n) === view.quantity));
    button.disabled = opening;
  }
  const quick = $('#casesQuick', root);
  quick.setAttribute('aria-checked', String(view.quickOpen));
  quick.disabled = opening;

  const total = selected ? selected.price * view.quantity : 0;
  const affordable = state.authenticated && state.balance >= total;
  const go = $('#casesGo', root);
  const hint = $('#casesHint', root);
  const what = view.quantity > 1 ? `Open ${view.quantity} cases` : 'Open case';

  if (!selected) {
    go.textContent = 'Pick a case';
    go.disabled = true;
    hint.textContent = '';
  } else if (!state.authenticated) {
    go.textContent = 'Log in to open';
    go.disabled = false;
    hint.textContent = '';
  } else {
    go.textContent = opening ? 'Opening…' : `${what} · ${money(total)}`;
    go.disabled = opening || !affordable;
    /* The wallet figure, or why the button is off. */
    hint.textContent = affordable || opening
      ? `Balance ${money(state.balance)}`
      : `Not enough balance: ${money(total)} needed`;
  }
  go.setAttribute('aria-busy', String(opening));
  $('#casesChange', root).disabled = opening;
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
  paintPanel();
  playSound('click');

  let paidOut = 0;
  let winners = 0;
  try {
    /* Each crate is its own request, its own idempotency key and its own provably-fair round.
     * Batching five into one server call would mean one seed covering five outcomes, which cannot
     * be verified independently — and independent verification is the entire point of the
     * fairness hub. */
    for (let run = 0; run < runs; run += 1) {
      /* Deferred: the wallet pill and the live feed learn the result when the reel lands, not
       * when the server answers. See openCase in store.js. */
      const result = await requestCaseOpen(crate, { defer: true });
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
      } finally {
        /* The reel has stopped (or was skipped, or failed): now the pill and the feed may move. */
        await result.settle();
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
    paintPanel();
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
