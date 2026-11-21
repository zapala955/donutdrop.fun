/* roulette.js — one server-owned European wheel shared by every browser.
 *
 * The wheel is drawn in WebGL (roulette3d.js), its own chunk, at the graphics the player picked or
 * the machine can manage: a fire charge on a wheel in a Nether fortress, blazes watching. This page
 * still says which pocket and how long; the 3D wheel only runs the ball there. Without WebGL the flat
 * wheel turns as it always has.
 *
 * The flat table, as the preview's (2026-11-21, the owner: "roulette"). The bet panel on the left:
 * the bet amount, typed or set with ½, 2× and Max, what you have on the table and in how many chips,
 * what the board pays, the table's limits and the live bets. On the stage: the last numbers top
 * right, the wheel, "Bets lock in" over a draining bar, and the board under it -- 0 down the left,
 * the numbers in three rows of twelve, the dozens and the even-money bets under them. Your chips sit
 * on the spots as chips. When the ball lands, the spots that number won are outlined, the status
 * line says what it paid you, and a win pops the preview's card over the wheel. The preview's Undo
 * and Clear are left out: a chip placed on the server cannot be taken back.
 *
 * The flat wheel is the preview's, drawn on a canvas: it is always turning slowly, with the ball
 * resting in the last pocket. On a spin the wheel is kicked faster and slows again, and the ball
 * runs round the track against it, drops off, skips over the frets and settles in the pocket the
 * server named, as the next betting window opens (rollBall). The ball is placed in the wheel's own
 * frame and its run ends on that pocket, so it lands where the server said whatever the frame rate. */
