/* chicken.js — a chicken, twenty minecart rails, and the nerve to keep walking.
 *
 * The server owns the road. It decides which lane the minecart comes down when the run starts, from
 * the player's committed fairness seed, and never tells this page until the run is over; every step
 * is a request, and the answer is either the next lane or the end. This page shows what it is told,
 * prices every lane before it is crossed (each lane carries the multiplier for reaching it), and
 * keeps the buttons in step with the run: Start, then Go and Cash out, then the result.
 *
 * The road scrolls inside its own box and follows the chicken; the page itself never scrolls
 * sideways. Motion is two things: the chicken's hop to the next lane, and the minecart coming down
 * on a hit. With reduced motion both become an instant change of state.
 *
 * The road is drawn in WebGL (chicken3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage: rail lines across a meadow, a sign at each with what it pays, the chicken
 * hopping over them. The flat road stays under it, out of sight, for a screen reader, and comes back
 * whole without WebGL.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, refreshBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, setWants3d, viewSwitch, wants3d } from './view3d.js';

const LANES = 20;
const EDGE_BPS = 1000n;
/* Mirrors lib/chicken.ts, so the road can price a mode before the server has answered. The server's
 * own figures replace these the moment a run exists. */
const MODES = {
  easy: { hit: 1, of: 6, label: 'Easy' },
  medium: { hit: 1, of: 4, label: 'Medium' },
  hard: { hit: 1, of: 3, label: 'Hard' },
  hardcore: { hit: 1, of: 2, label: 'Hardcore' },
};
const MODE_NAMES = Object.keys(MODES);
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

let root = null;
let config = null;
let seedHash = null;
let game = null; // the active or last-finished run, as the server described it
let busy = false;
let pressed = null; // 'start' | 'step' | 'cashout'
let stakeText = '1m';
let mode = 'easy';
let road3d = null; // the meadow, once it is up
let roadTried = null;

/* ─────────── the maths, mirrored from lib/chicken.ts ─────────── */

/** The multiplier, in basis points, for cashing out after `crossed` lanes. */
function multiplierBps(name, crossed) {
  const { hit, of } = MODES[name];
  const num = BigInt(of) ** BigInt(crossed);
  const den = BigInt(of - hit) ** BigInt(crossed);
  return Number(((10_000n - EDGE_BPS) * num) / den);
}

/* Whole numbers past 1,000x, so a lane keeps its width: "2,992×", not "2992.73×". */
function times(bps) {
  const value = Math.floor(bps / 100) / 100;
  return value >= 1000 ? `${Math.floor(value).toLocaleString('en-US')}×` : `${value.toFixed(2)}×`;
}

/* ─────────── state ─────────── */

