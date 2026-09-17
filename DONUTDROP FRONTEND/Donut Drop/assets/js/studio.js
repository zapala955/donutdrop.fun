/* studio.js — the Community Crate builder and the marketplace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRICE IS SHOWN HERE AND DECIDED ELSEWHERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every figure in the builder — expected value, price, house edge, the creator's cut — comes back
 * from `POST /v1/community/preview`, which runs the SAME function the create endpoint runs. The
 * browser does not compute the price and does not send one.
 *
 * That is deliberate and it is the security model of the whole feature. If the client priced the
 * crate, the exploit writes itself: publish something stuffed with netherite, declare it costs a
 * thousand, open it until the platform is empty. Deriving the price server-side removes the
 * attack instead of validating against it, and routing the preview through the same code means
 * the number a creator watches while dragging a slider is the number they will actually be given.
 *
 * The consequence a creator sees is that the price field is not editable. It moves when the
 * contents move, and that is the only thing that moves it.
 *
 * Every name, blurb and creator handle rendered here is another player's typing and goes in with
 * textContent.
 */
import { api } from './api.js';
import {
  state, bus, refreshBalance, refreshCases, normalizeItem, openCase as requestCaseOpen,
} from './store.js';
import { $, el, money, safeImage, grouped, pct } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { playReel } from './reel.js';
import { isMystery, playMystery } from './mystery.js';

/** The decals a creator may choose. Kept to art that actually ships. */
const DECALS = [
  ['items/ender_chest.png', 'Ender Chest'],
  ['items/dragon_egg.png', 'Dragon Egg'],
  ['items/totem.png', 'Totem'],
  ['items/ancient_debris.png', 'Ancient Debris'],
  ['items/beacon.png', 'Beacon'],
  ['items/nether_star.png', 'Nether Star'],
  ['items/spawner.png', 'Spawner'],
  ['items/trident.png', 'Trident'],
  ['block/gilded_blackstone.png', 'Gilded Blackstone'],
  ['block/crying_obsidian.png', 'Crying Obsidian'],
  ['block/magma.png', 'Magma'],
  ['block/end_stone.png', 'End Stone'],
];

const SORT_LABELS = {
  opened: 'Most opened',
  volume: 'Highest volume',
  newest: 'Newest',
  yield: 'Top creator yield',
};

const view = {
  tab: 'market',
  sort: 'opened',
  search: '',
  crates: [],
  /* The crate currently selected in the marketplace, with its full drop table. Held here rather
   * than in the DOM so a repaint driven by a balance change cannot clear the selection mid-open. */
  selected: null,
  opening: false,
  mine: null,
  palette: [],
  limits: null,
  draft: {
    name: '',
    description: '',
    decal: DECALS[0][0],
    royaltyBps: 150,
    drops: [],
  },
  preview: null,
};

let root = null;
let previewTimer = 0;

export function mountStudio(node) {
  root = $('#studioRoot', node);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) paint();
    });
    loadPalette();
  }
  loadMarket();
  paint();
}

/* ─────────────────────────── data ─────────────────────────── */

async function loadPalette() {
  try {
    const result = await api.get('/v1/community/palette');
    /* Normalised through the store, which owns the minecraft_name -> sprite table. Resolving the
     * art here instead produced 404s for exactly the items whose file is named differently from
     * their id — experience_bottle is xp_bottle.png, totem_of_undying is totem.png — which is the
     * same class of bug the sprite test was written to stop. One mapping, one place. */
    view.palette = (result.items ?? []).map((item) => {
      const normalised = normalizeItem({
        id: item.id,
        minecraft_name: item.minecraftName,
        display_name: item.displayName,
        image_url: item.imageUrl,
        unit_value_minor: item.unitValueMinor,
        metadata: item.metadata,
      });
      return { ...item, art: normalised.img };
    });
    view.limits = result.limits ?? null;
    if (view.limits) view.draft.royaltyBps = view.limits.defaultRoyaltyBps;
    paint();
  } catch { /* the builder shows an empty palette rather than an error page */ }
}

async function loadMarket() {
  try {
    const query = new URLSearchParams({ sort: view.sort, limit: '36' });
    if (view.search) query.set('search', view.search);
    const result = await api.get(`/v1/community/cases?${query}`);
    view.crates = result.crates ?? [];
    if (!state.cases.length) refreshCases().catch(() => undefined);
    paint();
  } catch { /* leave the last grid on screen */ }
}