import { api, idempotencyKey } from './api.js';
import { state, refreshBalance, holdLiveFigures, showBalance } from './store.js';
import { onNavigate } from './routing.js';
import { tableAvatar } from './table-avatar.js';
import { linkPlayer } from './player-link.js';
import { $, adjustStake, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { clearWin, makeFx, winCard } from './pvfx.js';
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
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/* A chip dropping onto its spot, as the preview drops it: quick, a little past, settled. */
const POP_EASE = 'cubic-bezier(.2, 1.5, .4, 1)';
/* The preview's wheel, on a canvas 560 across: the rim, the track the ball runs on, the outer and
 * inner edge of the number ring, the bottom of the pockets, the cone, and where a ball rests in its
 * pocket. Radii in canvas pixels from the centre. */
const WHEEL_PX = 560;
const RIM = 276;
const TRACK = 252;
const NUM_O = 236;
const NUM_I = 200;
const POCK_I = 170;
const CONE = 168;
const REST = 186;
const TAU = Math.PI * 2;
const SEG = TAU / ORDER.length;
/* The wheel's own slow turn, in radians a second; a spin adds a kick that dies away. */
const WHEEL_IDLE = 0.45;
const OUTSIDE = Object.freeze([
  ['low', '1–18'],
  ['even', 'Even'],
  ['red', 'Red'],
  ['black', 'Black'],
  ['odd', 'Odd'],
  ['high', '19–36'],
  ['dozen:1', '1 to 12'],
  ['dozen:2', '13 to 24'],
  ['dozen:3', '25 to 36'],
]);

let root;
let snapshot;
let selected = 'red';
let amountMinor = 1_000_000n;
let stakeText = '1m'; // the bet amount as typed
let serverOffsetMs = 0;
let polling = false;
let placing = false;
let seenResultId = null;
let pendingResultId = null;
let lastSuccessfulSyncMs = 0;
let lastLivePulseMs = 0;
let deadlineTimer = null;
let spinHold = null;
/* The round this page put chips on. A refresh that left before the chip did comes back without
 * it in `yourBets`; this keeps such a snapshot from letting the hold go a moment too early. */
let chipsRoundId = null;
let wheel3d = null; // the fortress's wheel, once it is up
let wheelTried = null;
let fx = null; // the preview's effects over the flat stage (pvfx.js)
/* The flat wheel (turnWheel): its turn, and the ball in the wheel's own frame, pocket i being at
 * pocketAngle(i). The ball rests in `ballPocket` (-1 until the first result is known) and has a
 * `ballRun` while it runs. */
let wheelImg = null;
let wheelPaint = null;
let wheelAngle = 0;
let ballAngle = -Math.PI / 2;
let ballRadius = REST;
let ballPocket = -1;
let ballRun = null;
let wheelRaf = 0;
let wheelLast = 0;
/* What the status line says for a moment after the ball lands. */
let resultNote = '';
let resultNoteUntil = 0;
let paintedNewest = null;

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
  startWheelLoop();
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
        startWheelLoop();
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
    startWheelLoop();
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
        <canvas class="roulette__wheel" id="rouletteWheel" width="${WHEEL_PX}" height="${WHEEL_PX}" aria-hidden="true"></canvas>
        <div class="roulette__hub" id="rouletteHub" data-color=""><b id="rouletteResult">—</b></div>
      </div>
      <div class="roulette__status">
        <strong id="roulettePhase" role="status" aria-live="polite">Connecting to the table…</strong>
        <span class="roulette__clock mono" id="rouletteClock">—</span>
        <span class="roulette__timer" aria-hidden="true"><i id="rouletteTimerBar"></i></span>
      </div>
      <div class="roulette__felt">
        <div class="roulette__numbers" id="rouletteNumbers"></div>
        <div class="roulette__outside" id="rouletteOutside"></div>
      </div>
      ${viewSwitch('rouletteView')}
      <label class="roulette__gfx" for="rouletteGfx">
        <span>Graphics</span>
        <select id="rouletteGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
      </label>
    </section>

    <section class="roulette__board" aria-label="Your bets">
      <label class="roulette__label" for="rouletteStake">Bet amount</label>
      <!-- The preview's stake box: any amount inside the table's limits, with ½, 2× and Max. -->
      <div class="roulette__field">
        <span aria-hidden="true">$</span>
        <input id="rouletteStake" inputmode="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
        <button type="button" class="roulette__adj" data-adj="half" aria-label="Halve the bet">½</button>
        <button type="button" class="roulette__adj" data-adj="double" aria-label="Double the bet">2×</button>
        <button type="button" class="roulette__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
      </div>
      <div class="roulette__sum">
        <div class="roulette__sumrow"><span>On the table</span><span id="rouletteMineTotal">$0</span></div>
        <div class="roulette__sumrow"><b>Chips</b><b id="rouletteMineCount">0</b></div>
      </div>
      <p class="roulette__hint" id="rouletteChoice" aria-live="polite">Click the board to place a chip of your bet amount.</p>
      <p class="roulette__limits mono" id="rouletteLimits">Loading table limits…</p>
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
  fx = makeFx($('.roulette__stage', root));

  buildWheel();
  drawWheel();
  document.fonts?.ready?.then(() => {
    buildWheel();
    drawWheel();
  });
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
  const stake = $('#rouletteStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => {
    stakeText = stake.value;
    const value = parseAmount(stakeText);
    amountMinor = value === null ? 0n : BigInt(value);
    syncSelection();
  });
  root.addEventListener('click', onClick);
  $('#rouletteGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#rouletteView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  syncSelection();
}

/** The wheel's colours, off the page, so the canvas matches the board (preview.css). */
function wheelColors() {
  const css = getComputedStyle(root);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    red: v('--rou-red', '#be2323'),
    black: v('--rou-black', '#1b1813'),
    green: v('--rou-green', '#007e46'),
    ink: v('--lx-ink', '#f5f3ef'),
    mute: v('--lx-mute', '#9c9792'),
    gold: v('--lx-gold', '#ffaa00'),
    goldHi: v('--lx-gold-hi', '#fec348'),
    well: v('--lx-0', '#080605'),
    p2: v('--lx-2', '#171411'),
    p3: v('--lx-3', '#211d1a'),
    p4: v('--lx-4', '#2c2824'),
    p5: v('--lx-5', '#39342f'),
    font: v('--lx-display', 'system-ui, sans-serif'),
  };
}

