/* autobet.js — Manual and Auto over a game's bet panel, as in the redesign preview (2026-11-20).
 *
 * Auto places the game's own single bet again and again, through the same function the Bet button
 * calls, so every round is an ordinary bet: sent to the server, settled there, held and shown like
 * a manual one. Nothing here decides an outcome or touches a balance. Between rounds it only does
 * what the player set: the stake back to where it started, or up by a percentage, after a win or a
 * loss. It stops after the number of bets asked for (0 runs until stopped), when the profit or the
 * loss reaches the figure set, when a bet does not go through (the game's own checks: the balance,
 * the table's limits), when the player presses Stop, and when the game is no longer on screen.
 */

import { $, formatAmountInput, parseAmount } from './util.js';

const GAP_MS = 240;

/** The Manual / Auto switch, for the top of the panel. */
export function autoSwitch(id) {
  return `<div class="lxauto__seg" role="group" aria-label="Bet mode">
      <button type="button" data-automode="manual" aria-pressed="true">Manual</button>
      <button type="button" data-automode="auto" aria-pressed="false" aria-controls="${id}Auto">Auto</button>
    </div>`;
}

/** The settings, for under the stake. Hidden until Auto is picked. */
export function autoFields(id) {
  const side = (key, label) => `
      <div class="lxauto__field">
        <span class="lxauto__label" id="${id}On${key}L">On ${label}</span>
        <div class="lxauto__inp">
          <div class="lxauto__minis" role="group" aria-labelledby="${id}On${key}L">
            <button type="button" data-auto${key}="reset" aria-pressed="true">Reset</button>
            <button type="button" data-auto${key}="raise" aria-pressed="false">Increase</button>
          </div>
          <input id="${id}On${key}" inputmode="decimal" value="0" disabled aria-label="Increase on ${label} by percent" />
          <span class="lxauto__suf" aria-hidden="true">%</span>
        </div>
      </div>`;
  return `<div class="lxauto" id="${id}Auto" hidden>
      <div class="lxauto__field">
        <label class="lxauto__label" for="${id}AutoN">Number of bets</label>
        <div class="lxauto__inp">
          <input id="${id}AutoN" inputmode="numeric" value="10" autocomplete="off" />
          <span class="lxauto__suf">0 = no limit</span>
        </div>
      </div>
      ${side('win', 'win')}
      ${side('loss', 'loss')}
      <div class="lxauto__row">
        <div class="lxauto__field">
          <label class="lxauto__label" for="${id}StopP">Stop on profit</label>
          <div class="lxauto__inp"><span class="lxauto__pre" aria-hidden="true">$</span><input id="${id}StopP" inputmode="text" value="0" autocomplete="off" /></div>
        </div>
        <div class="lxauto__field">
          <label class="lxauto__label" for="${id}StopL">Stop on loss</label>
          <div class="lxauto__inp"><span class="lxauto__pre" aria-hidden="true">$</span><input id="${id}StopL" inputmode="text" value="0" autocomplete="off" /></div>
        </div>
      </div>
    </div>`;
}

/**
 * Wires the switch and the settings in `root`.
 *
 * game.betOnce()   one ordinary bet; resolves to the settled bet ({ stakeMinor, payoutMinor }) or
 *                  null when it did not go through
 * game.getStake()  the stake in the field now, as a bigint, or null
 * game.setStake(n) puts a stake (bigint) in the field
 * game.paint()     repaints the panel (the button reads auto.label() and auto.running)
 */
export function wireAuto(root, id, game) {
  const auto = {
    mode: 'manual',
    running: false,
    /** The Bet button's words: the game's own in Manual, Start or Stop in Auto. */
    label(manual) {
      if (this.mode !== 'auto') return manual;
      return this.running ? 'Stop autobet' : 'Start autobet';
    },
    /** In Auto the button starts and stops the run instead of placing one bet. */
    toggle() {
      if (this.running) this.stop();
      else void run();
      game.paint();
    },
    /* A game whose bet waits for something (Crash waits for a round to open) drops the wait. */
    stop() {
      this.running = false;
      game.cancel?.();
    },
  };
  const box = $(`#${id}Auto`, root);
  const on = { win: 'reset', loss: 'reset' };

  for (const button of root.querySelectorAll('[data-automode]')) {
    button.addEventListener('click', () => {
      if (auto.running) return;
      auto.mode = button.dataset.automode;
      for (const other of root.querySelectorAll('[data-automode]')) other.setAttribute('aria-pressed', String(other === button));
      box.hidden = auto.mode !== 'auto';
      game.paint();
    });
  }
  for (const key of ['win', 'loss']) {
    for (const button of root.querySelectorAll(`[data-auto${key}]`)) {
      button.addEventListener('click', () => {
        on[key] = button.dataset[`auto${key}`];
        for (const other of root.querySelectorAll(`[data-auto${key}]`)) other.setAttribute('aria-pressed', String(other === button));
        $(`#${id}On${key}`, root).disabled = on[key] === 'reset';
      });
    }
  }

  const figure = (input) => {
    const value = parseAmount(input.value);
    return value === null || value < 0 ? 0n : BigInt(value);
  };
  const percent = (key) => Math.max(0, Number.parseFloat($(`#${id}On${key}`, root).value) || 0);
  const next = (won, current, base) => {
    const key = won ? 'win' : 'loss';
    if (on[key] === 'reset') return base;
    // Up by the percentage, in basis points so a bigint stays whole: 50% of $1M is $500K more.
    const bps = BigInt(Math.round(percent(key) * 100));
    return current + (current * bps) / 10_000n;
  };
  const lock = (locked) => {
    for (const input of box.querySelectorAll('input, button')) {
      if (input.matches('input[id$="Onwin"], input[id$="Onloss"]')) input.disabled = locked || on[input.id.endsWith('Onwin') ? 'win' : 'loss'] === 'reset';
      else input.disabled = locked;
    }
    for (const button of root.querySelectorAll('[data-automode]')) button.disabled = locked;
  };

  async function run() {
    const base = game.getStake();
    if (base === null || base <= 0n) return;
    const count = Math.max(0, Number.parseInt($(`#${id}AutoN`, root).value, 10) || 0);
    const stopProfit = figure($(`#${id}StopP`, root));
    const stopLoss = figure($(`#${id}StopL`, root));
    const counter = $(`#${id}AutoN`, root);
    let stake = base;
    let net = 0n;
    let done = 0;
    auto.running = true;
    lock(true);
    game.paint();
    try {
      while (auto.running && root.isConnected && root.offsetParent !== null) {
        game.setStake(stake);
        const bet = await game.betOnce();
        if (!bet) break;
        const placed = BigInt(bet.stakeMinor);
        const paid = BigInt(bet.payoutMinor);
        net += paid - placed;
        done += 1;
        if (count > 0) counter.value = String(count - done);
        stake = next(paid > placed, stake, base);
        if (count > 0 && done >= count) break;
        if (stopProfit > 0n && net >= stopProfit) break;
        if (stopLoss > 0n && -net >= stopLoss) break;
        await new Promise((resolve) => setTimeout(resolve, GAP_MS));
      }
    } finally {
      auto.running = false;
      lock(false);
      if (count > 0) counter.value = String(count);
      game.setStake(base);
      game.paint();
    }
  }

  return auto;
}

/** The stake field's text for a bigint, the way the games write it. */
export function stakeText(minor) {
  return formatAmountInput(Number(minor));
}
