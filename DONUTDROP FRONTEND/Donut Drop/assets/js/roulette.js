/* roulette.js — one server-owned European wheel shared by every browser.
 *
 * The wheel is drawn in WebGL (roulette3d.js), its own chunk, at the graphics the player picked or
 * the machine can manage: a fire charge on a wheel in a Nether fortress, blazes watching. This page
 * still says which pocket and how long; the 3D wheel only runs the ball there. Without WebGL the flat
 * wheel turns as it always has.
 *
 * The flat table (2026-11-09): a real layout -- 0 down the left, the numbers in three rows of
 * twelve, the dozens and the even-money bets under them; on a phone the vertical table, 0 across
 * the top and the numbers three to a row. Your chips sit on the spots as chips. A countdown bar
 * says how long betting has left. The wheel's hub takes the colour of the pocket it landed on, a
 * win pops a card over the wheel that counts up, and nothing toasts: the chip on the board is the
 * confirmation, the hub and the card are the result. Its own sounds: a chip clacking down, the
 * ball rattling round and dropping, and a win.
 *
 * The flat wheel is a roulette wheel, not a prize wheel: no pointer, a ball. The wheel turns
 * clockwise; the ball is launched round the track outside the pockets the other way, slows, falls
 * in, skips over a few frets, and is caught by the winning pocket and rides it to the top as the
 * wheel stops (rollBall). It reads where the pocket really is from the wheel's own transform every
 * frame, so it lands where the server said whatever the frame rate. */
import { api, idempotencyKey } from './api.js';
import { state, refreshBalance, holdLiveFigures, showBalance } from './store.js';
import { onNavigate } from './routing.js';
import { tableAvatar } from './table-avatar.js';
import { linkPlayer } from './player-link.js';
import { $, money, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, sceneLoaded, sceneLoading, setWants3d, viewSwitch, wants3d } from './view3d.js';

const ORDER = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]);
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
// Live invalidations are the normal path. A slow poll repairs missed events; old browsers without
// EventSource use a faster fallback and are still subject to the freshness lock below.
const LIVE_SUPPORTED = 'EventSource' in window;
const POLL_MS = LIVE_SUPPORTED ? 15_000 : 2_500;
const LIVE_STALE_MS = 6_000;
/* The floor on how long a snapshot stays trustworthy without the event stream.
 *
 * It has to cover the longest gap the deadline chain can leave, which is a whole betting window:
 * the client refreshes when the round opens and again when it closes, and nothing happens in
 * between because nothing CAN happen in between. A fixed 4.5s here locked betting four seconds
 * into every ten-second round on any browser whose event stream was not delivering. The real
 * window is read from the round the server published. */
const POLL_STALE_FLOOR_MS = 4_500;
const CHIPS = Object.freeze([
  [100_000n, '$100K'],
  [500_000n, '$500K'],
  [1_000_000n, '$1M'],
  [5_000_000n, '$5M'],
  [10_000_000n, '$10M'],
  [50_000_000n, '$50M'],
  [100_000_000n, '$100M'],
  [500_000_000n, '$500M'],
  [1_000_000_000n, '$1B'],
]);
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/* The pop of the hub, a chip and the win card: quick out, a little past, settled. */
const POP_EASE = 'cubic-bezier(.16, 1, .3, 1)';
/* The ball, in fractions of the wheel's width from its centre: running on the track outside the
 * pockets, and resting in a pocket. Both match the rings drawn in roulette.css. */
const BALL_TRACK = 0.462;
const BALL_POCKET = 0.272;
/* How many times it goes round the track against the wheel before it is caught. */
const BALL_TURNS = 3;
const OUTSIDE = Object.freeze([
  ['low', '1–18'],
  ['even', 'Even'],
  ['red', 'Red'],
  ['black', 'Black'],
  ['odd', 'Odd'],
  ['high', '19–36'],
  ['dozen:1', '1st 12'],
  ['dozen:2', '2nd 12'],
  ['dozen:3', '3rd 12'],
]);

let root;
let snapshot;
let selected = 'red';
let amountMinor = 1_000_000n;
let serverOffsetMs = 0;
let polling = false;
let placing = false;
let seenResultId = null;
let pendingResultId = null;
let wheelRotation = 0;
let lastSuccessfulSyncMs = 0;
let lastLivePulseMs = 0;
let deadlineTimer = null;
let spinHold = null;
/* The round this page put chips on. A refresh that left before the chip did comes back without
 * it in `yourBets`; this keeps such a snapshot from letting the hold go a moment too early. */
let chipsRoundId = null;
let wheel3d = null; // the fortress's wheel, once it is up
let wheelTried = null;

export function mountRoulette(view) {
  root = $('#rouletteRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    window.setInterval(() => {
      if (!view.hidden) void refresh();
    }, POLL_MS);
    window.setInterval(paintClock, 100);
    window.addEventListener('donut:roulette', () => {
      if (!view.hidden) void refresh();
    });
    /* Views are hidden, not removed, on navigation, and a hidden table stops refreshing, so it
     * would never see its spin to release the hold. Kept past this point, the hold would freeze
     * the wallet on every other page. */
    onNavigate(() => {
      if (view.hidden && spinHold) {
        releaseSpinHold();
        refreshBalance().catch(() => undefined);
      }
    });
    window.addEventListener('donut:live-status', (event) => {
      if (event.detail?.connected) lastLivePulseMs = Number(event.detail.at) || Date.now();
      else if (event.detail?.supported !== false) lastLivePulseMs = 0;
      paintClock();
      if (event.detail?.connected && !view.hidden) void refresh();
    });
  }
  void refresh();
  void startWheel();
}

