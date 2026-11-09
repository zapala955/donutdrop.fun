/* mines.js — twenty-five blocks, some of them TNT, and the nerve to keep turning them.
 *
 * The server owns the field. It places the TNT when the game starts, from the player's committed
 * fairness seed, and never tells this page where it is until the game is over; every tile turned
 * is a request, and the answer is either a diamond or the end. This page shows what it is told,
 * prices the next tile honestly before it is turned, and keeps the one button in step with the
 * game: Start, then Cash out, then the result.
 *
 * Motion, on the flat field: the tiles waking from the centre out as a game starts; a tile turning
 * over to its diamond or its TNT; the TNT shaking the field; once a game ends, the rest of the field
 * turning over in a ripple from the last tile; a win card popping up, its amount counting up. Every
 * step has its sound (audio-engine.js, the mines cues): a diamond rings a step higher for every one
 * found. With reduced motion each is an instant change of state, and nothing shakes. No line of text
 * sits over the field; the profit so far is a field in the panel, and a screen reader hears each
 * turn from the status line (say).
 *
 * The field is drawn in WebGL (mines3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage: a cave with the blocks on its floor, picked with the pointer. The flat field
 * stays under it, out of sight, for the keyboard and a screen reader -- the arrow keys move a white
 * outline in the cave -- and comes back whole without WebGL.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, refreshBalance, state } from './store.js';
import { $, adjustStake, el, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, sceneLoaded, sceneLoading, setWants3d, viewSwitch, wants3d } from './view3d.js';

const TILES = 25;
const QUICK_MINES = [1, 3, 5, 10, 24];
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

let root = null;
let view = null;
let config = null;
let seedHash = null;
let game = null; // the active or last-finished game, as the server described it
let busy = false;
let pressed = null; // 'start' | 'cashout' | tile index
let stakeText = '1m';
let mineCount = 3;
let focusTile = 12;
let field = null; // the 3D cave, once it is up
let fieldTried = null;

const times = (bps) => `${(Math.floor(bps / 100) / 100).toFixed(2)}×`;

/* ─────────── state ─────────── */

const inPlay = () => game?.status === 'active';

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function startProblem() {
  if (!config) return 'Mines is not answering';
  if (!config.enabled) return 'Mines is closed right now';
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
    config = await api.get('/v1/mines/config');
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
  syncField();
  if (config) void startField();
  else sceneLoaded(root);
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

/** Puts a game the server knows about back on the board. */
async function reload() {
  try {
    const { game: active } = await api.get('/v1/mines/games/active');
    if (active) game = active;
    else if (inPlay()) game = null;
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
      '/v1/mines/games',
      { stakeMinor: stakeMinor().toString(), mines: mineCount, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    game = response.game;
    focusTile = 12;
    field?.reset(true);
    wake();
    say(`Game started with ${mineCount} TNT. Pick a tile.`);
    await refreshSeed();
  } catch (error) {
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    if (error?.code === 'GAME_IN_PLAY') {
      await reload();
      toast({ kind: 'gold', title: 'Mines', body: 'Your game in play is back on the board.' });
    } else {
      toast({ kind: 'lose', title: 'Mines', body: error?.message || 'That game did not start' });
    }
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paint();
  }
}

async function reveal(tile) {
  if (busy || !inPlay() || game.revealed.includes(tile)) return;
  busy = true;
  pressed = tile;
  playSound('minesTap');
  paint();
  try {
    const response = await api.post(`/v1/mines/games/${game.id}/reveal`, {
      tile,
      revealedCount: game.revealed.length,
    });
    const before = game.revealed.length;
    game = response.game;
    if (!field) {
      // The tile shows what it was before its motion runs: the flip turns over the new face.
      pressed = null;
      paintBoard();
    }
    if (game.outcome === 'mine') {
      if (field) await field.dig(tile, true);
      else await boom(tile);
      field?.reveal(game.mineTiles ?? [], tile);
      say(`TNT. You lost ${money(Number(game.stakeMinor))}.`);
    } else {
      if (field) await field.dig(tile, false);
      else gem(tile, game.revealed.length);
      if (game.status === 'settled') {
        finished();
      } else {
        const found = game.revealed.length;
        say(`Diamond. ${found} found. Cash out now for ${money(Number(game.cashoutMinor))}.`);
      }
      if (game.revealed.length <= before) void reload();
    }
  } catch (error) {
    if (error?.code === 'STALE_ACTION' || error?.code === 'TILE_TAKEN') await reload();
    else toast({ kind: 'lose', title: 'Mines', body: error?.message || 'That tile did not turn' });
  } finally {
    busy = false;
    pressed = null;
    if (game?.status === 'settled') void refreshBalance();
    paint();
  }
}

async function cashOut() {
  if (busy || !inPlay() || game.revealed.length === 0) return;
  busy = true;
  pressed = 'cashout';
  paint();
  try {
    const response = await api.post(`/v1/mines/games/${game.id}/cashout`, {
      revealedCount: game.revealed.length,
    });
    game = response.game;
    finished();
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Mines', body: error?.message || 'That cash-out did not go through' });
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paint();
  }
}

function finished() {
  if (game?.outcome !== 'cashout') return;
  playSound('minesCash');
  field?.reveal(game.mineTiles ?? [], null);
  field?.celebrate(game.multiplierBps);
  say(`Cashed out at ${times(game.multiplierBps)} for ${money(Number(game.payoutMinor))}.`);
  if (field) return;
  paintBoard();
  if (reduceMotion()) return;
  const banner = $('#minesBanner', root);
  banner.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.82)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.04)', offset: 0.6 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
    ],
    { duration: 380, easing: EASE },
  );
  countUp($('span', banner), Number(game.payoutMinor), 650);
  revealRest(game.revealed.at(-1) ?? 12, 160);
}

