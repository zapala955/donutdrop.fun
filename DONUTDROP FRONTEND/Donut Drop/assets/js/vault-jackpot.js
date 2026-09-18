/* vault-jackpot.js — the server-wide pot, as a bar and a moment.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BAR IS A READOUT, NOT AN ANIMATION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Nothing here counts up on its own. The figure is `vault_jackpot.pot_minor` polled from the
 * server, and it moves when the pot moves because other people are playing. A bar that ticked
 * upward in the browser would be a slot machine with no slot in it, and the first player to open
 * two tabs would see two different jackpots.
 *
 * The same goes for the win. By the time this file learns about one, the money is already in the
 * winner's wallet — the draw happened inside the transaction that settled the round that triggered
 * it. The flare is a celebration of a completed fact. Close the tab mid-animation and you have
 * still been paid, which is the property that makes it safe to make it this loud.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE FILL ACTUALLY MEASURES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * There is no target to fill toward — the pot has no cap and the draw is not a threshold. So the
 * bar measures the pot against the biggest one that has recently dropped: full means "this is
 * already bigger than the last one somebody won". That is a real comparison a player can act on,
 * where a bar filling toward an invented ceiling is a promise nobody intends to keep.
 */
import { money } from './util.js';
import { playSound } from './audio-engine.js';
import { api } from './api.js';
import { bus } from './store.js';

const POLL_MS = 12_000;
/** Wins already celebrated on this device, so a reload does not re-fire the flare. */
const SEEN_KEY = 'dd.jackpot.seen';

let host = null;
let amountNode = null;
let fillNode = null;
let timer = 0;
let lastPot = 0n;

export function initVaultJackpot(mount) {
  host = mount;
  if (!host) return;
  build();
  void poll();
  /* Repolled on every wallet change as well as on the timer: a round the player just settled is the
   * most likely moment for the pot to have moved, and waiting twelve seconds to show it makes the
   * bar look disconnected from the game that feeds it. */
  bus.addEventListener('change', (event) => {
    if (['balance', 'activity'].includes(event.detail)) void poll();
  });
}

function build() {
  host.replaceChildren();
  host.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'vjp__bar';
  fillNode = document.createElement('i');
  fillNode.className = 'vjp__fill';
  bar.appendChild(fillNode);

  const label = document.createElement('div');
  label.className = 'vjp__label';
  const coin = document.createElement('i');
  coin.className = 'vjp__coin';
  coin.setAttribute('aria-hidden', 'true');
  const caption = document.createElement('span');
  caption.className = 'vjp__cap';
  caption.textContent = 'VAULT';
  amountNode = document.createElement('b');
  amountNode.className = 'vjp__amt mono';
  /* Announced politely rather than shouted: the figure changes every few seconds and a live region
   * that interrupts on each change is worse than one nobody hears. */
  amountNode.setAttribute('aria-live', 'polite');
  label.append(coin, caption, amountNode);

  host.append(bar, label);
}

async function poll() {
  window.clearTimeout(timer);
  let board;
  try {
    board = await api.get('/v1/social/jackpot');
  } catch (error) {
    /* Disabled is not an error worth showing: the bar simply is not part of this deployment. Any
     * other failure is transient and the next poll will pick it up. */
    if (error?.code === 'JACKPOT_DISABLED') {
      host.hidden = true;
      return;
    }
    timer = window.setTimeout(() => void poll(), POLL_MS * 2);
    return;
  }

  host.hidden = false;
  paint(board);
  if (board.yourWin) celebrate(board.yourWin);
  timer = window.setTimeout(() => void poll(), POLL_MS);
}

function paint(board) {
  const pot = BigInt(board.potMinor);
  const biggest = (board.recentWins ?? []).reduce(
    (best, win) => (BigInt(win.amountMinor) > best ? BigInt(win.amountMinor) : best),
    0n,
  );
  const reference = biggest > pot ? biggest : pot;
  const ratio = reference > 0n ? Number((pot * 1000n) / reference) / 1000 : 0;

  rollTo(Number(pot));
  fillNode.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
  /* A pot that has passed the last payout gets its own state, because "bigger than the one that
   * just dropped" is the only moment on this bar worth looking up for. */
  host.dataset.hot = pot >= biggest && biggest > 0n ? '1' : '0';

  if (pot > lastPot && lastPot > 0n) {
    amountNode.classList.remove('pop');
    void amountNode.offsetWidth;
    amountNode.classList.add('pop');
  }
  lastPot = pot;
}

/* ═════════════════════════ the odometer ═════════════════════════ */

/**
 * Counts the figure up to its new value instead of swapping it.
 *
 * A pot that jumps from $1.00M to $1.02M between polls reads as a static label that occasionally
 * blinks. Rolling the digits over about a second turns the same two data points into something that
 * looks like it is filling, which is what the bar is for.
 *
 * Eased out, so it arrives rather than stopping. The tween is cancelled on the next poll, so a fast
 * sequence of updates chases the newest value instead of queueing.
 */