/* ─────────── the wheel in 3D ─────────── */

function startWheel() {
  if (wheelTried || !wants3d()) return wheelTried;
  wheelTried = (async () => {
    const host = $('.roulette__wheelwrap', root);
    sceneLoading(root, host);
    try {
      const { createRoulette3d } = await import('./roulette3d.js');
      const built = await createRoulette3d(host, { order: ORDER, red: RED });
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        wheelTried = null;
        return;
      }
      if (!built) {
        // No WebGL here: the flat wheel is all there is, and its graphics have nothing to choose.
        $('.roulette__gfx', root).hidden = true;
        return;
      }
      built.onLost = () => {
        if (wheel3d === built) wheel3d = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onCue = (cue, at) => {
        if (cue === 'bounce') playSound('click', { rate: 1.3 - at * 0.08 });
        else if (cue === 'settle') playSound('tick');
        else if (cue === 'shoot') playSound('boost');
        else if (cue === 'burst') playSound('shatter', { rate: 1.3 });
      };
      wheel3d = built;
      root.dataset.render = '3d';
      const shown = Number($('#rouletteResult', root)?.textContent);
      if (Number.isInteger(shown)) wheel3d.rest(ORDER.indexOf(shown));
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    } finally {
      sceneLoaded(root);
    }
  })();
  return wheelTried;
}