async function loadMine() {
  if (!state.authenticated) { view.mine = null; return; }
  try {
    view.mine = await api.get('/v1/community/mine');
    paint();
  } catch { view.mine = null; }
}

/** Debounced, because it fires on every slider frame. */
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = window.setTimeout(runPreview, 140);
}

async function runPreview() {
  previewTimer = 0;
  if (view.draft.drops.length === 0) {
    view.preview = null;
    paintEconomics();
    return;
  }
  try {
    view.preview = await api.post('/v1/community/preview', {
      royaltyBps: view.draft.royaltyBps,
      drops: view.draft.drops.map((drop) => ({
        catalogItemId: drop.catalogItemId,
        weight: drop.weight,
      })),
    });
  } catch (error) {
    view.preview = { ok: false, reason: error?.message ?? 'Could not price this crate' };
  }
  paintEconomics();
}

/* ─────────────────────────── painting ─────────────────────────── */

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = `
    <div class="studio">
      <nav class="studio__tabs" id="studioTabs"></nav>
      <div class="studio__body" id="studioBody"></div>
    </div>`;

  const tabs = $('#studioTabs', root);
  for (const [code, label] of [['market', 'Marketplace'], ['build', 'Creator studio'], ['mine', 'My crates']]) {
    const tab = el('button', 'studio__tab');
    tab.type = 'button';
    tab.textContent = label;
    tab.setAttribute('aria-pressed', String(view.tab === code));
    tab.addEventListener('click', () => {
      view.tab = code;
      if (code === 'mine') loadMine();
      paint();
    });
    tabs.appendChild(tab);
  }

  if (view.tab === 'market') paintMarket();
  else if (view.tab === 'build') paintBuilder();
  else paintMine();
}

function paintMarket() {
  const body = $('#studioBody', root);
  body.innerHTML = `
    <div class="market__bar">
      <label class="market__search">
        <span class="sronly">Search community crates</span>
        <input type="search" id="mktSearch" placeholder="Search community crates…" autocomplete="off">
      </label>
      <label class="market__sort">
        <span class="sronly">Sort</span>
        <select id="mktSort"></select>
      </label>
    </div>
    <div class="market__split">
      <div class="market__grid" id="mktGrid"></div>
      <aside class="inspect" id="mktInspect"></aside>
    </div>`;

  const search = $('#mktSearch', body);
  search.value = view.search;
  search.addEventListener('input', (event) => {
    view.search = event.target.value.trim();
    loadMarket();
  });

  const sort = $('#mktSort', body);
  for (const [code, label] of Object.entries(SORT_LABELS)) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (view.sort === code) option.selected = true;
    sort.appendChild(option);
  }
  sort.addEventListener('change', (event) => {
    view.sort = event.target.value;
    loadMarket();
  });

  const grid = $('#mktGrid', body);
  if (!view.crates.length) {
    grid.appendChild(el('p', 'empty', 'No community crates yet. Build the first one in the studio.'));
    paintInspector();
    return;
  }
  for (const crate of view.crates) grid.appendChild(buildMarketCard(crate));
  paintInspector();
}

/* ─────────────────────────── the inspector ───────────────────────────
 *
 * Selecting a card loads its full drop table and opens it HERE. The card used to carry an "Open"
 * button that sent the player to the crates page with a toast telling them to search for the
 * crate by name — a dead end dressed as an action, and the one thing a marketplace has to do is
 * let you buy what is in it.
 */