function randomTile() {
  if (!inPlay()) return;
  const hidden = [];
  for (let tile = 0; tile < TILES; tile += 1) if (!game.revealed.includes(tile)) hidden.push(tile);
  if (hidden.length) void reveal(hidden[Math.floor(Math.random() * hidden.length)]);
}

/* ─────────── the cave ─────────── */

function startField() {
  if (fieldTried || !wants3d()) return fieldTried;
  fieldTried = (async () => {
    const host = $('.mines__pit', root);
    sceneLoading(root, host);
    try {
      const { createMines3d } = await import('./mines3d.js');
      const built = await createMines3d(host);
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        fieldTried = null;
        return;
      }
      if (!built) {
        // No WebGL here: the flat field is all there is, and its graphics have nothing to choose.
        $('.mines__gfx', root).hidden = true;
        return;
      }
      built.onLost = () => {
        if (field === built) field = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onPick = (tile) => {
        focusTile = tile;
        void reveal(tile);
      };
      built.onCue = cue;
      field = built;
      root.dataset.render = '3d';
      syncField();
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    } finally {
      sceneLoaded(root);
    }
  })();
  return fieldTried;
}

/** The cave's sounds: the pickaxe on stone, the fuse, the blast, the diamonds coming in. */
function cue(name, at = 0) {
  if (name === 'crack') playSound('dig', { rate: 0.85 + at * 0.04 });
  else if (name === 'break') playSound('dig', { rate: 0.7 });
  else if (name === 'gem') playSound('tick');
  else if (name === 'fuse') playSound('fuse');
  else if (name === 'boom') {
    playSound('explode');
    try { navigator.vibrate?.(80); } catch { /* not every browser lets a page vibrate */ }
  } else if (name === 'collect') playSound('absorb');
  else if (name === 'firework') playSound('shatter', { rate: 1.5 });
}

/** The cave as the game stands: the blocks mined, and once it is over, what was in the rest. */
function syncField() {
  if (!field) return;
  if (game) {
    field.setBoard(game.revealed);
    if (game.status === 'settled') field.reveal(game.mineTiles ?? [], game.mineHit ?? null);
  } else {
    field.reset(false);
  }
  field.setActive(inPlay() && !busy);
}