let rollFrame = 0;
let rollFrom = 0;

function rollTo(target) {
  window.cancelAnimationFrame(rollFrame);
  const start = performance.now();
  const from = rollFrom;
  const span = target - from;
  /* Nothing to animate on the first paint, or when the pot has not moved: jumping straight there
   * avoids a pointless second of counting up from zero every time the page loads. */
  if (span === 0 || from === 0) {
    rollFrom = target;
    amountNode.textContent = money(target);
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - start) / 900);
    const eased = 1 - Math.pow(1 - t, 3);
    amountNode.textContent = money(from + span * eased);
    if (t < 1) rollFrame = window.requestAnimationFrame(step);
    else rollFrom = target;
  };
  rollFrame = window.requestAnimationFrame(step);
}

/* ═════════════════════════ the flare ═════════════════════════ */

function alreadySeen(id) {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? JSON.parse(raw).includes(id) : false;
  } catch {
    /* Private windows and blocked site data both throw. A viewer who cannot remember simply sees
     * the flare once more, which is a far better failure than not seeing it at all. */
    return false;
  }
}

function remember(id) {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const seen = raw ? JSON.parse(raw) : [];
    seen.push(id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-20)));
  } catch {
    /* Storage is a convenience here, never a correctness requirement. */
  }
}

function celebrate(win) {
  if (alreadySeen(win.id)) return;
  remember(win.id);

  const overlay = document.createElement('div');
  overlay.className = 'vjpflare';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Vault jackpot won');

  const canvas = document.createElement('canvas');
  canvas.className = 'vjpflare__coins';
  canvas.setAttribute('aria-hidden', 'true');
  overlay.appendChild(canvas);

  const card = document.createElement('div');
  card.className = 'vjpflare__card';
  const kicker = document.createElement('div');
  kicker.className = 'vjpflare__kicker';
  kicker.textContent = 'VAULT JACKPOT';
  const figure = document.createElement('div');
  figure.className = 'vjpflare__fig mono';
  figure.textContent = money(Number(win.amountMinor));
  const claim = document.createElement('button');
  claim.className = 'btn btn--go vjpflare__go';
  /* The money is already banked. The button dismisses a celebration, and it says CLAIM because
   * that is what the moment feels like — but nothing is contingent on pressing it. */
  claim.textContent = 'CLAIM JACKPOT';
  card.append(kicker, figure, claim);
  overlay.appendChild(card);

  document.body.appendChild(overlay);
  const stopCoins = rainCoins(canvas);
  playSound('slam');
  window.setTimeout(() => playSound('chime'), 260);

  const close = () => {
    stopCoins();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  claim.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  claim.focus();
}

/**
 * Falling coins, on a canvas.
 *
 * A canvas rather than a few hundred absolutely positioned elements: this runs at the exact moment
 * the page is also playing two audio cues and repainting a modal, and several hundred DOM nodes
 * animating on the compositor is how a celebration turns into a stutter.
 *
 * Seeded from an integer counter rather than Math.random for the same reason the arena's particles
 * are: nothing on this platform is simulated, and keeping chance out of the decoration too makes
 * that easy to check rather than something you have to take on trust.
 */
function rainCoins(canvas) {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  const coins = [];
  let raf = 0;
  let seed = 1;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  for (let index = 0; index < 140; index += 1) {
    coins.push({
      x: next() * window.innerWidth,
      y: -next() * window.innerHeight,
      r: 5 + next() * 9,
      vy: 120 + next() * 260,
      spin: next() * Math.PI * 2,
      vs: (next() - 0.5) * 5,
      sway: next() * Math.PI * 2,
    });
  }

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const coin of coins) {
      coin.y += coin.vy * dt;
      coin.spin += coin.vs * dt;
      coin.sway += dt * 2;
      if (coin.y - coin.r > window.innerHeight) {
        coin.y = -coin.r * 2;
        coin.x = next() * window.innerWidth;
      }
      const x = coin.x + Math.sin(coin.sway) * 14;
      // A coin seen edge-on is an ellipse. Spinning the x-radius is the whole trick.
      const squash = Math.abs(Math.cos(coin.spin));
      context.beginPath();
      context.ellipse(x, coin.y, Math.max(1, coin.r * squash), coin.r, 0, 0, Math.PI * 2);
      const gradient = context.createLinearGradient(x, coin.y - coin.r, x, coin.y + coin.r);
      gradient.addColorStop(0, '#ffd700');
      gradient.addColorStop(1, '#ffaa00');
      context.fillStyle = gradient;
      context.fill();
      context.strokeStyle = 'rgba(34, 24, 2, .55)';
      context.lineWidth = 1;
      context.stroke();
    }
    raf = window.requestAnimationFrame(frame);
  };
  raf = window.requestAnimationFrame(frame);

  return () => {
    window.cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
}