async function selectCrate(slug) {
  try {
    const result = await api.get(`/v1/community/cases/${encodeURIComponent(slug)}`);
    view.selected = result.crate;
    paintMarket();
    // Bring the panel into view on a phone, where it stacks under the grid.
    if (window.innerWidth < 900) {
      $('#mktInspect', root)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (error) {
    toast({ kind: 'lose', title: 'Could not load that crate', body: error?.message ?? '' });
  }
}

function paintInspector() {
  const panel = $('#mktInspect', root);
  if (!panel) return;
  panel.innerHTML = '';

  const crate = view.selected;
  if (!crate) {
    const empty = el('div', 'inspect__empty');
    const label = el('span', 'build__label');
    label.textContent = 'Selected crate';
    const hint = el('p');
    hint.textContent = '—';
    empty.append(label, hint);
    panel.appendChild(empty);
    return;
  }

  const price = Number(crate.priceMinor);
  const affordable = state.authenticated && state.balance >= price;

  const head = el('div', 'inspect__head');
  const art = document.createElement('img');
  art.src = safeImage(decalPath(crate.metadata?.frontendAsset));
  art.alt = '';
  const meta = el('div', 'inspect__meta');
  const name = el('b', 'inspect__name');
  name.textContent = crate.name;
  const by = el('span', 'inspect__by');
  by.textContent = `by ${crate.creator}`;
  meta.append(name, by);
  head.append(art, meta);
  panel.appendChild(head);

  if (crate.description) {
    const blurb = el('p', 'inspect__blurb');
    blurb.textContent = crate.description;
    panel.appendChild(blurb);
  }

  /* The economics, stated before the button that charges for them. Every community crate returns
   * the same 90% as a first-party one — the creator's cut comes out of the house margin — so the
   * figures are worth showing rather than leaving a player to assume a player-made crate is worse
   * value than a platform one. */
  const stats = el('dl', 'inspect__stats');
  const risk = Number(crate.metadata?.riskPercent ?? 0);
  for (const [term, value] of [
    ['Price', money(price)],
    ['Player return', `${((10_000 - Number(crate.metadata?.edgeBps ?? 1000)) / 100).toFixed(2)}%`],
    ['Volatility', `${risk}% · ${crate.metadata?.riskLabel ?? '—'}`],
    ['Creator royalty', `${(crate.royaltyBps / 100).toFixed(2)}%`],
    ['Opens', grouped(Number(crate.opensCount))],
  ]) {
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd', 'mono');
    dd.textContent = value;
    stats.append(dt, dd);
  }
  panel.appendChild(stats);

  const open = el('button', 'btn btn--go inspect__open');
  open.type = 'button';
  open.disabled = !affordable || view.opening;
  open.textContent = view.opening
    ? 'Opening…'
    : !state.authenticated
      ? 'Log in to open'
      : affordable ? `Open · ${money(price)}` : 'Insufficient balance';
  if (affordable && !view.opening) open.addEventListener('click', () => openCommunityCrate(crate));
  panel.appendChild(open);

  const dropHead = el('span', 'build__label');
  dropHead.textContent = `${crate.drops.length} outcomes`;
  panel.appendChild(dropHead);

  const table = el('div', 'inspect__drops');
  for (const drop of crate.drops) {
    const row = el('div', 'inspect__drop');
    const dropArt = document.createElement('img');
    dropArt.src = safeImage(dropImage(drop));
    dropArt.alt = '';
    const dropName = el('span', 'inspect__dropname');
    dropName.textContent = drop.displayName;
    const dropValue = el('span', 'inspect__dropval mono');
    dropValue.textContent = money(Number(drop.unitValueMinor));
    const chance = el('span', 'inspect__dropodds mono');
    chance.textContent = pct(drop.chancePpm / 1_000_000, drop.chancePpm < 10_000 ? 2 : 1);
    row.append(dropArt, dropName, dropValue, chance);
    table.appendChild(row);
  }
  panel.appendChild(table);
}

/**
 * Opens the selected community crate.
 *
 * Routed through the same store.openCase the crates page uses, which means the same server roll,
 * the same provably-fair seed and the same idempotency key. A second open implementation would be
 * a second chance to get the odds or the money wrong.
 */
async function openCommunityCrate(crate) {
  if (view.opening) return;
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Opening a crate spends real balance.' });
    return;
  }

  view.opening = true;
  paintInspector();
  playSound('click');

  const price = Number(crate.priceMinor);

  try {
    /* store.openCase reads the crate's id and price off the object it is given, and the price is
     * re-checked server-side against the row, so a stale card cannot buy at yesterday's price. */
    const result = await requestCaseOpen({ id: crate.id, priceMinor: crate.priceMinor });
    const item = { ...result.item, name: result.item.displayName ?? result.item.name };
    const payout = Number(result.round?.payoutMinor ?? 0);

    const pool = crate.drops.map((drop) => normalizeItem({
      id: drop.catalogItemId,
      minecraft_name: drop.minecraftName,
      display_name: drop.displayName,
      image_url: drop.imageUrl,
      unit_value_minor: drop.unitValueMinor,
      metadata: drop.metadata,
    }));

    const landedMystery = isMystery(result.item);
    try {
      if (landedMystery) {
        await playMystery({ item, crate: { ...crate, price, drops: pool }, pool });
      } else {
        await playReel({ item, crate: { name: crate.name }, pool, mystery: false });
      }
    } catch (animationError) {
      // A failed reveal must never swallow a settled round.
      console.error('[studio] reveal failed', animationError);
    }

    playSound(payout >= price ? 'win' : 'lose');
    toast({
      kind: payout >= price ? 'win' : 'lose',
      img: item.img,
      title: item.name,
      body: payout ? `+${money(payout)} cash` : 'Opened',
    });

    /* The open moved the crate's counters and paid its author, so the card the player is looking
     * at is now stale. Reload the row and the grid rather than leaving an old figure on screen. */
    await Promise.all([
      refreshBalance().catch(() => undefined),
      loadMarket(),
      selectCrate(crate.slug).catch(() => undefined),
    ]);
  } catch (error) {
    toast({
      kind: 'lose',
      title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not open',
      body: error?.message ?? '',
    });
  } finally {
    view.opening = false;
    paintInspector();
  }
}

/** A drop's art, resolved through the store's own sprite table. */
function dropImage(drop) {
  return normalizeItem({
    id: drop.catalogItemId,
    minecraft_name: drop.minecraftName,
    display_name: drop.displayName,
    image_url: drop.imageUrl,
    unit_value_minor: drop.unitValueMinor,
    metadata: drop.metadata,
  }).img;
}

function buildMarketCard(crate) {
  const card = el('article', 'mktcard');
  const risk = Number(crate.metadata?.riskPercent ?? 0);
  card.style.setProperty('--risk', riskColor(risk));

  const badge = el('span', 'mktcard__risk');
  badge.textContent = crate.metadata?.riskLabel ?? 'Community';
  badge.title = `Volatility ${risk}%`;

  const art = document.createElement('img');
  art.className = 'mktcard__art';
  art.src = safeImage(decalPath(crate.metadata?.frontendAsset));
  art.alt = '';
  art.loading = 'lazy';

  const name = el('h3', 'mktcard__name');
  name.textContent = crate.name;

  const by = el('p', 'mktcard__by');
  const handle = el('span');
  handle.textContent = crate.creator;
  by.append(document.createTextNode('by '), handle);
  if (crate.creatorVerified) {
    const tick = el('i', 'mktcard__verified');
    tick.textContent = '✔';
    tick.title = 'Verified creator';
    by.appendChild(tick);
  }

  const price = el('div', 'mktcard__price mono');
  price.append(coin(), document.createTextNode(money(Number(crate.priceMinor))));

  const stats = el('dl', 'mktcard__stats');
  for (const [label, value] of [
    ['Opens', grouped(Number(crate.opensCount))],
    ['Volume', money(Number(crate.volumeMinor))],
    ['Items', String(crate.dropCount)],
    ['Royalty', `${(crate.royaltyBps / 100).toFixed(2)}%`],
  ]) {
    const term = el('dt');
    term.textContent = label;
    const detail = el('dd', 'mono');
    detail.textContent = value;
    stats.append(term, detail);
  }

  const open = el('button', 'btn btn--go mktcard__open');
  open.type = 'button';
  open.textContent = `Open · ${money(Number(crate.priceMinor))}`;
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    selectCrate(crate.slug);
  });

  card.append(badge, art, name, by, price, stats, open);

  /* The whole card is the target, not just the button. Selecting is a browse action and making a
   * player hit a 100px button to look at a drop table is friction for no reason. */
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.on = view.selected?.slug === crate.slug ? '1' : '0';
  card.addEventListener('click', () => selectCrate(crate.slug));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectCrate(crate.slug);
    }
  });
  return card;
}

