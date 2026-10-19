/* winfx.js — the small flourish at the wallet when a round of yours is won.
 *
 * What counts as a win: one of YOUR rounds that paid back more than it cost. The figure on the
 * chip is the profit (payout minus wager), never the payout, so a 0.5x Plinko slot or a crate that
 * returned half its price is not dressed up as a win. Several rounds settling together (Plinko's
 * balls) are netted first, and nothing shows unless the net is above zero.
 *
 * Where the news comes from: the live feed. Every game writes its settled rounds there with the
 * wager and the payout, so one listener covers all of them, and the feed is already held back
 * while a reel or a ball is still moving (holdLiveFigures in store.js). The flourish therefore
 * lands after the reveal, never ahead of it, without any game having to call it.
 *
 * Rounds already on the feed when the page has loaded, or when the player signs in or out, are
 * only noted, not celebrated: those moments reseed what has been seen. */
import { state, bus } from './store.js';
import { money } from './util.js';

const SHOWN_MS = 1800;
const key = (row) => `${row.kind}:${row.id}`;

export function initWinFx() {
  const pill = document.querySelector('.lxbal');
  if (!pill) return;
  let seen = null;
  const reseed = () => {
    seen = new Set((state.activities || []).map(key));
  };

  bus.addEventListener('change', (event) => {
    const kind = event.detail;
    if (kind === 'ready' || kind === 'login' || kind === 'logout') {
      reseed();
      return;
    }
    if (kind !== 'activity') return;
    if (seen === null) {
      reseed();
      return;
    }

    const me = state.authenticated ? state.user?.id ?? null : null;
    const rows = state.activities || [];
    let net = 0;
    let mine = 0;
    for (const row of rows) {
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!me || row.playerId !== me || row.payoutMinor == null) continue;
      mine += 1;
      net += row.payout - row.wager;
    }
    // The set only needs to remember what the feed can still show.
    if (seen.size > 400) reseed();

    if (mine > 0 && net > 0 && !document.hidden) flourish(pill, net);
  });
}

/** The animation test bench's door (devmenu.js): the same chip and ring, for a made-up profit.
 * Resolves once the chip has gone. */
export function playWinFx(profit) {
  const pill = document.querySelector('.lxbal');
  if (!pill || pill.offsetParent === null) throw new Error('the wallet is not on the page — sign in first');
  flourish(pill, profit);
  return new Promise((resolve) => { setTimeout(resolve, SHOWN_MS + 150); });
}

let clearTimer = 0;

function flourish(pill, profit) {
  pill.querySelector('.winfx')?.remove();
  const chip = document.createElement('span');
  chip.className = 'winfx';
  chip.setAttribute('aria-hidden', 'true');
  chip.textContent = `+${money(profit)}`;
  pill.appendChild(chip);

  // Restart the ring: drop the class, force a reflow, add it back (as initWallet does for .pop).
  pill.classList.remove('is-won');
  void pill.offsetWidth;
  pill.classList.add('is-won');

  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    chip.remove();
    pill.classList.remove('is-won');
  }, SHOWN_MS + 100);
}
