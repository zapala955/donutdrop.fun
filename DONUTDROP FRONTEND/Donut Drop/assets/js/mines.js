/* mines.js — twenty-five blocks, some of them TNT, and the nerve to keep turning them.
 *
 * The server owns the field. It places the TNT when the game starts, from the player's committed
 * fairness seed, and never tells this page where it is until the game is over; every tile turned
 * is a request, and the answer is either a diamond or the end. This page shows what it is told,
 * prices the next tile honestly before it is turned, and keeps the one button in step with the
 * game: Start, then Cash out, then the result.
 *
 * Motion is two things: a diamond settling into its block, and the TNT going off. With reduced
 * motion both become an instant change of state, and nothing shakes.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, refreshBalance, state } from './store.js';
import { $, el, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const TILES = 25;
const QUICK_MINES = [1, 3, 5, 10, 24];
const EDGE_BPS = 1000n;

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

/* ─────────── the maths, mirrored from lib/mines.ts ─────────── */

/** The multiplier, in basis points, for cashing out after `revealed` diamonds. */
function multiplierBps(mines, revealed) {
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < revealed; i += 1) {
    num *= BigInt(TILES - i);
    den *= BigInt(TILES - mines - i);
  }
  return Number(((10_000n - EDGE_BPS) * num) / den);
}

const times = (bps) => `${(Math.floor(bps / 100) / 100).toFixed(2)}×`;
const pct = (bps) => `${Math.round(bps / 100)}%`;

function safeChanceBps(mines, revealed) {
  const hidden = TILES - revealed;
  const safeLeft = TILES - mines - revealed;
  return hidden > 0 && safeLeft > 0 ? Math.floor((safeLeft * 10_000) / hidden) : 0;
}

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
    if (!seedHash) await refreshSeed();
    const response = await api.post(
      '/v1/mines/games',
      { stakeMinor: stakeMinor().toString(), mines: mineCount, clientSeed: clientSeed(), serverSeedHash: seedHash },
      { idempotencyKey: idempotencyKey() },
    );
    game = response.game;
    focusTile = 12;
    playSound('click');
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
  paint();
  try {
    const response = await api.post(`/v1/mines/games/${game.id}/reveal`, {
      tile,
      revealedCount: game.revealed.length,
    });
    const before = game.revealed.length;
    game = response.game;
    if (game.outcome === 'mine') {
      boom(tile);
      say(`TNT. You lost ${money(Number(game.stakeMinor))}.`);
    } else {
      gem(tile);
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
  playSound('win');
  say(`Cashed out at ${times(game.multiplierBps)} for ${money(Number(game.payoutMinor))}.`);
}

function randomTile() {
  if (!inPlay()) return;
  const hidden = [];
  for (let tile = 0; tile < TILES; tile += 1) if (!game.revealed.includes(tile)) hidden.push(tile);
  if (hidden.length) void reveal(hidden[Math.floor(Math.random() * hidden.length)]);
}

/* ─────────── motion ─────────── */

function tileNode(index) {
  return root?.querySelector(`.mtile[data-tile="${index}"]`);
}

function gem(index) {
  playSound('tick');
  const node = tileNode(index);
  if (!node || reduceMotion()) return;
  node.querySelector('img')?.animate(
    [{ transform: 'scale(.4) rotate(-12deg)', opacity: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)' }],
    { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
}

function boom(index) {
  playSound('slam');
  try { navigator.vibrate?.(60); } catch { /* not every browser lets a page vibrate */ }
  if (reduceMotion()) return;
  tileNode(index)?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: 0.3 }, { transform: 'scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
  $('.mines__board', root)?.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' },
      { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
    { duration: 340, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
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
  paintReadout();
  paintControls();
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

  const banner = $('#minesBanner', root);
  if (over) {
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
  const now = $('#minesNow', root);
  const next = $('#minesNext', root);
  if (inPlay()) {
    const found = game.revealed.length;
    now.textContent = found
      ? `${times(game.multiplierBps)} · ${money(Number(game.cashoutMinor))}`
      : `${game.mines} TNT · pick a tile`;
    next.textContent = game.nextMultiplierBps
      ? `Next diamond ${times(game.nextMultiplierBps)} · ${pct(game.nextSafeChanceBps)} safe`
      : '';
  } else {
    const safe = TILES - mineCount;
    now.textContent = `${mineCount} TNT · ${safe} diamonds`;
    next.textContent = `First diamond ${times(multiplierBps(mineCount, 1))} · ${pct(safeChanceBps(mineCount, 0))} safe`;
  }
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
    `<button type="button" class="mtile" data-tile="${index}" data-kind="hidden" tabindex="-1"><img alt="" hidden draggable="false" /></button>`,
  ).join('');
  root.innerHTML = `
    <section class="mines__stage" aria-label="The field">
      <div class="mines__readout">
        <b id="minesNow">—</b>
        <span id="minesNext"></span>
      </div>
      <div class="mines__board" id="minesBoard" role="group" aria-label="Twenty-five tiles, use the arrow keys to move and Enter to turn a tile">
        ${tiles}
        <div class="mines__banner" id="minesBanner" hidden><b></b><span></span></div>
      </div>
    </section>

    <aside class="mines__panel" aria-label="Your game">
      <form class="mines__form" id="minesForm" novalidate>
        <label class="mines__label" for="minesStake">Stake</label>
        <div class="mines__field">
          <span aria-hidden="true">$</span>
          <input id="minesStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="mines__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="mines__adj" data-adj="double" aria-label="Double the stake">2×</button>
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
        <button class="btn mines__go" id="minesGo" type="submit" data-tone="go">
          <span id="minesGoLabel">Loading…</span>
        </button>
        <button class="mines__random" id="minesRandom" type="button" hidden>Random tile</button>
        <p class="mines__hint" id="minesHint" aria-live="polite"></p>
      </form>
    </aside>
    <div class="mines__say" id="minesSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#minesStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.mines__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
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
      }
      if (!busy) paint();
    });
  }
  void load();
}