const inPlay = () => game?.status === 'active';
const over = () => game?.status === 'settled';
/** The mode on the road: the run's while there is one, the player's choice otherwise. */
const roadMode = () => (game ? game.mode : mode);

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function startProblem() {
  if (!config) return 'Chicken is not answering';
  if (!config.enabled) return 'Chicken is closed right now';
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
    config = await api.get('/v1/chicken/config');
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
  follow(false);
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

/** Puts a run the server knows about back on the road. */
async function reload() {
  try {
    const { game: active } = await api.get('/v1/chicken/games/active');
    if (active) {
      game = active;
      mode = active.mode;
    } else if (inPlay()) {
      game = null;
    }
  } catch {
    /* A failed read leaves the road as it was; the next action will say what is wrong. */
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
      '/v1/chicken/games',
      { stakeMinor: stakeMinor().toString(), mode, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    game = response.game;
    road3d?.reset();
    playSound('click');
    say(`Run started on ${MODES[mode].label}. Lane 1 pays ${times(game.nextMultiplierBps)}.`);
    await refreshSeed();
  } catch (error) {
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    if (error?.code === 'GAME_IN_PLAY') {
      await reload();
      toast({ kind: 'gold', title: 'Chicken', body: 'Your run in play is back on the road.' });
    } else {
      toast({ kind: 'lose', title: 'Chicken', body: error?.message || 'That run did not start' });
    }
  } finally {
    busy = false;
    pressed = null;
    void refreshBalance();
    paint();
    follow(true);
  }
}

async function step() {
  if (busy || !inPlay()) return;
  const lane = game.crossed;
  busy = true;
  pressed = 'step';
  paint();
  try {
    const response = await api.post(`/v1/chicken/games/${game.id}/step`, { lane });
    game = response.game;
    if (road3d) await road3d.step(lane, game.outcome === 'hit');
    if (game.outcome === 'hit') {
      paint();
      follow(true);
      hit(lane);
      say(`A minecart on lane ${lane + 1}. You lost ${money(Number(game.stakeMinor))}.`);
    } else {
      paint();
      follow(true);
      hop();
      if (over()) {
        finished();
      } else {
        say(`Lane ${lane + 1} crossed. Cash out now for ${money(Number(game.cashoutMinor))}, or go on to lane ${lane + 2}.`);
      }
    }
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Chicken', body: error?.message || 'That step did not go through' });
  } finally {
    busy = false;
    pressed = null;
    if (over()) void refreshBalance();
    paint();
  }
}

async function cashOut() {
  if (busy || !inPlay() || game.crossed === 0) return;
  busy = true;
  pressed = 'cashout';
  paint();
  try {
    const response = await api.post(`/v1/chicken/games/${game.id}/cashout`, { crossed: game.crossed });
    game = response.game;
    finished();
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Chicken', body: error?.message || 'That cash-out did not go through' });
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
  road3d?.celebrate(game.multiplierBps);
  const across = game.crossed === LANES ? ' from the far side' : '';
  say(`Cashed out${across} at ${times(game.multiplierBps)} for ${money(Number(game.payoutMinor))}.`);
}

/* ─────────── motion ─────────── */

function laneNode(lane) {
  return root?.querySelector(`.clane[data-lane="${lane}"]`);
}

/** Where the chicken stands: the last lane crossed, or the starting curb. */
function standingNode() {
  const crossed = game?.crossed ?? 0;
  return crossed > 0 ? laneNode(crossed - 1) : root?.querySelector('.clane--start');
}

/** Keeps the chicken in view inside the road's own scroller, about a third of the way in. */
function follow(animate) {
  const road = $('#chickenRoad', root);
  const node = standingNode();
  if (!road || !node) return;
  const target = Math.max(0, node.offsetLeft - road.clientWidth * 0.3);
  road.scrollTo({ left: target, behavior: animate && !reduceMotion() ? 'smooth' : 'auto' });
}

function hop() {
  playSound('tick');
  if (reduceMotion()) return;
  $('#chickenHen img', root)?.animate(
    [{ transform: 'translateY(0)' }, { transform: 'translateY(-16px)', offset: 0.45 }, { transform: 'translateY(0)' }],
    { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}

function hit(lane) {
  playSound('slam');
  try { navigator.vibrate?.(60); } catch { /* not every browser lets a page vibrate */ }
  if (reduceMotion()) return;
  const cart = $('#chickenCart', root);
  const track = $('.chicken__track', root);
  if (!cart || !track) return;
  cart.animate(
    [{ transform: `${cart.style.transform} translateY(-${track.clientHeight}px)` }, { transform: cart.style.transform }],
    { duration: 300, easing: 'cubic-bezier(.4, 0, 1, 1)' },
  );
  laneNode(lane)?.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
    { duration: 300, delay: 280, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}

/* One polite, whole sentence per event. */
function say(text) {
  const node = $('#chickenSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintRoad();
  paintReadout();
  paintControls();
  paintGraphics();
  syncRoad();
}

/* ─────────── the meadow ─────────── */

function startRoad() {
  if (roadTried || !wants3d()) return roadTried;
  roadTried = (async () => {
    const host = $('.chicken__view', root);
    try {
      const { createChicken3d } = await import('./chicken3d.js');
      const built = await createChicken3d(host);
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        roadTried = null;
        return;
      }
      if (!built) {
        // No WebGL here: the flat road is all there is, and its graphics have nothing to choose.
        $('.chicken__gfx', root).hidden = true;
        return;
      }
      built.onLost = () => {
        if (road3d === built) road3d = null;
        built.dispose();
        root.dataset.render = '2d';
        paint();
        follow(false);
      };
      built.onCue = (cue) => {
        if (cue === 'hop') playSound('tick');
        else if (cue === 'cart') playSound('boost');
        else if (cue === 'hit') {
          playSound('slam');
          try { navigator.vibrate?.(60); } catch { /* not every browser lets a page vibrate */ }
        } else if (cue === 'egg') playSound('coin');
      };
      road3d = built;
      root.dataset.render = '3d';
      syncRoad();
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    }
  })();
  return roadTried;
}

/** The meadow as the run stands: how far, what every line pays, and how it ended. */
function syncRoad() {
  if (!road3d) return;
  const name = roadMode();
  road3d.sync({
    crossed: game?.crossed ?? 0,
    // The game's font has no multiplication sign: a plain x, as a sign written in the game would read.
    labels: Array.from({ length: LANES }, (_, lane) => times(multiplierBps(name, lane + 1)).replace('×', 'x')),
    over: over(),
    outcome: game?.outcome ?? null,
    cartLane: over() ? game.cartLane : null,
  });
}

function setGraphics(value) {
  if (busy || inPlay() || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (road3d) {
    road3d.dispose();
    road3d = null;
    roadTried = null;
    root.dataset.render = '2d';
    void startRoad();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the road away for the flat board, 3D builds it again. */
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
  if (!on && road3d) {
    road3d.dispose();
    road3d = null;
    roadTried = null;
    root.dataset.render = '2d';
  }
  if (on) void startRoad();
  paintGraphics();
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#chickenView', root), { disabled: Boolean(busy) });
  const select = root && $('#chickenGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = road3d?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
  select.disabled = inPlay() || busy;
}

/** Puts a sprite over the middle of a lane, at the height the stylesheet gives it. */
function placeOver(sprite, node) {
  if (!sprite || !node) return;
  const x = node.offsetLeft + node.offsetWidth / 2;
  sprite.style.transform = `translateX(${Math.round(x)}px) translateX(-50%)`;
}

function paintRoad() {
  const track = $('.chicken__track', root);
  const name = roadMode();
  const crossed = game?.crossed ?? 0;
  const cart = over() ? game.cartLane : null;
  track.dataset.state = inPlay() ? 'play' : over() ? 'over' : 'idle';
  track.dataset.outcome = game?.outcome ?? '';

  for (let lane = 0; lane < LANES; lane += 1) {
    const node = laneNode(lane);
    let laneState = 'ahead';
    if (game && lane < crossed) laneState = 'done';
    else if (inPlay() && lane === crossed) laneState = 'next';
    if (over() && cart === lane) laneState = game.outcome === 'hit' ? 'hit' : 'cart';
    node.dataset.state = laneState;
    const pays = times(multiplierBps(name, lane + 1));
    const label = $('.clane__x', node);
    if (label.textContent !== pays) label.textContent = pays;
    const what = {
      ahead: `pays ${pays}`,
      next: `next, pays ${pays}`,
      done: 'crossed',
      hit: 'the minecart came down here',
      cart: 'the minecart was here',
    }[laneState];
    node.setAttribute('aria-label', `Lane ${lane + 1}: ${what}`);
  }

  const hen = $('#chickenHen', root);
  hen.dataset.state = over() && game.outcome === 'hit' ? 'hit' : over() ? 'safe' : 'walk';
  placeOver(hen, standingNode() ?? root.querySelector('.clane--start'));
  if (over() && game.outcome === 'hit') placeOver(hen, laneNode(game.cartLane));

  const cartNode = $('#chickenCart', root);
  cartNode.hidden = !(over() && cart !== null && cart !== undefined);
  if (!cartNode.hidden) placeOver(cartNode, laneNode(cart));
  cartNode.dataset.tone = game?.outcome === 'hit' ? 'hit' : 'reveal';

  const banner = $('#chickenBanner', root);
  if (over()) {
    const won = game.outcome === 'cashout';
    const profit = BigInt(game.payoutMinor || '0') - BigInt(game.stakeMinor);
    banner.hidden = false;
    banner.dataset.tone = won ? 'won' : 'lost';
    $('b', banner).textContent = won ? times(game.multiplierBps) : 'Minecart';
    $('span', banner).textContent = won
      ? `${profit >= 0n ? '+' : '−'}${money(Number(profit >= 0n ? profit : -profit))}`
      : `−${money(Number(game.stakeMinor))}`;
  } else {
    banner.hidden = true;
  }
}

function paintReadout() {
  const now = $('#chickenNow', root);
  const next = $('#chickenNext', root);
  const name = roadMode();
  const { hit, of } = MODES[name];
  const safePct = `${Math.round(((of - hit) / of) * 100)}% clear`;
  if (inPlay()) {
    now.textContent = game.crossed
      ? `${times(game.multiplierBps)} · ${money(Number(game.cashoutMinor))}`
      : 'On the curb · step onto lane 1';
    next.textContent = game.nextMultiplierBps ? `Lane ${game.crossed + 1} pays ${times(game.nextMultiplierBps)} · ${safePct}` : '';
  } else {
    now.textContent = `${MODES[name].label} · a minecart 1 lane in ${of}`;
    next.textContent = `Lane ${LANES} pays ${times(multiplierBps(name, LANES))}`;
  }
}

function paintControls() {
  const go = $('#chickenGo', root);
  const label = $('#chickenGoLabel', root);
  const cash = $('#chickenCash', root);
  const hint = $('#chickenHint', root);
  let text = '';
  let disabled = false;
  if (!state.authenticated) {
    text = 'Log in to play';
  } else if (inPlay()) {
    text = `Go · ${times(game.nextMultiplierBps ?? 0)}`;
    disabled = busy;
  } else if (pressed === 'start') {
    text = 'Starting…';
    disabled = true;
  } else {
    text = `${over() ? 'Play again' : 'Start'} · ${money(Number(stakeMinor() ?? 0n))}`;
    disabled = Boolean(startProblem()) || busy;
  }
  if (label.textContent !== text) label.textContent = text;
  go.disabled = disabled;
  go.setAttribute('aria-busy', String(pressed === 'start' || pressed === 'step'));

  cash.hidden = !inPlay();
  if (inPlay()) {
    const crossed = game.crossed;
    cash.textContent = pressed === 'cashout'
      ? 'Cashing out…'
      : crossed ? `Cash out ${money(Number(game.cashoutMinor))}` : 'Cross a lane to cash out';
    cash.disabled = busy || crossed === 0;
    cash.setAttribute('aria-busy', String(pressed === 'cashout'));
  }
  hint.textContent = state.authenticated && !inPlay() ? startProblem() : '';

  const locked = inPlay() || busy;
  for (const node of root.querySelectorAll('.chicken__form input, .chicken__form .chicken__adj, .chicken__mode')) {
    node.disabled = locked;
  }
  const name = roadMode();
  root.querySelectorAll('.chicken__mode').forEach((button) => {
    const chosen = button.dataset.mode === name;
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  });
}

/* ─────────── building ─────────── */

function chooseMode(name) {
  if (!MODES[name] || inPlay() || busy) return;
  mode = name;
  // A finished run on another mode would be a road the stake field no longer describes.
  if (over() && game.mode !== name) game = null;
  paint();
  follow(false);
}

function build() {
  const lanes = Array.from({ length: LANES }, (_, lane) =>
    `<div class="clane" data-lane="${lane}" data-state="ahead" role="listitem"><span class="clane__x" aria-hidden="true"></span></div>`,
  ).join('');
  root.innerHTML = `
    <section class="chicken__stage" aria-label="The rails">
      <div class="chicken__readout">
        <b id="chickenNow">—</b>
        <span id="chickenNext"></span>
      </div>
      <div class="chicken__view" aria-hidden="true"></div>
      <div class="chicken__road" id="chickenRoad" tabindex="0" aria-label="Twenty lanes of rails, crossed left to right">
        <div class="chicken__track" role="list">
          <div class="clane clane--start" role="listitem" aria-label="The starting curb"></div>
          ${lanes}
          <div class="clane clane--end" role="listitem" aria-label="The far side"></div>
          <div class="chicken__hen" id="chickenHen" aria-hidden="true"><img src="assets/img/items/chicken.svg" alt="" draggable="false" /></div>
          <img class="chicken__cart" id="chickenCart" src="assets/img/items/minecart.png" alt="" draggable="false" hidden />
        </div>
      </div>
      <div class="chicken__banner" id="chickenBanner" hidden><b></b><span></span></div>
    </section>

    <aside class="chicken__panel" aria-label="Your run">
      <form class="chicken__form" id="chickenForm" novalidate>
        <label class="chicken__label" for="chickenStake">Stake</label>
        <div class="chicken__field">
          <span aria-hidden="true">$</span>
          <input id="chickenStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="chicken__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="chicken__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="chicken__label" id="chickenModeLabel">Difficulty</span>
        <div class="chicken__modes" role="radiogroup" aria-labelledby="chickenModeLabel">
          ${MODE_NAMES.map((name) => `<button type="button" class="chicken__mode" role="radio" data-mode="${name}" aria-checked="false">${MODES[name].label}</button>`).join('')}
        </div>
        <button class="btn chicken__go" id="chickenGo" type="submit" data-tone="go">
          <span id="chickenGoLabel">Loading…</span>
        </button>
        <button class="chicken__cash" id="chickenCash" type="button" hidden>Cash out</button>
        <p class="chicken__hint" id="chickenHint" aria-live="polite"></p>
        ${viewSwitch('chickenView')}
        <label class="chicken__gfx" for="chickenGfx">
          <span>Graphics</span>
          <select id="chickenGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="chicken__say" id="chickenSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#chickenStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.chicken__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paint();
  }));

  const modes = $('.chicken__modes', root);
  modes.addEventListener('click', (event) => {
    const button = event.target.closest('.chicken__mode');
    if (button) chooseMode(button.dataset.mode);
  });
  /* A radio group: one tab stop, the arrows move the choice. */
  modes.addEventListener('keydown', (event) => {
    const move = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!move || inPlay() || busy) return;
    event.preventDefault();
    const index = (MODE_NAMES.indexOf(mode) + move + MODE_NAMES.length) % MODE_NAMES.length;
    chooseMode(MODE_NAMES[index]);
    modes.querySelector(`[data-mode="${mode}"]`)?.focus();
  });

  // Enter or the gold button: start a run, or take the next step of one.
  $('#chickenForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (inPlay()) void step();
    else void start();
  });
  $('#chickenCash', root).addEventListener('click', () => void cashOut());
  $('#chickenGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#chickenView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  // The lanes' positions move with the layout; keep the sprites over them.
  window.addEventListener('resize', () => { if (root?.isConnected) { paintRoad(); follow(false); } });
}

export function mountChicken(section) {
  root = $('#chickenRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments a run in play can first be asked for. */
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
  void startRoad();
}