function paintBuilder() {
  const body = $('#studioBody', root);
  body.innerHTML = `
    <div class="build">
      <div class="build__left">
        <div class="build__field">
          <label class="build__label" for="bName">Crate name</label>
          <input class="build__input" id="bName" maxlength="48" placeholder="Nether Roulette">
        </div>
        <div class="build__field">
          <label class="build__label" for="bDesc">Description</label>
          <input class="build__input" id="bDesc" maxlength="160" placeholder="What is this crate about?">
        </div>
        <div class="build__field">
          <span class="build__label">Decal</span>
          <div class="build__decals" id="bDecals"></div>
        </div>
        <div class="build__field">
          <label class="build__label" for="bRoyalty">
            Your royalty <b class="mono" id="bRoyaltyOut"></b>
          </label>
          <input type="range" class="build__range" id="bRoyalty" min="0" max="200" step="10">
          <button class="ihint" type="button" aria-label="Paid from the platform's margin, so it never changes what a player pays or gets back."
                  data-tip="Paid from the platform's margin, so it never changes what a player pays or gets back."></button>
        </div>
        <div class="build__econ" id="bEcon"></div>
        <button class="btn btn--go build__publish" id="bPublish">Publish crate</button>
      </div>
      <div class="build__right">
        <div class="build__head">
          <h3>Contents</h3>
          <span class="build__count mono" id="bCount"></span>
        </div>
        <div class="build__drops" id="bDrops"></div>
        <h3 class="build__palettehead">Add an item</h3>
        <div class="build__palette" id="bPalette"></div>
      </div>
    </div>`;

  const name = $('#bName', body);
  name.value = view.draft.name;
  name.addEventListener('input', (event) => {
    view.draft.name = event.target.value;
    /* Re-evaluate the button on every keystroke. Without this the name is stored but the Publish
     * button keeps its old disabled state until some OTHER control repaints it — so a creator who
     * filled the form in the natural order (items, then name) was left staring at a dead button
     * that said "Name your crate" after they had named it. */
    paintPublishState();
  });

  const desc = $('#bDesc', body);
  desc.value = view.draft.description;
  desc.addEventListener('input', (event) => { view.draft.description = event.target.value; });

  const decals = $('#bDecals', body);
  for (const [asset, label] of DECALS) {
    const pick = el('button', 'build__decal');
    pick.type = 'button';
    pick.title = label;
    pick.setAttribute('aria-pressed', String(view.draft.decal === asset));
    const art = document.createElement('img');
    art.src = safeImage(`assets/img/${asset}`);
    art.alt = label;
    pick.appendChild(art);
    pick.addEventListener('click', () => {
      view.draft.decal = asset;
      paintBuilder();
    });
    decals.appendChild(pick);
  }

  const royalty = $('#bRoyalty', body);
  royalty.value = String(view.draft.royaltyBps);
  $('#bRoyaltyOut', body).textContent = `${(view.draft.royaltyBps / 100).toFixed(2)}%`;
  royalty.addEventListener('input', (event) => {
    view.draft.royaltyBps = Number(event.target.value);
    $('#bRoyaltyOut', body).textContent = `${(view.draft.royaltyBps / 100).toFixed(2)}%`;
    schedulePreview();
  });

  paintDrops();
  paintPalette();
  paintEconomics();

  $('#bPublish', body).addEventListener('click', publish);
}