function setGraphics(value) {
  if (!GRAPHICS.some(([id]) => id === value) || value === graphicsPref() || $('#rouletteWheel', root)?.classList.contains('is-spinning')) {
    paintGraphics();
    return;
  }
  setGraphicsPref(value);
  if (wheel3d) {
    wheel3d.dispose();
    wheel3d = null;
    wheelTried = null;
    root.dataset.render = '2d';
    void startWheel();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the wheel away for the flat board, 3D builds it again. */
function setView(on) {
  if ($('#rouletteWheel', root)?.classList.contains('is-spinning')) {
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
  if (!on && wheel3d) {
    wheel3d.dispose();
    wheel3d = null;
    wheelTried = null;
    root.dataset.render = '2d';
  }
  if (on) void startWheel();
  paintGraphics();
}

function paintGraphics() {
  if (root) paintViewSwitch(root, $('#rouletteView', root), { disabled: Boolean($('#rouletteWheel', root)?.classList.contains('is-spinning')) });
  const select = root && $('#rouletteGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = wheel3d?.tier;
  const auto = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  const option = $('option[value="auto"]', select);
  if (option.textContent !== auto) option.textContent = auto;
}

function build() {
  root.innerHTML = `
    <section class="roulette__stage" aria-label="Shared roulette wheel">
      <div class="roulette__roundline">
        <span class="roulette__live"><i></i> Shared table</span>
        <div class="roulette__history" id="rouletteHistory" aria-label="Recent results"></div>
      </div>
      <div class="roulette__wheelwrap">
        <div class="roulette__wheel" id="rouletteWheel" aria-hidden="true"></div>
        <div class="roulette__orbit" id="rouletteOrbit" aria-hidden="true"><span class="roulette__ball" id="rouletteBall"></span></div>
        <div class="roulette__hub" id="rouletteHub" data-color=""><b id="rouletteResult">—</b></div>
        <div class="roulette__win" id="rouletteWin" hidden><span>You won</span><b>$0</b></div>
      </div>
      ${viewSwitch('rouletteView')}
      <label class="roulette__gfx" for="rouletteGfx">
        <span>Graphics</span>
        <select id="rouletteGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
      </label>
    </section>

    <section class="roulette__board">
      <div class="roulette__status">
        <strong id="roulettePhase" role="status" aria-live="polite">Connecting to the table…</strong>
        <span class="roulette__clock mono" id="rouletteClock">—</span>
        <span class="roulette__timer" aria-hidden="true"><i id="rouletteTimerBar"></i></span>
      </div>
      <div class="roulette__felt">
        <div class="roulette__numbers" id="rouletteNumbers"></div>
        <div class="roulette__outside" id="rouletteOutside"></div>
      </div>
      <div class="roulette__slip">
        <div class="roulette__choice">
          <span>Chip</span><strong id="rouletteChipValue">$1M</strong>
          <i class="mono" id="rouletteChoice">Red · 1.85× return</i>
        </div>
        <div class="roulette__chips" id="rouletteChips" aria-label="Choose a chip"></div>
      </div>
      <p class="roulette__limits mono" id="rouletteLimits">Loading table limits…</p>
      <div class="roulette__yours">
        <div class="roulette__subhead"><strong>Your chips this round</strong><span id="rouletteMineTotal">$0</span></div>
        <div class="roulette__bets" id="rouletteBets"><span class="roulette__empty">No chips placed yet.</span></div>
      </div>
      <section class="roulette__livebets" aria-labelledby="rouletteLiveBetsTitle">
        <div class="roulette__subhead">
          <strong id="rouletteLiveBetsTitle">Live bets</strong>
          <span id="rouletteLiveBetCount">0 chips</span>
        </div>
        <div class="roulette__tablewrap">
          <table class="roulette__table">
            <thead><tr><th>Player</th><th>Bet</th><th>Chip</th></tr></thead>
            <tbody id="roulettePublicBets"></tbody>
          </table>
        </div>
      </section>
    </section>`;

  buildWheel();
  const numbers = $('#rouletteNumbers', root);
  for (let value = 0; value <= 36; value += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `roulette__number roulette__number--${color(value)}`;
    button.dataset.selection = `straight:${value}`;
    button.dataset.sfx = 'none';
    /* Where it sits on the table. Desktop: 0 down the left, then twelve columns of three with the
     * multiples of three along the top. Phone: 0 across the top, then rows of three. (roulette.css) */
    if (value === 0) {
      button.dataset.zero = '1';
    } else {
      const column = Math.ceil(value / 3);
      button.style.setProperty('--dc', String(column + 1));
      button.style.setProperty('--dr', String(3 - ((value - 1) % 3)));
      button.style.setProperty('--mc', String(((value - 1) % 3) + 1));
      button.style.setProperty('--mr', String(column + 1));
    }
    /* The label is an element rather than a text node so it can be a flex child that shrinks
       beside the stake chip. A bare text node cannot be given min-width, which is what made the
       first version stack the chip on top of the label instead of under it. */
    const face = document.createElement('span');
    face.className = 'roulette__face';
    face.textContent = String(value);
    button.append(face);
    numbers.append(button);
  }
  const outside = $('#rouletteOutside', root);
  OUTSIDE.forEach(([selection, label], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.selection = selection;
    button.dataset.sfx = 'none';
    button.className = selection.startsWith('dozen:') ? 'roulette__spot roulette__spot--dozen' : 'roulette__spot';
    /* Desktop: the dozens a row under the numbers, four columns each, the even-money bets a row
     * under them, two each. Phone: the dozens three across, the even-money bets three across. */
    if (selection.startsWith('dozen:')) {
      const dozen = Number(selection.slice(6));
      button.style.setProperty('--dc', `${2 + (dozen - 1) * 4} / span 4`);
      button.style.setProperty('--dr', '4');
      button.style.setProperty('--mc', String(dozen));
      button.style.setProperty('--mr', '14');
    } else {
      button.style.setProperty('--dc', `${2 + index * 2} / span 2`);
      button.style.setProperty('--dr', '5');
      button.style.setProperty('--mc', String((index % 3) + 1));
      button.style.setProperty('--mr', String(15 + Math.floor(index / 3)));
    }
    const face = document.createElement('span');
    face.className = 'roulette__face';
    face.textContent = label;
    button.append(face);
    if (selection === 'red' || selection === 'black') button.dataset.color = selection;
    outside.append(button);
  });
  const chips = $('#rouletteChips', root);
  for (const [value, label] of CHIPS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.chip = value.toString();
    button.textContent = label;
    button.setAttribute('aria-label', `${label} chip`);
    chips.append(button);
  }
  root.addEventListener('click', onClick);
  $('#rouletteGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#rouletteView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  syncSelection();
}

function buildWheel() {
  const wheel = $('#rouletteWheel', root);
  const step = 360 / ORDER.length;
  /* Each pocket in its colour, with a thin fret before the next: a pocket wheel's dividers. */
  const fret = 0.45;
  const stops = ORDER.map((number, index) => {
    const start = index * step;
    const end = (index + 1) * step;
    const shade = number === 0 ? '#1f9d5c' : RED.has(number) ? '#c7343c' : '#1c1c22';
    return `${shade} ${start.toFixed(4)}deg ${(end - fret).toFixed(4)}deg, #8d8f97 ${(end - fret).toFixed(4)}deg ${end.toFixed(4)}deg`;
  });
  wheel.style.background = `conic-gradient(from -${step / 2}deg, ${stops.join(',')})`;
  ORDER.forEach((number, index) => {
    const label = document.createElement('span');
    label.textContent = String(number);
    label.style.setProperty('--pocket-angle', `${index * step}deg`);
    wheel.append(label);
  });
}

function onClick(event) {
  const choice = event.target.closest('[data-selection]');
  if (choice && root.contains(choice)) {
    selected = choice.dataset.selection;
    syncSelection();
    void place(selected);
    return;
  }
  const chip = event.target.closest('[data-chip]');
  if (chip && root.contains(chip)) {
    amountMinor = BigInt(chip.dataset.chip);
    syncSelection();
  }
}

function payoutBps() {
  if (!snapshot?.config?.payoutBps) return 0;
  if (selected.startsWith('straight:')) return snapshot.config.payoutBps.straight;
  if (selected.startsWith('dozen:')) return snapshot.config.payoutBps.dozen;
  return snapshot.config.payoutBps.evenMoney;
}

function labelFor(selection) {
  if (selection.startsWith('straight:')) return `Number ${selection.slice(9)}`;
  return OUTSIDE.find(([value]) => value === selection)?.[1] || selection;
}

function syncSelection() {
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.selection === selected);
    button.setAttribute('aria-pressed', button.dataset.selection === selected ? 'true' : 'false');
  });
  const choice = $('#rouletteChoice', root);
  const chipValue = $('#rouletteChipValue', root);
  const multiplier = (payoutBps() / 10_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (choice) choice.textContent = `${labelFor(selected)} · ${multiplier}× return`;
  if (chipValue) chipValue.textContent = money(Number(amountMinor));
  paintControls();
}

/** Everything this player already has riding on the open round. */
function roundStakedMinor() {
  return (snapshot?.yourBets || []).reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
}

/** What is left of the table limit, floored at zero. */
function roundAllowanceMinor() {
  const cap = BigInt(snapshot?.config?.maxRoundStakeMinor || '0');
  if (cap <= 0n) return null;
  const left = cap - roundStakedMinor();
  return left > 0n ? left : 0n;
}

function paintControls() {
  const min = BigInt(snapshot?.config?.minStakeMinor || '0');
  const max = BigInt(snapshot?.config?.maxStakeMinor || '0');
  const allowance = roundAllowanceMinor();
  /* At the table limit the whole board goes dead, not just the chips. A layout that leaves the
     numbers pressable and answers every one of them with the same refusal is a board that looks
     broken; the player has not done anything wrong, they have finished betting this spin. */
  const atLimit = allowance !== null && allowance < min;
  const tableLocked = placing || !isBettingOpen() || !state.authenticated || atLimit;
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.disabled = tableLocked;
  });
  root.querySelectorAll('[data-chip]').forEach((button) => {
    const value = BigInt(button.dataset.chip);
    /* A chip is offered only if it would still fit. The server decides, under a lock; this is
       here so the limit is visible before it is hit rather than arriving as a rejection. */
    const inLimits = value >= min && value <= max && (allowance === null || value <= allowance);
    button.disabled = placing || !snapshot || !inLimits;
    button.classList.toggle('is-selected', value === amountMinor);
    button.setAttribute('aria-pressed', value === amountMinor ? 'true' : 'false');
  });
}

function serverNowMs() {
  return Date.now() + serverOffsetMs;
}

function untilOpenMs() {
  const opens = Date.parse(snapshot?.round?.opensAt || '');
  return Number.isFinite(opens) ? opens - serverNowMs() : 0;
}

function remainingMs() {
  const close = Date.parse(snapshot?.round?.closesAt || '');
  return Number.isFinite(close) ? close - serverNowMs() : 0;
}

function isBettingOpen() {
  return Boolean(snapshot?.round) && connectionFresh() && untilOpenMs() <= 0 && remainingMs() > 0;
}

/**
 * Whether this page is current enough to bet from.
 *
 * EITHER source counts. This used to trust only the event stream whenever the browser HAD an
 * EventSource, which meant a stream that connected and then stopped delivering left
 * `lastLivePulseMs` stale forever — betting locked, permanently, on a page that was refreshing
 * perfectly well over HTTP. A transport nobody can see failing is not a reason to refuse a player
 * who is looking at a live snapshot.
 *
 * Leaning permissive is the safe direction here: the server re-checks the round under a lock and
 * answers a late chip with ROUND_CLOSED, so being too generous costs one rejected bet, while being
 * too strict costs the whole game.
 */
function connectionFresh() {
  if (!lastSuccessfulSyncMs) return false;
  const liveFresh = lastLivePulseMs > 0 && Date.now() - lastLivePulseMs <= LIVE_STALE_MS;
  const window = Math.max(
    POLL_STALE_FLOOR_MS,
    (Number(snapshot?.config?.roundSeconds || 0) + Number(snapshot?.config?.spinSeconds || 0)) *
      1000 +
      3_000,
  );
  const pollFresh = Date.now() - lastSuccessfulSyncMs <= window;
  return liveFresh || pollFresh;
}

/**
 * Refresh exactly when the table is next due to change, rather than hoping a poll lands on it.
 *
 * The round carries its own two deadlines, so the client already knows when the wheel starts and
 * when betting closes. Waiting for a blind interval to rediscover that is how a 15-second poll
 * ended up slower than a 13-second round: miss one live event and the page sits on SETTLING until
 * something else happens to fetch.
 *
 * Two timed requests per round replaces both the old 1.25s poll and the dependence on the event
 * stream — fewer requests than either, and correct on its own if the stream never delivers. Live
 * events still arrive first when they work; this is what makes them an optimisation rather than a
 * requirement.
 */
function scheduleDeadlineRefresh() {
  window.clearTimeout(deadlineTimer);
  if (!root?.isConnected) return;
  const untilOpen = untilOpenMs();
  const untilClose = remainingMs();
  /* +250ms so the request lands just AFTER the server's own boundary rather than racing it into
     an answer that still shows the old round. A rollover in progress retries once a second, which
     is self-limiting: it stops the moment the next round exists. */
  const delay = !snapshot?.round
    ? 5_000
    : untilOpen > 0
      ? untilOpen + 250
      : untilClose > 0
        ? untilClose + 250
        : 1_000;
  deadlineTimer = window.setTimeout(() => {
    void refresh();
  }, Math.max(250, Math.min(delay, 30_000)));
}

function paintPhase() {
  const phase = $('#roulettePhase', root);
  if (!phase) return;
  if (!snapshot) {
    phase.textContent = 'Connecting to the table…';
    return;
  }
  if (!connectionFresh()) {
    phase.textContent = 'Reconnecting… bets are locked';
    return;
  }
  if (!snapshot.round) {
    phase.textContent = snapshot.config?.paused
      ? 'Table paused after the last round'
      : 'Preparing the next round…';
    return;
  }
  if (untilOpenMs() > 0) {
    phase.textContent = 'Wheel spinning · bets are locked';
    return;
  }
  if (remainingMs() <= 0) {
    phase.textContent = 'Round closing · waiting for the result';
    return;
  }
  if (!state.authenticated) {
    phase.textContent = 'Log in to place a chip';
    return;
  }
  phase.textContent = placing
    ? `Placing ${money(Number(amountMinor))}…`
    : 'Place your bets';
}

function paintClock() {
  if (!root?.isConnected) return;
  const untilOpen = Math.max(0, untilOpenMs());
  const remaining = Math.max(0, remainingMs());
  const spinning = Boolean(snapshot) && untilOpen > 0;
  const stale = Boolean(snapshot) && !connectionFresh();
  const clock = $('#rouletteClock', root);
  if (clock) {
    const text = stale
      ? 'Reconnecting'
      : !snapshot?.round && snapshot?.config?.paused
        ? 'Paused'
        : spinning
          ? 'No more bets'
          : remaining > 0
            ? `${(remaining / 1000).toFixed(1)}s`
            : 'Settling';
    if (clock.textContent !== text) clock.textContent = text;
  }
  /* The countdown bar: the betting window draining while it is open, empty otherwise. */
  const bar = $('#rouletteTimerBar', root);
  if (bar) {
    const windowMs = Number(snapshot?.config?.roundSeconds || 0) * 1000;
    const left = !stale && !spinning && windowMs > 0 ? Math.min(1, remaining / windowMs) : 0;
    bar.style.transform = `scaleX(${left.toFixed(4)})`;
  }
  const phase = stale
    ? 'reconnecting'
    : !snapshot?.round
      ? 'paused'
      : spinning
        ? 'spinning'
        : remaining > 0
          ? 'betting'
          : 'settling';
  if (root.dataset.phase !== phase) root.dataset.phase = phase;
  const connection = stale ? 'stale' : 'live';
  if (root.dataset.connection !== connection) root.dataset.connection = connection;
  const open = isBettingOpen();
  root.classList.toggle('is-locked', !open);
  /* Ten times a second, but the board is only repainted when something it shows has changed:
   * re-setting fifty buttons' state every tick was a style pass every tick on a slow machine. */
  const key = `${phase}|${open}|${placing}|${state.authenticated}|${amountMinor}|${snapshot?.round?.id}|${roundAllowanceMinor()}|${Boolean(snapshot)}`;
  if (key === paintedClockKey) return;
  paintedClockKey = key;
  paintPhase();
  paintControls();
}
let paintedClockKey = '';

async function refresh() {
  if (polling || !root?.isConnected) return;
  polling = true;
  try {
    const next = await api.get('/v1/roulette');
    const receivedAt = Date.now();
    lastSuccessfulSyncMs = receivedAt;
    serverOffsetMs = Date.parse(next.serverTime) - receivedAt;
    const newest = next.history?.[0];
    const spinInProgress = Date.parse(next.round?.opensAt || '') > Date.now() + serverOffsetMs;
    const shouldSpin = Boolean(
      newest?.id &&
      ((seenResultId !== null && newest.id !== seenResultId) ||
        (seenResultId === null && spinInProgress)),
    );
    if (newest?.id) seenResultId = newest.id;
    if (shouldSpin) pendingResultId = newest.id;
    snapshot = next;
    paint();
    if (shouldSpin) {
      const spinEndsAt =
        next.round?.opensAt ||
        new Date(Date.parse(next.serverTime) + Number(next.config?.spinSeconds || 0) * 1000).toISOString();
      spinTo(newest.result, next.yourPreviousBets || [], spinEndsAt);
    }
    else if (newest?.result != null && wheelRotation === 0) setWheel(newest.result);
    syncBetHold();
    scheduleDeadlineRefresh();
  } catch (error) {
    root.dataset.error = '1';
    lastLivePulseMs = 0;
    paintClock();
    /* A failed fetch still has to come back. Without this the deadline chain ends on the first
       blip and the table never recovers on its own. */
    scheduleDeadlineRefresh();
  } finally {
    polling = false;
  }
}

function paint() {
  root.dataset.error = '';
  const config = snapshot.config;
  $('#rouletteLimits', root).textContent =
    `${money(Number(config.minStakeMinor))} min · ${money(Number(config.maxStakeMinor))} max per chip`
    + (config.maxRoundStakeMinor
      ? ` · ${money(Number(config.maxRoundStakeMinor))} table limit per spin`
      : '')
    + ` · ${config.spinSeconds}s spin then ${config.roundSeconds}s betting`;

  paintHistory();

  const visibleResult = visibleHistory()[0]?.result;
  if (visibleResult != null && !$('#rouletteWheel', root).classList.contains('is-spinning')) {
    $('#rouletteResult', root).textContent = String(visibleResult);
    $('#rouletteHub', root).dataset.color = color(Number(visibleResult));
  }
  paintPools();
  paintBets();
  paintPublicBets();
  paintClock();
  syncSelection();
}

function visibleHistory() {
  return (snapshot?.history || []).filter((round) => round.id !== pendingResultId);
}

function paintHistory() {
  const history = $('#rouletteHistory', root);
  history.replaceChildren(
    ...visibleHistory()
      .slice(0, 10)
      .map((round) => {
        const node = document.createElement('span');
        node.className = `roulette__past roulette__past--${round.color}`;
        node.textContent = String(round.result);
        node.title = `Round ${round.id}`;
        return node;
      }),
  );
}

/** What this player has on each spot, keyed by selection. */
function mineBySelection() {
  const mine = new Map();
  for (const bet of snapshot?.yourBets || []) {
    mine.set(bet.selection, (mine.get(bet.selection) ?? 0n) + BigInt(bet.stakeMinor));
  }
  return mine;
}

/**
 * Two figures per spot, and they answer different questions.
 *
 * The table's pool used to be the only one shown, in seven-pixel type in a corner, so the number a
 * player most wants back from the board — what THEY have on red — was indistinguishable from
 * everybody else's total.
 *
 * The first attempt at fixing that put the stake in an absolutely positioned pill, which landed on
 * top of the label. Both now sit in the spot's normal flow as flex children: the label shrinks, the
 * chip sits under it, and they cannot overlap because nothing is out of flow any more.
 *
 * The chip is truncated rather than wrapped, per the compact-label rule, and the full figure goes
 * into the button's accessible name — a truncated number a screen reader cannot recover is a
 * number the player does not have.
 */
function paintPools() {
  const mine = mineBySelection();
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.querySelector('.roulette__pool')?.remove();
    button.querySelector('.roulette__mine')?.remove();

    const own = mine.get(button.dataset.selection) ?? 0n;
    button.dataset.mine = own > 0n ? '1' : '0';
    const name = labelFor(button.dataset.selection);
    if (own > 0n) {
      const chip = document.createElement('b');
      chip.className = 'roulette__mine';
      chip.textContent = money(Number(own));
      button.append(chip);
      button.setAttribute('aria-label', `${name} — you have ${money(Number(own))} on this`);
    } else {
      button.setAttribute('aria-label', name);
    }

    const amount = Number(snapshot.pools?.[button.dataset.selection] || 0);
    if (amount <= 0) return;
    const pool = document.createElement('small');
    pool.className = 'roulette__pool';
    pool.textContent = money(amount);
    button.append(pool);
  });
}