function setGraphics(value) {
  if (busy || inPlay() || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (field) {
    field.dispose();
    field = null;
    fieldTried = null;
    root.dataset.render = '2d';
    if (config) void startField();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the cave away for the flat board, 3D builds it again. */
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
  if (!on && field) {
    field.dispose();
    field = null;
    fieldTried = null;
    root.dataset.render = '2d';
  }
  if (on && config) void startField();
  paintGraphics();
}

/* ─────────── motion ─────────── */

function tileNode(index) {
  return root?.querySelector(`.mtile[data-tile="${index}"]`);
}

const EASE = 'cubic-bezier(.16, 1, .3, 1)';
/* A tile turning over sideways and settling. */
const FLIP = [
  { transform: 'perspective(520px) rotateY(-90deg)' },
  { transform: 'perspective(520px) rotateY(12deg)', offset: 0.68 },
  { transform: 'perspective(520px) rotateY(0deg)' },
];
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** How many steps apart two tiles are on the 5 by 5 field (a king's move). */
const steps = (a, b) => Math.max(Math.abs((a % 5) - (b % 5)), Math.abs(Math.floor(a / 5) - Math.floor(b / 5)));

/** A game starting: the tiles wake from the centre out. */
function wake() {
  playSound('minesStart');
  if (field || reduceMotion()) return;
  for (let index = 0; index < TILES; index += 1) {
    tileNode(index)?.animate(
      [{ opacity: 0.4, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }],
      { duration: 300, delay: steps(index, 12) * 45, easing: EASE, fill: 'backwards' },
    );
  }
}

/** A diamond: the tile turns over and rings, a step higher for every diamond found. */
function gem(index, found) {
  playSound('minesGem', { rate: 1 + Math.min(found - 1, 20) * 0.045 });
  if (reduceMotion()) return;
  tileNode(index)?.animate(FLIP, { duration: 340, easing: EASE });
}

/** TNT: the tile turns over, the field shakes, and the rest of it turns over from there. */
async function boom(index) {
  playSound('minesBoom');
  try { navigator.vibrate?.(80); } catch { /* not every browser lets a page vibrate */ }
  if (reduceMotion()) return;
  tileNode(index)?.animate(FLIP, { duration: 300, easing: EASE });
  $('.mines__board', root)?.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(7px)' },
      { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
    { duration: 420, delay: 90, easing: EASE },
  );
  await wait(320);
  revealRest(index, 0);
}

/** Once a game ends, every tile not turned turns over, in a ripple out from `origin`. */
function revealRest(origin, delay) {
  if (reduceMotion()) return;
  const rings = new Set();
  for (let index = 0; index < TILES; index += 1) {
    const node = tileNode(index);
    if (!node || ['gem', 'boom'].includes(node.dataset.kind)) continue;
    const ring = steps(index, origin);
    const at = delay + ring * 70;
    rings.add(ring);
    node.animate(
      [{ opacity: 0, transform: 'perspective(520px) rotateY(-70deg)' }, { opacity: 1, transform: 'none' }],
      { duration: 300, delay: at, easing: EASE, fill: 'backwards' },
    );
  }
  for (const ring of rings) setTimeout(() => playSound('minesReveal', { rate: 1 + ring * 0.08 }), delay + ring * 70);
}

/** The win card's amount, counted up from nothing. */
function countUp(node, value, ms) {
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / ms);
    node.textContent = money(Math.round(value * (1 - (1 - t) ** 3)));
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  node.textContent = money(0);
  requestAnimationFrame(step);
}

/* One polite, whole sentence per event. */
function say(text) {
  const node = $('#minesSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintBoard();
  paintControls();
  paintGraphics();
  field?.setActive(inPlay() && !busy);
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#minesView', root), { disabled: Boolean(busy) });
  const select = root && $('#minesGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = field?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
  select.disabled = inPlay() || busy;
}

function paintBoard() {
  const board = $('#minesBoard', root);
  const over = game?.status === 'settled';
  const mines = new Set(over ? game.mineTiles : []);
  const revealed = new Set(game?.revealed || []);
  board.dataset.state = inPlay() ? 'play' : over ? 'over' : 'idle';
  for (let index = 0; index < TILES; index += 1) {
    const node = tileNode(index);
    let kind = 'hidden';
    if (revealed.has(index)) kind = 'gem';
    else if (over && game.mineHit === index) kind = 'boom';
    else if (over && mines.has(index)) kind = 'tnt';
    else if (over) kind = 'dim-gem';
    if (node.dataset.kind !== kind) {
      node.dataset.kind = kind;
      const img = node.querySelector('img');
      if (kind === 'hidden') {
        img.hidden = true;
      } else {
        img.hidden = false;
        img.src = kind === 'tnt' || kind === 'boom' ? 'assets/img/items/tnt.png' : 'assets/img/items/diamond.png';
      }
    }
    const row = Math.floor(index / 5) + 1;
    const col = (index % 5) + 1;
    const what = kind === 'hidden' ? 'hidden' : kind === 'gem' ? 'diamond' : kind === 'boom' ? 'TNT, hit' : kind === 'tnt' ? 'TNT' : 'diamond, not turned';
    node.setAttribute('aria-label', `Row ${row}, column ${col}: ${what}`);
    /* aria-disabled, not disabled, while the game runs: a disabled button cannot take focus, and
     * the arrow keys have to be able to cross a tile that is already turned. */
    node.disabled = !inPlay();
    node.setAttribute('aria-disabled', String(!inPlay() || kind !== 'hidden' || busy));
    node.setAttribute('aria-busy', String(pressed === index));
    node.tabIndex = index === focusTile ? 0 : -1;
  }

  /* A win only: the multiplier and what it paid. A loss says itself in the red tile. */
  const banner = $('#minesBanner', root);
  if (over && game.outcome === 'cashout') {
    banner.hidden = false;
    banner.dataset.tone = 'won';
    $('b', banner).textContent = times(game.multiplierBps);
    $('span', banner).textContent = money(Number(game.payoutMinor || '0'));
  } else {
    banner.hidden = true;
  }
}

/** The panel's profit so far, while a game runs: what cashing out now would add, at what multiplier. */
function paintProfit() {
  const row = $('#minesProfitRow', root);
  const show = inPlay();
  row.hidden = !show;
  if (!show) return;
  const found = game.revealed.length;
  const profit = found ? BigInt(game.cashoutMinor) - BigInt(game.stakeMinor) : 0n;
  $('#minesProfitX', root).textContent = times(found ? game.multiplierBps : 10_000);
  $('#minesProfit', root).value = `${money(Number(profit))}`;
}

function paintControls() {
  const go = $('#minesGo', root);
  const label = $('#minesGoLabel', root);
  const hint = $('#minesHint', root);
  let text = '';
  let tone = 'go';
  let disabled = false;
  if (!state.authenticated) {
    text = 'Log in to play';
  } else if (inPlay()) {
    const found = game.revealed.length;
    if (pressed === 'cashout') { text = 'Cashing out…'; tone = 'cash'; disabled = true; }
    else if (found === 0) { text = 'Pick a tile'; tone = 'idle'; disabled = true; }
    else { text = `Cash out ${money(Number(game.cashoutMinor))}`; tone = 'cash'; disabled = busy; }
  } else if (pressed === 'start') {
    text = 'Starting…';
    disabled = true;
  } else {
    const problem = startProblem();
    text = `${game?.status === 'settled' ? 'Play again' : 'Start'} · ${money(Number(stakeMinor() ?? 0n))}`;
    disabled = Boolean(problem) || busy;
  }
  if (label.textContent !== text) label.textContent = text;
  go.dataset.tone = tone;
  go.disabled = disabled;
  go.setAttribute('aria-busy', String(pressed === 'start' || pressed === 'cashout'));
  hint.textContent = state.authenticated && !inPlay() ? startProblem() : '';

  $('#minesRandom', root).hidden = !inPlay();
  $('#minesRandom', root).disabled = busy;
  paintProfit();
  const locked = inPlay() || busy;
  for (const node of root.querySelectorAll('.mines__form input, .mines__form .mines__adj, .mines__form .mines__pick, .mines__step')) {
    node.disabled = locked;
  }
  $('#minesCount', root).textContent = String(mineCount);
  root.querySelectorAll('.mines__pick[data-mines]').forEach((pick) => {
    pick.setAttribute('aria-pressed', String(Number(pick.dataset.mines) === mineCount));
  });
}

/* ─────────── building ─────────── */

function build() {
  const tiles = Array.from({ length: TILES }, (_, index) =>
    `<button type="button" class="mtile" data-tile="${index}" data-kind="hidden" data-sfx="none" tabindex="-1"><img alt="" hidden draggable="false" /></button>`,
  ).join('');
  root.innerHTML = `
    <section class="mines__stage" aria-label="The field">
      <div class="mines__pit">
        <div class="mines__board" id="minesBoard" role="group" aria-label="Twenty-five tiles, use the arrow keys to move and Enter to turn a tile">
          ${tiles}
        </div>
        <div class="mines__banner" id="minesBanner" hidden><b></b><span></span></div>
      </div>
    </section>

    <aside class="mines__panel" aria-label="Your game">
      <form class="mines__form" id="minesForm" novalidate>
        <label class="mines__label" for="minesStake">Stake</label>
        <div class="mines__field">
          <span aria-hidden="true">$</span>
          <input id="minesStake" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off" spellcheck="false" />
          <button type="button" class="mines__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="mines__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="mines__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
        </div>
        <span class="mines__label" id="minesCountLabel">TNT in the field</span>
        <div class="mines__stepper" role="group" aria-labelledby="minesCountLabel">
          <button type="button" class="mines__step" data-step="-1" aria-label="One less TNT">−</button>
          <output id="minesCount" aria-live="off">3</output>
          <button type="button" class="mines__step" data-step="1" aria-label="One more TNT">+</button>
        </div>
        <div class="mines__picks" role="group" aria-label="Quick TNT counts">
          ${QUICK_MINES.map((count) => `<button type="button" class="mines__pick" data-mines="${count}" aria-pressed="false">${count}</button>`).join('')}
        </div>
        <div class="mines__profit" id="minesProfitRow" hidden>
          <label class="mines__label mines__label--row" for="minesProfit"><span>Total profit</span><span class="mines__profitx" id="minesProfitX"></span></label>
          <div class="mines__field mines__field--read"><output id="minesProfit" for="minesStake">$0</output></div>
        </div>
        <button class="btn mines__go" id="minesGo" type="submit" data-tone="go">
          <span id="minesGoLabel">Loading…</span>
        </button>
        <button class="mines__random" id="minesRandom" type="button" hidden>Random tile</button>
        <p class="mines__hint" id="minesHint" aria-live="polite"></p>
        ${viewSwitch('minesView')}
        <label class="mines__gfx" for="minesGfx">
          <span>Graphics</span>
          <select id="minesGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="mines__say" id="minesSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#minesStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.mines__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(adjustStake(button.dataset.adj, current, state.balanceMinor, config?.maxStakeMinor)));
    stake.value = stakeText;
    paint();
  }));
  root.querySelectorAll('.mines__step').forEach((button) => button.addEventListener('click', () => {
    mineCount = Math.min(24, Math.max(1, mineCount + Number(button.dataset.step)));
    paint();
  }));
  root.querySelectorAll('.mines__pick').forEach((button) => button.addEventListener('click', () => {
    mineCount = Number(button.dataset.mines);
    paint();
  }));
  $('#minesForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (inPlay()) void cashOut();
    else void start();
  });
  $('#minesRandom', root).addEventListener('click', randomTile);
  $('#minesGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#minesView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });

  const board = $('#minesBoard', root);
  board.addEventListener('click', (event) => {
    const tile = event.target.closest('.mtile');
    if (!tile || tile.disabled || tile.getAttribute('aria-disabled') === 'true') return;
    focusTile = Number(tile.dataset.tile);
    void reveal(focusTile);
  });
  /* One tab stop for the whole field; the arrow keys move between tiles, Enter or Space turns one. */
  board.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const index = focusTile + moves[event.key];
    const sameRow = Math.floor(index / 5) === Math.floor(focusTile / 5);
    if (index < 0 || index >= TILES || (Math.abs(moves[event.key]) === 1 && !sameRow)) return;
    focusTile = index;
    paintBoard();
    tileNode(index)?.focus();
  });
  // The keyboard's place on the field, shown in the cave as a white outline.
  board.addEventListener('focusin', (event) => {
    const tile = event.target.closest('.mtile');
    if (tile?.matches(':focus-visible')) field?.setFocus(Number(tile.dataset.tile));
  });
  board.addEventListener('focusout', () => field?.setFocus(-1));
}

export function mountMines(section) {
  view = section;
  root = $('#minesRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments a game in play can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        game = null;
        seedHash = null;
        field?.reset(false);
      }
      if (!busy) paint();
    });
  }
  // A scene still to be built comes up behind the loading screen, not after the flat board.
  if (!fieldTried) sceneLoading(root, $('.mines__pit', root));
  void load();
}