function paintDrops() {
  const wrap = $('#bDrops', root);
  if (!wrap) return;
  wrap.innerHTML = '';

  const limits = view.limits ?? { minDrops: 3, maxDrops: 12, maxWeight: 1_000_000 };
  const count = $('#bCount', root);
  if (count) count.textContent = `${view.draft.drops.length}/${limits.maxDrops}`;

  if (!view.draft.drops.length) {
    wrap.appendChild(el('p', 'empty', `Add at least ${limits.minDrops} items to price this crate.`));
    return;
  }

  const total = view.draft.drops.reduce((sum, drop) => sum + drop.weight, 0) || 1;
  view.draft.drops.forEach((drop, index) => {
    const item = view.palette.find((entry) => entry.id === drop.catalogItemId);
    if (!item) return;

    const row = el('div', 'droprow');

    const art = document.createElement('img');
    art.src = safeImage(item.art);
    art.alt = '';

    const meta = el('div', 'droprow__meta');
    const label = el('span', 'droprow__name');
    label.textContent = item.displayName;
    const value = el('span', 'droprow__value mono');
    value.textContent = money(Number(item.unitValueMinor));
    meta.append(label, value);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'droprow__slider';
    slider.min = '1';
    slider.max = '1000';
    slider.value = String(Math.min(1000, drop.weight));
    slider.addEventListener('input', (event) => {
      view.draft.drops[index].weight = Number(event.target.value);
      paintDrops();
      schedulePreview();
    });

    const chance = el('span', 'droprow__chance mono');
    chance.textContent = `${((drop.weight / total) * 100).toFixed(2)}%`;

    const remove = el('button', 'droprow__x');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      view.draft.drops.splice(index, 1);
      paintDrops();
      schedulePreview();
    });

    row.append(art, meta, slider, chance, remove);
    wrap.appendChild(row);
  });
}