function paintBets() {
  const host = $('#rouletteBets', root);
  const bets = snapshot.yourBets || [];
  host.replaceChildren();
  if (!bets.length) {
    const empty = document.createElement('span');
    empty.className = 'roulette__empty';
    empty.textContent = state.authenticated ? 'No chips placed yet.' : 'Log in to place a chip.';
    host.append(empty);
  } else {
    for (const bet of bets) {
      const row = document.createElement('span');
      row.className = 'roulette__bet';
      const name = document.createElement('b');
      name.textContent = labelFor(bet.selection);
      const value = document.createElement('i');
      value.textContent = money(Number(bet.stakeMinor));
      row.append(name, value);
      host.append(row);
    }
  }
  /* The total, and what is left of the table limit beside it. A running total on its own answers
     "how much am I in for"; the pair answers "can I place another chip", which is the question
     somebody looking at this line is actually asking. */
  const total = roundStakedMinor();
  const allowance = roundAllowanceMinor();
  $('#rouletteMineTotal', root).textContent =
    allowance === null
      ? money(Number(total))
      : `${money(Number(total))} · ${money(Number(allowance))} left`;
}

function paintPublicBets() {
  const host = $('#roulettePublicBets', root);
  const bets = snapshot.publicBets || [];
  host.replaceChildren();
  $('#rouletteLiveBetCount', root).textContent =
    `${bets.length} ${bets.length === 1 ? 'chip' : 'chips'}`;

  if (!bets.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'roulette__tableempty';
    cell.textContent = 'No bets on this round yet.';
    row.append(cell);
    host.append(row);
    return;
  }

  for (const bet of bets) {
    const row = document.createElement('tr');
    row.dataset.you = bet.isViewer ? '1' : '0';

    const player = document.createElement('td');
    player.className = 'roulette__player';
    const name = document.createElement('span');
    name.textContent = bet.isViewer ? 'You' : bet.player;
    const head = tableAvatar(bet.playerId);
    player.append(head, name);
    linkPlayer(bet.playerId, bet.player, head, name);

    const selection = document.createElement('td');
    selection.textContent = labelFor(bet.selection);

    const stake = document.createElement('td');
    stake.className = 'roulette__tablemoney mono';
    stake.textContent = money(Number(bet.stakeMinor));

    row.append(player, selection, stake);
    host.append(row);
  }
}

