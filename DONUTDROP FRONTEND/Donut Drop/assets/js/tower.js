/* tower.js — nine floors, TNT behind some of the tiles on each, and one tile to turn per floor.
 *
 * The server owns the tower. It places the TNT on every floor when the climb starts, from the
 * player's committed fairness seed, and never tells this page where it is until the game is over;
 * every tile turned is a request, and the answer is either a gem and the next floor, or the end.
 * This page shows what it is told, prices every floor before it is climbed (each hidden tile
 * carries the multiplier its floor pays), and keeps the one button in step with the game: Start,
 * then Cash out, then the result.
 *
 * Only the floor being climbed can be pressed. One tab stop sits on it; the left and right arrows
 * move between its tiles and Enter or Space turns one.
 *
 * The tower is drawn in WebGL (tower3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage: nine storeys of stone brick with a row of chests on each, Steve climbing the
 * ladder as he clears them. The flat tower stays underneath for the keyboard and a screen reader,
 * for a browser without WebGL, and for a player who switches to 2D (view3d.js).
 *
 * Motion is two things: a gem settling into its tile, and the TNT going off. With reduced motion
 * both become an instant change of state, and nothing shakes.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, refreshBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, setWants3d, viewSwitch, wants3d } from './view3d.js';

const FLOORS = 9;
const EDGE_BPS = 1000n;
/* Mirrors lib/tower.ts, so the board can price a mode before the server has answered. The
 * server's own figures replace these the moment a game exists. */
const MODES = {
  easy: { tiles: 4, traps: 1, label: 'Easy' },
  medium: { tiles: 3, traps: 1, label: 'Medium' },
  hard: { tiles: 2, traps: 1, label: 'Hard' },
  expert: { tiles: 3, traps: 2, label: 'Expert' },
};
const MODE_NAMES = Object.keys(MODES);
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

let root = null;
let config = null;
let seedHash = null;
let game = null; // the active or last-finished game, as the server described it
let busy = false;
let pressed = null; // 'start' | 'cashout' | tile index
let stakeText = '1m';
let mode = 'easy';
let focusTile = 0;
let tower3d = null; // the 3D tower, once it is up
let towerTried = null;

/* ─────────── the maths, mirrored from lib/tower.ts ─────────── */

/** The multiplier, in basis points, for cashing out after `cleared` floors. */
function multiplierBps(name, cleared) {
  const { tiles, traps } = MODES[name];
  const num = BigInt(tiles) ** BigInt(cleared);
  const den = BigInt(tiles - traps) ** BigInt(cleared);
  return Number(((10_000n - EDGE_BPS) * num) / den);
}

const times = (bps) => `${(Math.floor(bps / 100) / 100).toFixed(2)}×`;

/* ─────────── state ─────────── */

const inPlay = () => game?.status === 'active';
const over = () => game?.status === 'settled';
/** The mode on the board: the game's while there is one, the player's choice otherwise. */
const boardMode = () => (game ? game.mode : mode);

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function startProblem() {
  if (!config) return 'Tower is not answering';
  if (!config.enabled) return 'Tower is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest stake is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest stake is ${money(Number(config.maxStakeMinor))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/tower/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    await reload();
  } else {
    game = null;
  }
  paint();
  if (config) void startTower();
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

/** Puts a climb the server knows about back on the board. */
async function reload() {
  try {
    const { game: active } = await api.get('/v1/tower/games/active');
    if (active) {
      game = active;
      mode = active.mode;
    } else if (inPlay()) {
      game = null;
    }
  } catch {
    /* A failed read leaves the board as it was; the next action will say what is wrong. */
  }
}