/** The part of the wheel that turns, drawn once: the pockets with their numbers, gold frets, the
 * dark cone with its four gold spokes and the hub. */
function buildWheel() {
  const C = wheelColors();
  const img = document.createElement('canvas');
  img.width = WHEEL_PX;
  img.height = WHEEL_PX;
  const x = img.getContext('2d');
  if (!x) return;
  const c0 = WHEEL_PX / 2;
  ORDER.forEach((number, index) => {
    const a0 = -Math.PI / 2 + index * SEG - SEG / 2;
    x.beginPath();
    x.arc(c0, c0, NUM_O, a0, a0 + SEG);
    x.arc(c0, c0, POCK_I, a0 + SEG, a0, true);
    x.closePath();
    x.fillStyle = number === 0 ? C.green : RED.has(number) ? C.red : C.black;
    x.fill();
    // the pocket ring, a shade deeper than the numbers' ring
    x.beginPath();
    x.arc(c0, c0, NUM_I, a0, a0 + SEG);
    x.arc(c0, c0, POCK_I, a0 + SEG, a0, true);
    x.closePath();
    x.fillStyle = 'rgba(0, 0, 0, .38)';
    x.fill();
    x.save();
    x.translate(c0, c0);
    x.rotate(a0 + SEG / 2 + Math.PI / 2);
    x.fillStyle = C.ink;
    x.font = `800 19px ${C.font}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(String(number), 0, -(NUM_O + NUM_I) / 2);
    x.restore();
  });
  x.strokeStyle = C.gold;
  x.lineWidth = 2;
  ORDER.forEach((_, index) => {
    const a = -Math.PI / 2 + index * SEG - SEG / 2;
    x.beginPath();
    x.moveTo(c0 + Math.cos(a) * POCK_I, c0 + Math.sin(a) * POCK_I);
    x.lineTo(c0 + Math.cos(a) * NUM_O, c0 + Math.sin(a) * NUM_O);
    x.stroke();
  });
  x.beginPath();
  x.arc(c0, c0, NUM_I, 0, TAU);
  x.strokeStyle = 'rgba(0, 0, 0, .4)';
  x.stroke();
  x.beginPath();
  x.arc(c0, c0, CONE, 0, TAU);
  x.fillStyle = C.p3;
  x.fill();
  x.beginPath();
  x.arc(c0, c0, CONE - 26, 0, TAU);
  x.fillStyle = C.p2;
  x.fill();
  for (let spoke = 0; spoke < 4; spoke += 1) {
    x.save();
    x.translate(c0, c0);
    x.rotate((spoke * Math.PI) / 2);
    x.fillStyle = C.gold;
    x.fillRect(-7, -CONE + 34, 14, CONE - 70);
    x.fillStyle = C.goldHi;
    x.fillRect(-12, -CONE + 26, 24, 16);
    x.restore();
  }
  x.beginPath();
  x.arc(c0, c0, 34, 0, TAU);
  x.fillStyle = C.gold;
  x.fill();
  x.beginPath();
  x.arc(c0, c0, 20, 0, TAU);
  x.fillStyle = C.goldHi;
  x.fill();
  wheelImg = img;
  wheelPaint = C;
}

/** One frame of the flat wheel: the bowl, the wheel at its turn, and the ball where it is on it. */
function drawWheel() {
  const canvas = root && $('#rouletteWheel', root);
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !wheelImg) return;
  const C = wheelPaint;
  const c0 = WHEEL_PX / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, WHEEL_PX, WHEEL_PX);
  ctx.beginPath();
  ctx.arc(c0, c0, RIM, 0, TAU);
  ctx.fillStyle = C.p4;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c0, c0, RIM - 6, 0, TAU);
  ctx.fillStyle = C.p2;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c0, c0, NUM_O + 2, 0, TAU);
  ctx.fillStyle = C.well;
  ctx.fill();
  // the eight diamonds on the track, which do not turn
  ctx.fillStyle = C.p5;
  for (let at = 0; at < 8; at += 1) {
    const a = (at * Math.PI) / 4 + Math.PI / 8;
    ctx.fillRect(c0 + Math.cos(a) * (TRACK - 4) - 4, c0 + Math.sin(a) * (TRACK - 4) - 4, 8, 8);
  }
  ctx.save();
  ctx.translate(c0, c0);
  ctx.rotate(wheelAngle);
  ctx.drawImage(wheelImg, -c0, -c0);
  ctx.restore();
  if (ballPocket < 0 && !ballRun) return;
  const a = wheelAngle + ballAngle;
  const bx = c0 + Math.cos(a) * ballRadius;
  const by = c0 + Math.sin(a) * ballRadius;
  ctx.fillStyle = 'rgba(0, 0, 0, .35)';
  ctx.beginPath();
  ctx.arc(bx + 3, by + 4, 10, 0, TAU);
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  ctx.arc(bx, by, 10, 0, TAU);
  ctx.fill();
  ctx.fillStyle = C.mute;
  ctx.beginPath();
  ctx.arc(bx + 2, by + 3, 6, 0.2, 2.6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(bx - 5, by - 6, 4, 4);
}

function startWheelLoop() {
  if (wheelRaf || !root?.isConnected) return;
  wheelLast = 0;
  wheelRaf = requestAnimationFrame(turnWheel);
}

/* The flat wheel frame by frame, as the preview runs it: always turning slowly, kicked faster by a
 * spin and slowing back down, the ball drawn where it is. It stops while the page is hidden, under
 * the 3D wheel, and (with nothing running) for reduced motion; mountRoulette starts it again. */
function turnWheel(now) {
  wheelRaf = 0;
  if (!root?.isConnected || root.closest('.view')?.hidden || wheel3d) return;
  const dt = Math.min(0.05, wheelLast ? (now - wheelLast) / 1000 : 0.016);
  wheelLast = now;
  let speed = reduceMotion() ? 0 : WHEEL_IDLE;
  if (ballRun) {
    const elapsed = now - ballRun.started;
    const k = Math.min(1, elapsed / ballRun.ms);
    speed += 2.2 * Math.exp(-elapsed / 1500);
    ballAngle = ballRun.from + ballRun.delta * (1 - (1 - k) ** 3);
    ballRadius = ballRadiusAt(k);
  }
  wheelAngle = (wheelAngle + speed * dt) % TAU;
  drawWheel();
  if (speed > 0 || ballRun) wheelRaf = requestAnimationFrame(turnWheel);
}

/** How far out the ball is, k of the way through its run: on the track to 58%, then falling into
 * the pockets with a few bounces over the frets, then a last small rattle as it settles. */
function ballRadiusAt(k) {
  if (k < 0.58) return TRACK;
  if (k < 0.84) {
    const s = (k - 0.58) / 0.26;
    return REST + (TRACK - REST) * (1 - s) ** 1.6 + 18 * Math.abs(Math.sin(s * Math.PI * 2.5)) * (1 - s);
  }
  return REST + 3 * Math.sin((k - 0.84) * 70) * (1 - (k - 0.84) / 0.16);
}

/** Where pocket `index` is in the wheel's own frame (the canvas's angle, the top being -π/2). */
function pocketAngle(index) {
  return -Math.PI / 2 + index * SEG;
}

function onClick(event) {
  const choice = event.target.closest('[data-selection]');
  if (choice && root.contains(choice)) {
    selected = choice.dataset.selection;
    syncSelection();
    // A bet amount the table will not take says why under the box instead of going to the server.
    if (stakeProblem()) {
      $('#rouletteStake', root)?.focus();
      return;
    }
    void place(selected);
    return;
  }
  const adj = event.target.closest('[data-adj]');
  if (adj && root.contains(adj) && !adj.disabled) {
    amountMinor = adjustStake(adj.dataset.adj, amountMinor, state.balanceMinor, largestChip());
    stakeText = formatAmountInput(Number(amountMinor));
    $('#rouletteStake', root).value = stakeText;
    syncSelection();
  }
}

/** The most one chip can be right now: the table's largest, or what is left of the limit. */
function largestChip() {
  const max = BigInt(snapshot?.config?.maxStakeMinor || '0');
  const allowance = roundAllowanceMinor();
  return allowance !== null && allowance < max ? allowance : max;
}

/** What is wrong with the bet amount, if anything; the server checks it again either way. */
function stakeProblem() {
  const config = snapshot?.config;
  if (!config) return '';
  const value = amountMinor;
  const min = BigInt(config.minStakeMinor);
  const max = BigInt(config.maxStakeMinor);
  const allowance = roundAllowanceMinor();
  if (value <= 0n) return 'Enter a bet amount, for example 1m';
  if (value < min) return `The smallest chip is ${money(Number(min))}`;
  if (value > max) return `The largest chip is ${money(Number(max))}`;
  // A chip is offered only while it still fits the table limit for this spin.
  if (!(allowance === null || value <= allowance)) {
    return `That is over the table limit for this spin: ${money(Number(allowance))} left`;
  }
  if (state.authenticated && value > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
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
  /* Under the box: what the board pays, from the table's own config -- or, as on Dice, what is wrong
     with the bet amount. */
  const choice = $('#rouletteChoice', root);
  const pays = snapshot?.config?.payoutBps;
  const times = (bps) => `${(bps / 10_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}×`;
  const problem = stakeProblem();
  const hint = problem || (pays
    ? `Click the board to place a chip of your bet amount. Straight pays ${times(pays.straight)}, dozens ${times(pays.dozen)}, red, black, odd, even, 1–18 and 19–36 pay ${times(pays.evenMoney)}.`
    : 'Click the board to place a chip of your bet amount.');
  if (choice && choice.textContent !== hint) choice.textContent = hint;
  choice?.classList.toggle('is-error', Boolean(problem));
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
  const allowance = roundAllowanceMinor();
  /* At the table limit the whole board goes dead, not just the chips. A layout that leaves the
     numbers pressable and answers every one of them with the same refusal is a board that looks
     broken; the player has not done anything wrong, they have finished betting this spin. */
  const atLimit = allowance !== null && allowance < min;
  const tableLocked = placing || !isBettingOpen() || !state.authenticated || atLimit;
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.disabled = tableLocked;
  });
  root.querySelectorAll('[data-adj]').forEach((button) => {
    button.disabled = placing || !snapshot || (button.dataset.adj === 'max' && atLimit);
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
  if (!state.authenticated && performance.now() >= resultNoteUntil) {
    phase.textContent = 'Log in to place a chip';
    return;
  }
  /* What the last spin paid, for a moment after the ball lands; otherwise the clock says it all. */
  phase.textContent = placing
    ? `Placing ${money(Number(amountMinor))}…`
    : performance.now() < resultNoteUntil
      ? resultNote
      : '';
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
            ? `Bets lock in ${(remaining / 1000).toFixed(1)}s`
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
  const key = `${phase}|${open}|${placing}|${state.authenticated}|${amountMinor}|${snapshot?.round?.id}|${roundAllowanceMinor()}|${Boolean(snapshot)}|${performance.now() < resultNoteUntil}`;
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
    else if (newest?.result != null && ballPocket < 0) setWheel(newest.result);
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
  const rounds = visibleHistory().slice(0, 6);
  // Only a number that has just landed slides in; a repaint of the same list does not.
  const fresh = paintedNewest !== null && rounds[0] && rounds[0].id !== paintedNewest;
  paintedNewest = rounds[0]?.id ?? paintedNewest;
  history.replaceChildren(
    ...rounds.reverse().map((round, at, list) => {
      const node = document.createElement('span');
      node.className = `roulette__past roulette__past--${round.color}`;
      if (fresh && at === list.length - 1) node.classList.add('is-new');
      node.textContent = String(round.result);
      node.title = `Round ${round.id}`;
      return node;
    }),
  );
}

/* The chips riding on the spin on screen. The server opens the next round as it settles the last,
 * so while the ball runs `yourBets` is already the new round's, empty; the chips the ball is
 * deciding stay on the board until it lands, as in the preview (finish() repaints them away). */
function ridingBets() {
  return (pendingResultId !== null ? snapshot?.yourPreviousBets : snapshot?.yourBets) || [];
}

/** What this player has on each spot, keyed by selection. */
function mineBySelection() {
  const mine = new Map();
  for (const bet of ridingBets()) {
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
      // The preview's chip on the felt: the figure without its $, as a chip carries it.
      chip.textContent = money(Number(own)).replace(/^\$/, '');
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
  const bets = ridingBets();
  $('#rouletteMineCount', root).textContent = String(bets.length);
  /* The total, and what is left of the table limit beside it. A running total on its own answers
     "how much am I in for"; the pair answers "can I place another chip", which is the question
     somebody looking at this line is actually asking. While the ball runs it is what rides on it. */
  const total = bets.reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
  const allowance = roundAllowanceMinor();
  $('#rouletteMineTotal', root).textContent =
    allowance === null || pendingResultId !== null
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
        [{ transform: 'translateY(-60%) scale(1.5)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 300, easing: POP_EASE },
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
  wheel3d?.rest(index);
  // The last result's pocket has the ball in it, turning with the wheel.
  settleBall(index);
}

/**
 * The preview's ball run, for the length of the wheel's spin.
 *
 * Out of the pocket it was resting in and round the track against the wheel, a turn for each second
 * of the spin, slowing on an ease-out; off the track at 58%, skipping over the frets, and settled at
 * the end. It is placed in the wheel's own frame and the run is measured to end exactly on pocket
 * `index`, so the ball finishes in the pocket the server named however the frames fall.
 */
function rollBall(index, ms) {
  const target = pocketAngle(index);
  const from = ballPocket >= 0 ? ballAngle : -Math.PI / 2 - wheelAngle;
  const ahead = (((target - from) % TAU) + TAU) % TAU;
  const turns = Math.max(2, Math.round(ms / 1000));
  ballRun = { from, delta: ahead - TAU * turns, started: performance.now(), ms };
  ballRadius = TRACK;
  startWheelLoop();
}

/** The ball at rest in pocket `index`. */
function settleBall(index) {
  ballRun = null;
  ballPocket = index;
  ballAngle = pocketAngle(index);
  ballRadius = REST;
  if (!wheel3d) drawWheel();
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
  const parsedOpen = Date.parse(opensAt);
  const spinWindowMs = Number.isFinite(parsedOpen) ? Math.max(0, parsedOpen - serverNowMs()) : 0;
  const animationMs = reduceMotion() || spinWindowMs <= 150 ? 0 : spinWindowMs - 100;

  const finish = () => {
    /* The release is in a `finally` because this runs from a timer that fires whether or not the
     * page is still mounted. Navigating away mid-spin leaves `root` detached, the DOM work below
     * throws on a null node, and a hold that escaped would freeze the wallet figure for the whole
     * SITE until a reload — a far worse bug than the spoiler it was taken to prevent. */
    try {
      wheel.classList.remove('is-spinning');
      settleBall(index);
      pendingResultId = null;
      paintPools();
      paintBets();
      const face = $('#rouletteResult', root);
      if (face) face.textContent = String(result);
      // The number comes up in the middle of the wheel in its pocket's colour (preview.css).
      const hub = $('#rouletteHub', root);
      if (hub) hub.dataset.color = color(Number(result));
      if (animationMs > 0 && !root.closest('.view')?.hidden) playSound('rouLand');
      markHits(Number(result));
      paintHistory();
      announceResult(result, bets);
    } finally {
      releaseSpinHold();
    }
    void refreshBalance();
  };

  if (animationMs === 0) {
    wheel3d?.rest(index);
    finish();
    return;
  }
  // Held before anything moves: the settlement's balance events are already on their way.
  takeSpinHold();
  // The fortress's wheel runs the ball into the same pocket in the same time.
  wheel3d?.spin(index, animationMs);
  wheel.classList.add('is-spinning');
  // The middle empties while the ball runs; the last spin's card and marks go.
  $('#rouletteResult', root).textContent = '';
  $('#rouletteHub', root).dataset.color = '';
  clearWin($('.roulette__wheelwrap', root));
  markHits(null);
  resultNoteUntil = 0;
  if (!root.closest('.view')?.hidden) playSound('rouSpin');
  if (!wheel3d) rollBall(index, animationMs);
  window.setTimeout(finish, animationMs + 40);
}

/** Whether a chip on `selection` wins on `number`, for marking the board only: the server settles. */
function covers(selection, number) {
  if (selection === `straight:${number}`) return true;
  if (number === 0) return false;
  if (selection === 'red') return RED.has(number);
  if (selection === 'black') return !RED.has(number);
  if (selection === 'odd') return number % 2 === 1;
  if (selection === 'even') return number % 2 === 0;
  if (selection === 'low') return number <= 18;
  if (selection === 'high') return number >= 19;
  if (selection.startsWith('dozen:')) return Math.ceil(number / 12) === Number(selection.slice(6));
  return false;
}

/** The spots the number won outlined, pulsing as the preview's do, until the next spin. */
function markHits(number) {
  root.querySelectorAll('[data-selection]').forEach((button) => {
    if (number !== null && covers(button.dataset.selection, number)) button.dataset.hit = '';
    else delete button.dataset.hit;
  });
}

/** The status line's word on the spin, for three seconds of the next betting window. */
function noteResult(text) {
  resultNote = text;
  resultNoteUntil = performance.now() + 3_000;
  paintedClockKey = '';
  paintClock();
}

/* The result as the preview gives it. A win pops the preview's card over the wheel, the multiple
 * and the amount counting up (gold rain at 10x or more); a miss says so in the status line with the
 * soft fall; with nothing on the spin the line just names the number. */
function announceResult(result, bets) {
  const number = Number(result);
  const shown = !root.closest('.view')?.hidden;
  if (!bets.length) {
    noteResult(`${number} ${color(number)}`);
    return;
  }
  const staked = bets.reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
  const paid = bets.reduce((sum, bet) => sum + BigInt(bet.payoutMinor || '0'), 0n);
  if (paid <= 0n) {
    noteResult(`${number}. No win this spin.`);
    if (shown) playSound('lose');
    return;
  }
  noteResult(`${number} pays you ${money(Number(paid))}`);
  wheel3d?.cheer(paid >= staked * 5n);
  if (shown) playSound(paid >= staked * 10n ? 'jackpot' : 'rouWin');
  const wrap = $('.roulette__wheelwrap', root);
  if (!wrap || staked <= 0n) return;
  winCard(wrap, wheel3d ? null : fx, Number(paid) / Number(staked), Number(paid));
  window.clearTimeout(winTimer);
  winTimer = window.setTimeout(() => clearWin(wrap), 3_000);
}
let winTimer = 0;

function color(number) {
  if (number === 0) return 'green';
  return RED.has(number) ? 'red' : 'black';
}