async function place(selection) {
  if (placing || !isBettingOpen()) return;
  const placedSelection = selection;
  const placedAmount = amountMinor;
  placing = true;
  paintControls();
  /* Held from before the bet leaves (see takeSpinHold): a chip placed in the last moment of the
   * betting window can be followed at once by the spin's settlement. The stake leaves the pill
   * locally, from the balance this page already had, because a refresh is what the hold stops. */
  const hadHold = Boolean(spinHold);
  const before = BigInt(state.balanceMinor || '0');
  const roundId = snapshot.round.id;
  takeSpinHold();
  try {
    try {
      await api.post(
        '/v1/roulette/bets',
        {
          roundId,
          selection: placedSelection,
          stakeMinor: placedAmount.toString(),
        },
        { idempotencyKey: idempotencyKey() },
      );
    } catch (error) {
      if (!hadHold) releaseSpinHold();
      throw error;
    }
    chipsRoundId = roundId;
    showBalance((before - placedAmount).toString());
    // The chip on the spot is the confirmation, and the clack; no toast over the table.
    playSound('rouChip', { rate: placedAmount >= 100_000_000n ? 0.85 : 1 });
    await refresh();
    const spot = root.querySelector(`[data-selection="${placedSelection}"] .roulette__mine`);
    if (spot && !reduceMotion()) {
      spot.animate(
        [{ transform: 'translateY(-10px) scale(1.25)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 260, easing: POP_EASE },
      );
    }
  } catch (error) {
    toast({
      kind: 'lose',
      title: String(error?.code || 'Bet failed').replaceAll('_', ' '),
      body: error?.message || 'The server rejected the bet.',
    });
    await refresh();
  } finally {
    placing = false;
    syncBetHold();
    paintControls();
  }
}

function setWheel(result) {
  const index = ORDER.indexOf(Number(result));
  if (index < 0) return;
  wheelRotation = -((index * 360) / ORDER.length);
  const wheel = $('#rouletteWheel', root);
  wheel.style.transition = 'none';
  wheel.style.transform = `rotate(${wheelRotation}deg)`;
  wheel3d?.rest(index);
  // The last result's pocket is at the top, and the ball sits in it.
  placeBall(0, BALL_POCKET);
}

/* ─────────── the ball ─────────── */
let ballFrame = 0;

/** Puts the ball at `angle` degrees clockwise from the top, `radius` of the wheel's width out. */
function placeBall(angle, radius) {
  const orbit = $('#rouletteOrbit', root);
  const ball = $('#rouletteBall', root);
  if (!orbit || !ball) return;
  orbit.style.setProperty('--a', `${angle.toFixed(2)}deg`);
  ball.style.setProperty('--r', radius.toFixed(4));
}

/** The wheel's rotation as it is drawn right now, mid-transition included, in degrees. */
function wheelAngleNow(wheel) {
  const match = /matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(wheel).transform);
  return match ? (Math.atan2(Number(match[2]), Number(match[1])) * 180) / Math.PI : 0;
}

/**
 * The ball's run, for the length of the wheel's spin.
 *
 * Out of its pocket onto the track, round it anticlockwise (against the wheel) slowing on an
 * ease-out, down off the track with a few bounces across the frets, and caught by the winning
 * pocket: from 72% of the run it is drawn toward where that pocket really is, and from 88% it rides
 * in it. At the end the wheel has the pocket at the top, so the ball is there too.
 */
function rollBall(index, ms) {
  cancelAnimationFrame(ballFrame);
  const wheel = $('#rouletteWheel', root);
  const step = 360 / ORDER.length;
  const started = performance.now();
  const frame = (now) => {
    if (!root?.isConnected) return;
    const t = Math.min(1, (now - started) / ms);
    const free = -BALL_TURNS * 360 * (1 - (1 - t) ** 3);
    const pocket = wheelAngleNow(wheel) + index * step;
    const pull = t < 0.72 ? 0 : t > 0.88 ? 1 : (t - 0.72) / 0.16;
    const delta = ((((pocket - free) % 360) + 540) % 360) - 180;
    const angle = free + delta * pull * pull * (3 - 2 * pull);
    let radius = BALL_POCKET;
    if (t < 0.06) radius = BALL_POCKET + (BALL_TRACK - BALL_POCKET) * (t / 0.06);
    else if (t < 0.55) radius = BALL_TRACK;
    else if (t < 0.85) {
      const u = (t - 0.55) / 0.3;
      radius = BALL_POCKET + (BALL_TRACK - BALL_POCKET) * (1 - u) ** 2 * Math.abs(Math.cos(u * Math.PI * 2.5));
    }
    placeBall(angle, radius);
    if (t < 1) ballFrame = requestAnimationFrame(frame);
  };
  ballFrame = requestAnimationFrame(frame);
}

/**
 * Freezes the wallet figure for the length of the spin.
 *
 * Settlement credits the winners the moment the server resolves the round, and `creditWallet`
 * publishes a balance invalidation as it goes. The browser acted on that immediately — so the
 * header balance jumped to its post-spin value while the wheel was still turning, and a player
 * could read the outcome off their own wallet several seconds before the ball landed.
 *
 * The money is already theirs either way; this is only about which of the two tells them. Held
 * rather than discarded after the fact, because the request the hold prevents is the one the rate
 * limiter counts.
 */
function takeSpinHold() {
  if (spinHold) return;
  spinHold = holdLiveFigures();
}

/* The hold starts when the player has chips on the table, not when the wheel starts.
 *
 * Waiting for the spin was too late. The server settles a round, credits the winners and publishes
 * their balance events BEFORE the round's own event reaches this page, and the page only learns of
 * the spin from the refetch that event triggers. A winner's pill had already moved by the time the
 * wheel began to turn. So the hold is taken with the first chip (place) or as soon as a refresh
 * finds chips of theirs on the open round (a reload mid-round), and kept through the spin.
 *
 * It is let go when there is nothing left to wait for: no chips on the open round and no spin on
 * screen. Normally that is the spin's own finish, which releases it and refreshes. */
function syncBetHold() {
  // A chip on its way decides for itself, in place().
  if (placing || !root?.isConnected || root.closest('.view')?.hidden) return;
  const spinning = $('#rouletteWheel', root)?.classList.contains('is-spinning');
  const chipsDown = (snapshot?.yourBets || []).length > 0
    || (chipsRoundId !== null && snapshot?.round?.id === chipsRoundId);
  if (chipsDown || spinning) takeSpinHold();
  else if (spinHold) {
    releaseSpinHold();
    refreshBalance().catch(() => undefined);
  }
}

function releaseSpinHold() {
  if (!spinHold) return;
  const release = spinHold;
  spinHold = null;
  release();
}

function spinTo(result, bets, opensAt) {
  const index = ORDER.indexOf(Number(result));
  /* A result the wheel cannot show is not a reason to strand the balance behind a hold that will
     never be released. */
  if (index < 0) {
    releaseSpinHold();
    return;
  }
  const wheel = $('#rouletteWheel', root);
  const target = -((index * 360) / ORDER.length);
  const normalized = ((wheelRotation % 360) + 360) % 360;
  const targetNormalized = ((target % 360) + 360) % 360;
  const delta = (targetNormalized - normalized + 360) % 360;
  const parsedOpen = Date.parse(opensAt);
  const spinWindowMs = Number.isFinite(parsedOpen) ? Math.max(0, parsedOpen - serverNowMs()) : 0;
  const animationMs = reduceMotion() || spinWindowMs <= 150 ? 0 : spinWindowMs - 100;
  wheelRotation += (animationMs === 0 ? 0 : 5 * 360) + delta;

  const finish = () => {
    /* The release is in a `finally` because this runs from a timer that fires whether or not the
     * page is still mounted. Navigating away mid-spin leaves `root` detached, the DOM work below
     * throws on a null node, and a hold that escaped would freeze the wallet figure for the whole
     * SITE until a reload — a far worse bug than the spoiler it was taken to prevent. */
    try {
      wheel.classList.remove('is-spinning');
      cancelAnimationFrame(ballFrame);
      placeBall(0, BALL_POCKET);
      pendingResultId = null;
      const face = $('#rouletteResult', root);
      if (face) face.textContent = String(result);
      const hub = $('#rouletteHub', root);
      if (hub) {
        hub.dataset.color = color(Number(result));
        if (animationMs > 0 && !reduceMotion()) {
          hub.animate(
            [{ transform: 'scale(.85)' }, { transform: 'scale(1.08)', offset: 0.6 }, { transform: 'scale(1)' }],
            { duration: 320, easing: POP_EASE },
          );
        }
      }
      if (animationMs > 0 && !root.closest('.view')?.hidden) playSound('rouLand');
      paintHistory();
      announceResult(result, bets);
    } finally {
      releaseSpinHold();
    }
    void refreshBalance();
  };

  if (animationMs === 0) {
    wheel.style.transition = 'none';
    wheel.style.transform = `rotate(${wheelRotation}deg)`;
    wheel3d?.rest(index);
    finish();
    return;
  }
  // The fortress's wheel runs the ball into the same pocket in the same time.
  wheel3d?.spin(index, animationMs);

  takeSpinHold();
  wheel.style.transition = `transform ${animationMs}ms cubic-bezier(.12,.68,.16,1)`;
  wheel.classList.add('is-spinning');
  // Empty while the ball runs: a dot here read as a second ball.
  $('#rouletteResult', root).textContent = '';
  $('#rouletteHub', root).dataset.color = '';
  $('#rouletteWin', root).hidden = true;
  if (!root.closest('.view')?.hidden) playSound('rouSpin');
  requestAnimationFrame(() => {
    wheel.style.transform = `rotate(${wheelRotation}deg)`;
  });
  if (!wheel3d) rollBall(index, animationMs);
  window.setTimeout(finish, animationMs + 40);
}

/* A win pops a card over the wheel, its amount counting up; a loss says itself in the hub. */
function announceResult(result, bets) {
  if (!bets.length) return;
  const staked = bets.reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
  const paid = bets.reduce((sum, bet) => sum + BigInt(bet.payoutMinor || '0'), 0n);
  if (paid <= 0n) return;
  wheel3d?.cheer(paid >= staked * 5n);
  if (!root.closest('.view')?.hidden) playSound(paid >= staked * 10n ? 'jackpot' : 'rouWin');
  const card = $('#rouletteWin', root);
  if (!card) return;
  card.hidden = false;
  const figure = $('b', card);
  const value = Number(paid);
  if (reduceMotion()) {
    figure.textContent = money(value);
  } else {
    card.animate(
      [{ opacity: 0, transform: 'translate(-50%, -50%) scale(.82)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1.04)', offset: 0.6 }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }],
      { duration: 380, easing: POP_EASE },
    );
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 650);
      figure.textContent = money(Math.round(value * (1 - (1 - t) ** 3)));
      if (t < 1 && figure.isConnected) requestAnimationFrame(step);
    };
    figure.textContent = money(0);
    requestAnimationFrame(step);
  }
  window.clearTimeout(winTimer);
  winTimer = window.setTimeout(() => { card.hidden = true; }, 5_000);
}
let winTimer = 0;

function color(number) {
  if (number === 0) return 'green';
  return RED.has(number) ? 'red' : 'black';
}