async function start() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || inPlay() || startProblem()) return;
  busy = true;
  pressed = 'start';
  paint();
  try {
    // Sent once more against a fresh commitment if another game or tab spent this one.
    const response = await betOnCommitment(seedHash, (serverSeedHash, key) => api.post(
      '/v1/tower/games',
      { stakeMinor: stakeMinor().toString(), mode, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    game = response.game;
    focusTile = 0;
    playSound('click');
    say(`Climb started on ${MODES[mode].label}. Pick a tile on floor 1.`);
    await refreshSeed();
  } catch (error) {
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    if (error?.code === 'GAME_IN_PLAY') {
      await reload();
      toast({ kind: 'gold', title: 'Tower', body: 'Your climb in play is back on the board.' });
    } else {
      toast({ kind: 'lose', title: 'Tower', body: error?.message || 'That climb did not start' });
    }
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paint();
    if (inPlay()) tileNode(game.floor, focusTile)?.focus({ preventScroll: true });
  }
}

async function pick(tile) {
  if (busy || !inPlay()) return;
  const floor = game.floor;
  busy = true;
  pressed = tile;
  paint();
  try {
    const response = await api.post(`/v1/tower/games/${game.id}/pick`, { tile, floor });
    game = response.game;
    if (tower3d) await tower3d.open(floor, tile, game.outcome === 'trap');
    if (game.outcome === 'trap') {
      if (!tower3d) boom(floor, tile);
      say(`TNT on floor ${floor + 1}. You lost ${money(Number(game.stakeMinor))}.`);
    } else {
      if (!tower3d) gem(floor, tile);
      if (over()) {
        finished();
      } else {
        say(`Gem. Floor ${floor + 1} cleared. Cash out now for ${money(Number(game.cashoutMinor))}, or pick on floor ${game.floor + 1}.`);
      }
    }
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Tower', body: error?.message || 'That tile did not turn' });
  } finally {
    busy = false;
    pressed = null;
    if (over()) void refreshBalance();
    paint();
    // The focus climbs with the player, so the next pick is one keypress away.
    if (inPlay()) tileNode(game.floor, Math.min(focusTile, game.tiles - 1))?.focus({ preventScroll: true });
  }
}

async function cashOut() {
  if (busy || !inPlay() || game.floor === 0) return;
  busy = true;
  pressed = 'cashout';
  paint();
  try {
    const response = await api.post(`/v1/tower/games/${game.id}/cashout`, { floor: game.floor });
    game = response.game;
    finished();
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Tower', body: error?.message || 'That cash-out did not go through' });
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paint();
  }
}

function finished() {
  if (game?.outcome !== 'cashout') return;
  playSound('win');
  tower3d?.celebrate(game.multiplierBps);
  const top = game.picks.length === FLOORS ? ' from the top' : '';
  say(`Cashed out${top} at ${times(game.multiplierBps)} for ${money(Number(game.payoutMinor))}.`);
}

function randomPick() {
  if (!inPlay()) return;
  void pick(Math.floor(Math.random() * game.tiles));
}

/* ─────────── the 3D tower ─────────── */

function startTower() {
  if (towerTried || !wants3d()) return towerTried;
  towerTried = (async () => {
    const host = $('.tower__pit', root);
    try {
      const { createTower3d } = await import('./tower3d.js');
      const built = await createTower3d(host);
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        towerTried = null;
        return;
      }
      if (!built) return;
      built.onLost = () => {
        if (tower3d === built) tower3d = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onPick = (tile) => {
        focusTile = tile;
        void pick(tile);
      };
      built.onCue = cue;
      tower3d = built;
      root.dataset.render = '3d';
      syncTower();
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    }
  })();
  return towerTried;
}

/** The tower's sounds: a chest's lid, the emerald, the ladder, the fuse and the blast, the haul. */
function cue(name) {
  if (name === 'open') playSound('click', { rate: 0.7 });
  else if (name === 'gem') playSound('tick');
  else if (name === 'climb') playSound('click', { rate: 1.7 });
  else if (name === 'fuse') playSound('fuse');
  else if (name === 'boom') {
    playSound('explode');
    try { navigator.vibrate?.(80); } catch { /* not every browser lets a page vibrate */ }
  } else if (name === 'collect') playSound('absorb');
  else if (name === 'firework') playSound('shatter', { rate: 1.5 });
}

/** The 3D tower as the game stands: the chests opened, the storey Steve is on, what each pays. */
function syncTower() {
  if (!tower3d) return;
  const name = boardMode();
  tower3d.sync({
    tiles: MODES[name].tiles,
    floor: game ? game.picks.length : 0,
    picks: game?.picks ?? [],
    over: over(),
    traps: over() ? game.trapTiles ?? null : null,
    trapHit: over() && game.outcome === 'trap' ? game.trapHit : null,
    pays: Array.from({ length: FLOORS }, (_, floor) => times(multiplierBps(name, floor + 1))),
  });
  tower3d.setActive(inPlay() && !busy);
}

function setGraphics(value) {
  if (busy || inPlay() || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (tower3d) {
    tower3d.dispose();
    tower3d = null;
    towerTried = null;
    root.dataset.render = '2d';
    if (config) void startTower();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the tower away for the flat board, 3D builds it again. */
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
  if (!on && tower3d) {
    tower3d.dispose();
    tower3d = null;
    towerTried = null;
    root.dataset.render = '2d';
  }
  if (on && config) void startTower();
  paintGraphics();
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#towerView', root), { disabled: Boolean(busy) });
  const select = root && $('#towerGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = tower3d?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
  select.disabled = inPlay() || busy;
}

/* ─────────── motion ─────────── */

function floorNode(floor) {
  return root?.querySelector(`.tfloor[data-floor="${floor}"]`);
}

function tileNode(floor, tile) {
  return floorNode(floor)?.querySelector(`.ttile[data-tile="${tile}"]`);
}

function gem(floor, tile) {
  playSound('tick');
  if (reduceMotion()) return;
  tileNode(floor, tile)?.animate(
    [{ transform: 'scale(.94)' }, { transform: 'scale(1.04)', offset: 0.55 }, { transform: 'scale(1)' }],
    { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}

function boom(floor, tile) {
  playSound('slam');
  try { navigator.vibrate?.(60); } catch { /* not every browser lets a page vibrate */ }
  if (reduceMotion()) return;
  tileNode(floor, tile)?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.3 }, { transform: 'scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
  floorNode(floor)?.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' },
      { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
    { duration: 340, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}

/* One polite, whole sentence per event. */
function say(text) {
  const node = $('#towerSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintBoard();
  paintReadout();
  paintControls();
  paintGraphics();
  syncTower();
}

/** Each floor's tiles, rebuilt only when the mode changes how many a floor has. */
function ensureTiles(floorEl, count) {
  if (floorEl.childElementCount === count) return;
  floorEl.style.setProperty('--tiles', String(count));
  floorEl.replaceChildren(...Array.from({ length: count }, (_, tile) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ttile';
    button.dataset.tile = String(tile);
    button.dataset.kind = 'hidden';
    button.tabIndex = -1;
    const label = document.createElement('span');
    label.className = 'ttile__x';
    label.setAttribute('aria-hidden', 'true');
    button.append(label);
    return button;
  }));
}

function paintBoard() {
  const board = $('#towerBoard', root);
  const name = boardMode();
  const { tiles } = MODES[name];
  const current = inPlay() ? game.floor : -1;
  board.dataset.state = inPlay() ? 'play' : over() ? 'over' : 'idle';
  board.dataset.mode = name;

  for (let floor = 0; floor < FLOORS; floor += 1) {
    const floorEl = floorNode(floor);
    ensureTiles(floorEl, tiles);
    const picked = game?.picks?.[floor];
    const cleared = game ? floor < game.picks.length : false;
    const lostHere = over() && game.outcome === 'trap' && floor === game.picks.length;
    const traps = over() ? new Set(game.trapTiles?.[floor] ?? []) : null;
    floorEl.dataset.state = floor === current ? 'now' : cleared ? 'done' : lostHere ? 'lost' : 'ahead';
    const pays = times(multiplierBps(name, floor + 1));

    for (let tile = 0; tile < tiles; tile += 1) {
      const node = floorEl.children[tile];
      let kind = 'hidden';
      if (cleared && picked === tile) kind = 'gem';
      else if (lostHere && game.trapHit === tile) kind = 'boom';
      else if (traps?.has(tile)) kind = 'tnt';
      else if (over()) kind = 'dim-gem';
      else if (cleared) kind = 'passed';
      node.dataset.kind = kind;
      node.firstChild.textContent = kind === 'hidden' ? pays : '';

      const what = {
        hidden: `pays ${pays}`,
        passed: 'not turned',
        gem: 'gem, your pick',
        boom: 'TNT, your pick',
        tnt: 'TNT',
        'dim-gem': 'gem, not turned',
      }[kind];
      node.setAttribute('aria-label', `Floor ${floor + 1}, tile ${tile + 1}: ${what}`);
      const live = floor === current;
      /* Only the floor being climbed takes a press. aria-disabled, not disabled, on it while a pick
       * is out: a disabled button drops the focus the arrow keys are holding. */
      node.disabled = !live;
      node.setAttribute('aria-disabled', String(!live || busy));
      node.setAttribute('aria-busy', String(live && pressed === tile));
      node.tabIndex = live && tile === Math.min(focusTile, tiles - 1) ? 0 : -1;
    }
  }

  const banner = $('#towerBanner', root);
  if (over()) {
    const won = game.outcome === 'cashout';
    const profit = BigInt(game.payoutMinor || '0') - BigInt(game.stakeMinor);
    banner.hidden = false;
    banner.dataset.tone = won ? 'won' : 'lost';
    $('b', banner).textContent = won ? times(game.multiplierBps) : 'TNT';
    $('span', banner).textContent = won
      ? `${profit >= 0n ? '+' : '−'}${money(Number(profit >= 0n ? profit : -profit))}`
      : `−${money(Number(game.stakeMinor))}`;
  } else {
    banner.hidden = true;
  }
}

function paintReadout() {
  const now = $('#towerNow', root);
  const next = $('#towerNext', root);
  const name = boardMode();
  const { tiles, traps } = MODES[name];
  const safePct = `${Math.round(((tiles - traps) / tiles) * 100)}% safe`;
  if (inPlay()) {
    now.textContent = game.floor
      ? `${times(game.multiplierBps)} · ${money(Number(game.cashoutMinor))}`
      : `Floor 1 of ${FLOORS} · pick a tile`;
    next.textContent = game.nextMultiplierBps ? `Floor ${game.floor + 1} pays ${times(game.nextMultiplierBps)} · ${safePct}` : '';
  } else {
    now.textContent = `${MODES[name].label} · ${tiles - traps} of ${tiles} safe`;
    next.textContent = `Top floor pays ${times(multiplierBps(name, FLOORS))}`;
  }
}

function paintControls() {
  const go = $('#towerGo', root);
  const label = $('#towerGoLabel', root);
  const hint = $('#towerHint', root);
  let text = '';
  let tone = 'go';
  let disabled = false;
  if (!state.authenticated) {
    text = 'Log in to play';
  } else if (inPlay()) {
    if (pressed === 'cashout') { text = 'Cashing out…'; tone = 'cash'; disabled = true; }
    else if (game.floor === 0) { text = 'Pick a tile'; tone = 'idle'; disabled = true; }
    else { text = `Cash out ${money(Number(game.cashoutMinor))}`; tone = 'cash'; disabled = busy; }
  } else if (pressed === 'start') {
    text = 'Starting…';
    disabled = true;
  } else {
    text = `${over() ? 'Play again' : 'Start'} · ${money(Number(stakeMinor() ?? 0n))}`;
    disabled = Boolean(startProblem()) || busy;
  }
  if (label.textContent !== text) label.textContent = text;
  go.dataset.tone = tone;
  go.disabled = disabled;
  go.setAttribute('aria-busy', String(pressed === 'start' || pressed === 'cashout'));
  hint.textContent = state.authenticated && !inPlay() ? startProblem() : '';

  const random = $('#towerRandom', root);
  random.hidden = !inPlay();
  random.disabled = busy;

  const locked = inPlay() || busy;
  for (const node of root.querySelectorAll('.tower__form input, .tower__form .tower__adj, .tower__mode')) {
    node.disabled = locked;
  }
  const name = boardMode();
  root.querySelectorAll('.tower__mode').forEach((button) => {
    const chosen = button.dataset.mode === name;
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  });
}

/* ─────────── building ─────────── */

function chooseMode(name) {
  if (!MODES[name] || inPlay() || busy) return;
  mode = name;
  // A finished climb on another mode would be a board the stake field no longer describes.
  if (over() && game.mode !== name) game = null;
  focusTile = 0;
  paint();
}

function build() {
  const floors = Array.from({ length: FLOORS }, (_, floor) =>
    `<div class="tfloor" data-floor="${floor}" data-state="ahead" role="group" aria-label="Floor ${floor + 1}"></div>`,
  ).join('');
  root.innerHTML = `
    <section class="tower__stage" aria-label="The tower">
      <div class="tower__readout">
        <b id="towerNow">—</b>
        <span id="towerNext"></span>
      </div>
      <div class="tower__pit">
      <div class="tower__board" id="towerBoard" role="group" aria-label="Nine floors, climbed from the bottom. Use the left and right arrow keys to choose a tile on your floor and Enter to turn it">
        ${floors}
      </div>
      <div class="tower__banner" id="towerBanner" hidden><b></b><span></span></div>
      </div>
    </section>

    <aside class="tower__panel" aria-label="Your climb">
      <form class="tower__form" id="towerForm" novalidate>
        <label class="tower__label" for="towerStake">Stake</label>
        <div class="tower__field">
          <span aria-hidden="true">$</span>
          <input id="towerStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="tower__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="tower__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="tower__label" id="towerModeLabel">Difficulty</span>
        <div class="tower__modes" role="radiogroup" aria-labelledby="towerModeLabel">
          ${MODE_NAMES.map((name) => `<button type="button" class="tower__mode" role="radio" data-mode="${name}" aria-checked="false">${MODES[name].label}</button>`).join('')}
        </div>
        <button class="btn tower__go" id="towerGo" type="submit" data-tone="go">
          <span id="towerGoLabel">Loading…</span>
        </button>
        <button class="tower__random" id="towerRandom" type="button" hidden>Random pick</button>
        <p class="tower__hint" id="towerHint" aria-live="polite"></p>
        ${viewSwitch('towerView')}
        <label class="tower__gfx" for="towerGfx">
          <span>Graphics</span>
          <select id="towerGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="tower__say" id="towerSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#towerStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.tower__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paint();
  }));

  const modes = $('.tower__modes', root);
  modes.addEventListener('click', (event) => {
    const button = event.target.closest('.tower__mode');
    if (button) chooseMode(button.dataset.mode);
  });
  /* A radio group: one tab stop, the arrows move the choice. */
  modes.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step || inPlay() || busy) return;
    event.preventDefault();
    const index = (MODE_NAMES.indexOf(mode) + step + MODE_NAMES.length) % MODE_NAMES.length;
    chooseMode(MODE_NAMES[index]);
    modes.querySelector(`[data-mode="${mode}"]`)?.focus();
  });

  $('#towerForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (inPlay()) void cashOut();
    else void start();
  });
  $('#towerRandom', root).addEventListener('click', randomPick);
  $('#towerGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#towerView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });

  const board = $('#towerBoard', root);
  board.addEventListener('click', (event) => {
    const tile = event.target.closest('.ttile');
    if (!tile || tile.disabled || tile.getAttribute('aria-disabled') === 'true') return;
    focusTile = Number(tile.dataset.tile);
    void pick(focusTile);
  });
  board.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step || !inPlay()) return;
    event.preventDefault();
    const next = focusTile + step;
    if (next < 0 || next >= game.tiles) return;
    focusTile = next;
    paintBoard();
    tileNode(game.floor, next)?.focus();
  });
  // The keyboard's place on the floor, shown in the tower as a white outline round a chest.
  board.addEventListener('focusin', (event) => {
    const tile = event.target.closest('.ttile');
    if (tile?.matches(':focus-visible')) tower3d?.setFocus(Number(tile.dataset.tile));
  });
  board.addEventListener('focusout', () => tower3d?.setFocus(-1));
}

export function mountTower(section) {
  root = $('#towerRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments a climb in play can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        game = null;
        seedHash = null;
      }
      if (!busy) paint();
    });
  }
  void load();
}