function paintPalette() {
  const wrap = $('#bPalette', root);
  if (!wrap) return;
  wrap.innerHTML = '';

  const limits = view.limits ?? { maxDrops: 12 };
  const chosen = new Set(view.draft.drops.map((drop) => drop.catalogItemId));

  for (const item of view.palette) {
    if (chosen.has(item.id)) continue;
    const chip = el('button', 'build__item');
    chip.type = 'button';
    chip.disabled = view.draft.drops.length >= limits.maxDrops;
    chip.title = `${item.displayName} · ${money(Number(item.unitValueMinor))}`;

    const art = document.createElement('img');
    art.src = safeImage(item.art);
    art.alt = '';
    const value = el('span', 'build__itemval mono');
    value.textContent = money(Number(item.unitValueMinor));
    chip.append(art, value);

    chip.addEventListener('click', () => {
      view.draft.drops.push({ catalogItemId: item.id, weight: 100 });
      playSound('click');
      paintDrops();
      paintPalette();
      schedulePreview();
    });
    wrap.appendChild(chip);
  }
}

function paintEconomics() {
  const panel = $('#bEcon', root);
  if (!panel) return;
  panel.innerHTML = '';

  const preview = view.preview;
  if (!preview) {
    panel.appendChild(el('p', 'build__hint', 'Add items to price this crate.'));
    paintPublishState();
    return;
  }
  if (!preview.ok) {
    const bad = el('p', 'build__bad');
    bad.textContent = preview.reason ?? 'This crate cannot be priced.';
    panel.appendChild(bad);
    paintPublishState();
    return;
  }

  const head = el('div', 'build__pricehead');
  const label = el('span', 'build__label');
  label.textContent = 'Locked selling price';
  const price = el('b', 'build__price mono');
  price.textContent = money(Number(preview.priceMinor));
  head.append(label, price);
  panel.appendChild(head);

  /* The formula is the one thing about this figure a builder cannot read off the stats grid two
   * lines below, so it is the one thing that survives — behind the icon, next to the price it
   * explains, rather than as a paragraph between them. */
  const sentence =
    'Set by the platform at expected value ÷ 0.90, which is what fixes every player’s return at 90%.';
  const tip = el('button', 'ihint');
  tip.type = 'button';
  tip.dataset.tip = sentence;
  tip.setAttribute('aria-label', sentence);
  head.appendChild(tip);

  const grid = el('dl', 'build__stats');
  for (const [term, value] of [
    ['Expected value', money(Number(preview.expectedValueMinor))],
    ['Player return', `${(preview.rtpBps / 100).toFixed(2)}%`],
    ['House edge', `${(preview.houseEdgeBps / 100).toFixed(2)}%`],
    ['Your cut per open', money(Number(preview.royaltyPerOpenMinor))],
    ['Platform net per open', money(Number(preview.platformNetPerOpenMinor))],
    ['Volatility', `${preview.riskPercent}% · ${preview.riskLabel}`],
    ['Top multiple', `${preview.topMultiple}×`],
  ]) {
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd', 'mono');
    dd.textContent = value;
    grid.append(dt, dd);
  }
  panel.appendChild(grid);
  paintPublishState();
}

function paintPublishState() {
  const button = $('#bPublish', root);
  if (!button) return;
  const limits = view.limits ?? { minDrops: 3 };
  const ready = state.authenticated
    && view.draft.name.trim().length >= 3
    && view.draft.drops.length >= limits.minDrops
    && view.preview?.ok
    && view.preview?.complete;

  button.disabled = !ready;
  button.textContent = !state.authenticated
    ? 'Log in to publish'
    : view.draft.name.trim().length < 3
      ? 'Name your crate'
      : view.draft.drops.length < limits.minDrops
        ? `Add ${limits.minDrops - view.draft.drops.length} more item(s)`
        : view.preview?.ok
          ? `Publish · ${money(Number(view.preview.priceMinor))}`
          : 'Cannot price this crate';
}

