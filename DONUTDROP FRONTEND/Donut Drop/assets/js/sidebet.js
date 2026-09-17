/* sidebet.js — the spectator side-betting overlay.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A SPECTATOR IS SHOWN, AND WHAT THEY ARE NOT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A multiplier per side, and nothing else. It arrives from the server already net of the platform's
 * cut, so the figure on the chip is what would actually be paid per unit staked — there is no rate,
 * no percentage and no split anywhere in this file, and nothing arrives that could become one.
 *
 * The multiplier MOVES. It is a parimutuel pool, so a side gets shorter as people back it, and the
 * number shown is what that side would pay if the market settled this instant. It is a price, not a
 * promise, and the widget repolls so it never shows a stale one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLIENT DECIDES NOTHING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It cannot open a market, cannot settle one, and cannot bet on a match it is playing in — the
 * server refuses all three, because a player who could bet against their own snake has a guaranteed
 * profit available. This file asks and renders.
 */
import { money, el, clamp } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';
import { api } from './api.js';
import { bus, refreshBalance } from './store.js';

const POLL_MS = 5000;

let host = null;
let timer = 0;
let board = null;

/** Mounts the overlay into a container. Safe to call repeatedly; it rebinds rather than stacking. */
export function initSideBets(mount) {
  host = mount;
  if (!host) return;
  void poll();
  bus.addEventListener('change', (event) => {
    if (event.detail === 'balance') void poll();
  });
}

export function stopSideBets() {
  window.clearTimeout(timer);
  timer = 0;
}

async function poll() {
  window.clearTimeout(timer);
  if (!host?.isConnected) return;
  try {
    board = await api.get('/v1/sidebets');
  } catch (error) {
    if (error?.code === 'SIDE_BETS_DISABLED') {
      host.replaceChildren();
      return;
    }
    timer = window.setTimeout(() => void poll(), POLL_MS * 2);
    return;
  }
  render();
  timer = window.setTimeout(() => void poll(), POLL_MS);
}

function render() {
  const markets = board?.markets ?? [];
  if (!markets.length) {
    host.replaceChildren();
    return;
  }

  const wrap = el('div', 'sbet');
  const cap = el('div', 'sbet__cap');
  cap.textContent = 'SIDE BETS';
  wrap.append(cap);

  for (const market of markets.slice(0, 3)) {
    const card = el('div', 'sbet__card');
    card.dataset.locked = market.status === 'locked' ? '1' : '0';

    const head = el('div', 'sbet__head');
    const pool = el('b', 'sbet__pool mono');
    pool.textContent = money(Number(market.poolMinor));
    const clock = el('span', 'sbet__clock mono');
    head.append(pool, clock);
    card.append(head);

    const locksAt = new Date(market.locksAt).getTime();
    const paintClock = () => {
      if (market.status === 'locked') {
        clock.textContent = 'LOCKED';
        return;
      }
      const left = Math.max(0, Math.round((locksAt - Date.now()) / 1000));
      clock.textContent = left > 0 ? `${left}s` : 'LOCKED';
    };
    paintClock();

    const sides = el('div', 'sbet__sides');
    for (const outcome of market.outcomes) {
      const side = el('button', 'sbet__side');
      side.type = 'button';
      side.dataset.name = outcome.name;
      if (market.yourBet?.outcome === outcome.name) side.dataset.mine = '1';

      const name = el('b');
      name.textContent = outcome.name;
      const multiple = el('i', 'mono');
      /* Hundredths from the server so nothing on the way here has to round a float. */
      multiple.textContent = `${(outcome.multiplierBps / 10_000).toFixed(2)}x`;
      side.append(name, multiple);

      if (market.status !== 'open' || market.yourBet) {
        side.disabled = true;
      } else {
        side.addEventListener('click', () => openBetSheet(market, outcome));
      }
      sides.append(side);
    }
    card.append(sides);

    if (market.yourBet) {
      const mine = el('div', 'sbet__mine');
      mine.textContent = `${money(Number(market.yourBet.stakeMinor))} on ${market.yourBet.outcome}`;
      card.append(mine);
    }

    wrap.append(card);
  }

  host.replaceChildren(wrap);
}

function openBetSheet(market, outcome) {
  const min = Number(board.minStakeMinor);
  const max = Number(board.maxStakeMinor);
  let stake = clamp(min, min, max);

  openModal(`Back ${outcome.name}`, (mount) => {
    const wrap = el('div', 'sbetsheet');

    const figure = el('b', 'sbetsheet__amt mono');
    const payout = el('span', 'sbetsheet__out mono');

    const paint = () => {
      stake = clamp(Math.floor(stake), min, max);
      figure.textContent = money(stake);
      /* What this stake would return at the CURRENT price, labelled as a return rather than a
       * guarantee — the pool moves under it until the market locks. */
      payout.textContent = `RETURNS ~${money(
        Math.round((stake * outcome.multiplierBps) / 10_000),
      )}`;
    };

    const chips = el('div', 'qchips');
    for (const preset of (board.presets ?? []).map(Number)) {
      const chip = el('button', 'qchip');
      chip.type = 'button';
      chip.textContent = `+${money(preset)}`;
      chip.addEventListener('click', () => {
        stake = clamp(stake + preset, min, max);
        playSound('click');
        paint();
      });
      chips.append(chip);
    }

    const go = el('button', 'btn btn--go sbetsheet__go');
    go.textContent = `BACK ${outcome.name}`;
    go.addEventListener('click', () => {
      go.disabled = true;
      void place(market, outcome, stake, go);
    });

    wrap.append(figure, payout, chips, go);
    mount.append(wrap);
    paint();
  });
}

async function place(market, outcome, stake, button) {
  try {
    const result = await api.post(`/v1/sidebets/${market.id}/bet`, {
      outcome: outcome.name,
      stakeMinor: String(stake),
    });
    playSound('coin');
    closeModal();
    toast({
      kind: 'gold',
      title: 'BET PLACED',
      body: `${money(Number(result.stakeMinor))} on ${result.outcome} at ${(
        result.multiplierBps / 10_000
      ).toFixed(2)}x`,
    });
    await refreshBalance();
    void poll();
  } catch (error) {
    button.disabled = false;
    toast({
      kind: 'lose',
      title:
        error?.code === 'IN_THE_MATCH'
          ? 'YOU ARE IN THIS ONE'
          : error?.code === 'MARKET_LOCKED'
            ? 'BETTING CLOSED'
            : 'NOT PLACED',
      body: error?.message || 'Try again',
    });
  }
}