function paintMine() {
  const body = $('#studioBody', root);
  if (!state.authenticated) {
    body.innerHTML = '';
    body.appendChild(el('p', 'empty', 'Log in to see the crates you have published.'));
    return;
  }
  if (!view.mine) {
    body.innerHTML = '';
    body.appendChild(el('p', 'empty', 'Loading your crates…'));
    return;
  }

  body.innerHTML = `
    <div class="mine__earn">
      <span class="build__label">Royalties earned</span>
      <b class="mono" id="mineTotal"></b>
      <span class="mine__count mono" id="minePayments"></span>
    </div>
    <div class="market__grid" id="mineGrid"></div>`;

  $('#mineTotal', body).textContent = money(Number(view.mine.earnings.totalMinor));
  $('#minePayments', body).textContent = `${grouped(view.mine.earnings.payments)} payments`;

  const grid = $('#mineGrid', body);
  if (!view.mine.crates.length) {
    grid.appendChild(el('p', 'empty', 'You have not published a crate yet.'));
    return;
  }
  for (const crate of view.mine.crates) {
    const card = el('article', 'mktcard');
    const badge = el('span', 'mktcard__risk');
    badge.textContent = crate.status;

    const art = document.createElement('img');
    art.className = 'mktcard__art';
    art.src = safeImage(decalPath(crate.metadata?.frontendAsset));
    art.alt = '';

    const name = el('h3', 'mktcard__name');
    name.textContent = crate.name;

    const price = el('div', 'mktcard__price mono');
    price.append(coin(), document.createTextNode(money(Number(crate.priceMinor))));

    const stats = el('dl', 'mktcard__stats');
    for (const [label, value] of [
      ['Opens', grouped(Number(crate.opensCount))],
      ['Volume', money(Number(crate.volumeMinor))],
      ['Earned', money(Number(crate.royaltiesPaidMinor))],
      ['Royalty', `${(crate.royaltyBps / 100).toFixed(2)}%`],
    ]) {
      const dt = el('dt');
      dt.textContent = label;
      const dd = el('dd', 'mono');
      dd.textContent = value;
      stats.append(dt, dd);
    }

    card.append(badge, art, name, price, stats);

    if (crate.status !== 'retired') {
      const retire = el('button', 'btn mktcard__open');
      retire.type = 'button';
      retire.textContent = 'Retire';
      retire.addEventListener('click', async () => {
        try {
          await api.post(`/v1/community/cases/${encodeURIComponent(crate.slug)}/retire`, {});
          toast({ kind: 'win', title: 'Retired', body: `${crate.name} is off the marketplace.` });
          loadMine();
        } catch (error) {
          toast({ kind: 'lose', title: 'Could not retire', body: error?.message ?? '' });
        }
      });
      card.appendChild(retire);
    }
    grid.appendChild(card);
  }
}

/* ─────────────────────────── actions ─────────────────────────── */

async function publish() {
  if (!state.authenticated) return;
  try {
    const result = await api.post('/v1/community/cases', {
      name: view.draft.name.trim(),
      description: view.draft.description.trim(),
      decal: view.draft.decal,
      royaltyBps: view.draft.royaltyBps,
      drops: view.draft.drops.map((drop) => ({
        catalogItemId: drop.catalogItemId,
        weight: drop.weight,
      })),
      publish: true,
    });
    playSound('reward');
    toast({
      kind: 'win',
      title: 'Crate published',
      body: `${result.crate.name} listed at ${money(Number(result.crate.priceMinor))}`,
    });
    view.draft = {
      name: '', description: '', decal: DECALS[0][0],
      royaltyBps: view.limits?.defaultRoyaltyBps ?? 150, drops: [],
    };
    view.preview = null;
    view.tab = 'mine';
    await Promise.all([loadMarket(), loadMine(), refreshBalance().catch(() => undefined)]);
    paint();
  } catch (error) {
    toast({
      kind: 'lose',
      title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not publish',
      body: error?.message ?? '',
    });
  }
}

/* ─────────────────────────── bits ─────────────────────────── */

function decalPath(asset) {
  if (typeof asset === 'string'
    && /^(?:items|block)\/[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/.test(asset)) {
    return `assets/img/${asset}`;
  }
  return 'assets/img/block/chest_normal.png';
}

function riskColor(percent) {
  if (percent < 25) return '#ffd700';
  if (percent < 45) return '#ffc400';
  if (percent < 65) return '#ffaa00';
  if (percent < 82) return '#ff7b00';
  return '#ff3b1f';
}

function coin() {
  const mark = el('i', 'coin');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

