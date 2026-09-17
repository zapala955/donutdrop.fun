/* piggy.js — the Nether Piggy Bank and the cash-out desk.
 *
 * Lock cash for a fixed term at a rate frozen when the deposit opens, or break early for your
 * principal back. Both figures come from the server; the quote shown before you commit mirrors
 * the server's formula exactly, because showing one number before the click and a different one
 * after is its own kind of broken.
 */
import {
  state, bus, openPiggyBank, settlePiggyBank, refreshPiggy, refreshVaultConfig,
} from './store.js';
import { $, el, money, parseAmount, formatAmountInput } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';

const DAY_MS = 86_400_000;
let root = null;
let tickTimer = 0;

export function mountPiggy(view) {
  root = $('#piggyRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', () => {
      if (root.isConnected) paint();
    });
    if (state.authenticated) {
      Promise.all([refreshVaultConfig(false), refreshPiggy()]).catch(() => undefined);
    }
  }
  paint();
  startTick();
}

function startTick() {
  if (tickTimer) window.clearInterval(tickTimer);
  tickTimer = window.setInterval(() => {
    if (!root?.isConnected) {
      window.clearInterval(tickTimer);
      tickTimer = 0;
      return;
    }
    root.querySelectorAll('[data-unlocks]').forEach((node) => {
      const unlocksAt = Number(node.dataset.unlocks);
      node.textContent = formatRemaining(unlocksAt - Date.now());
    });
  }, 1000);
}

function paint() {
  if (!root?.isConnected) return;

  if (!state.authenticated) {
    root.innerHTML = '<section class="card"><h2 class="card__h">Log in to use the Piggy Bank</h2></section>';
    return;
  }

  const config = state.vaultConfig?.piggyBank;
  if (!config?.enabled) {
    root.innerHTML = '<section class="card"><h2 class="card__h">The Piggy Bank is closed</h2></section>';
    return;
  }

  const deposits = state.piggyDeposits || [];
  const locked = deposits
    .filter((entry) => entry.state === 'open')
    .reduce((sum, entry) => sum + entry.principal, 0);
  const maturing = deposits
    .filter((entry) => entry.state === 'open')
    .reduce((sum, entry) => sum + (entry.maturedPayout - entry.principal), 0);

  root.innerHTML = `
    <section class="piggyhead glass">
      <div class="piggyhead__main">
        <span class="piggyhead__label">Locked away</span>
        <b class="piggyhead__figure mono">${money(locked)}</b>
        <span class="piggyhead__sub">
          ${money(maturing)} of interest waiting at maturity · ${((config.aprBps || 0) / 100).toFixed(0)}% APR
        </span>
      </div>
      <div class="piggyhead__side">
        <span class="piggyhead__avail">Available</span>
        <b class="mono">${money(state.balance)}</b>
      </div>
    </section>

    <section class="card">
      <h2 class="card__h">Open a deposit <span>minimum ${config.minLockDays} days</span>
        <button class="ihint" type="button" aria-label="The payout is fixed when you open it; the rate cannot move while your money is in."
                data-tip="The payout is fixed when you open it; the rate cannot move while your money is in."></button>
      </h2>
      <div class="piggy__open" id="piggyOpen"></div>
    </section>

    <section class="card">
      <h2 class="card__h">Your deposits <span>${deposits.filter((d) => d.state === 'open').length} open</span></h2>
      <div class="piggy__list" id="piggyList"></div>
    </section>`;

  paintForm($('#piggyOpen', root), config);
  paintDeposits($('#piggyList', root));
}

function paintForm(mount, config) {
  const minDays = Number(config.minLockDays || 14);
  const maxDays = Number(config.maxLockDays || 90);
  const minDeposit = Number(config.minDepositMinor || 0);

  mount.innerHTML = `
    <div class="piggy__form">
      <label class="piggy__field">
        <span>Amount</span>
        <span class="amountbox">
          <span class="amountbox__cur">$</span>
          <input class="amountbox__in mono" id="piggyAmount" inputmode="text"
                 autocomplete="off" spellcheck="false" value="${formatAmountInput(minDeposit)}"
                 aria-describedby="piggyAmountHint">
        </span>
        <span class="piggy__hint" id="piggyAmountHint">Minimum ${money(minDeposit)}</span>
      </label>

      <div class="qchips" id="piggyChips" role="group" aria-label="Quick amounts"></div>

      <label class="piggy__field">
        <span>Lock for <b class="mono" id="piggyDaysOut">${minDays}</b> days</span>
        <input class="piggy__range" id="piggyDays" type="range"
               min="${minDays}" max="${maxDays}" value="${minDays}" step="1" aria-label="Lock days">
      </label>

      <div class="piggy__quote">
        <span class="piggy__row"><i>Pays out</i><b class="mono piggy__gold" id="piggyPayout">—</b></span>
        <span class="piggy__row"><i>Interest</i><b class="mono" id="piggyInterest">—</b></span>
        <span class="piggy__row"><i>Unlocks</i><b class="mono" id="piggyUnlocks">—</b></span>
      </div>

      <div class="piggy__commit">
        <button class="btn btn--go" id="piggySubmit" type="button">Lock it away</button>
        <button class="ihint" type="button" aria-label="Break early and your principal comes straight back; only the interest is forfeit."
                data-tip="Break early and your principal comes straight back; only the interest is forfeit."></button>
      </div>
    </div>`;

  const amount = $('#piggyAmount', root);
  const days = $('#piggyDays', root);
  const hint = $('#piggyAmountHint', root);

  /* The same additive ladder as the upgrader's stake box, for the same reason: a chip that names
   * the figure it adds needs no reading, where "50%" cannot be understood without first looking up
   * your own balance. Every value is clamped into range by setAmount. */
  const chips = $('#piggyChips', root);
  const setAmount = (value) => {
    amount.value = formatAmountInput(Math.max(0, Math.min(Math.trunc(value), state.balance)));
    quote();
  };
  const current = () => parseAmount(amount.value) ?? 0;

  for (const [label, step] of [['+$100K', 100_000], ['+$1M', 1_000_000], ['+$10M', 10_000_000]]) {
    const chip = el('button', 'qchip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => setAmount(current() + step));
    chips.appendChild(chip);
  }
  const half = el('button', 'qchip', '&frac12;x');
  half.type = 'button';
  half.addEventListener('click', () => setAmount(Math.floor(current() / 2)));
  const double = el('button', 'qchip', '2x');
  double.type = 'button';
  double.addEventListener('click', () => setAmount(current() * 2));
  const max = el('button', 'qchip qchip--max', 'MAX');
  max.type = 'button';
  max.addEventListener('click', () => setAmount(state.balance));
  chips.append(half, double, max);

  function quote() {
    const parsed = parseAmount(amount.value);
    const lockDays = Number(days.value);
    $('#piggyDaysOut', root).textContent = String(lockDays);

    const span = Number(days.max) - Number(days.min);
    days.style.setProperty('--fill', span > 0 ? `${((lockDays - Number(days.min)) / span) * 100}%` : '0%');

    if (parsed === null) {
      hint.textContent = 'Not an amount';
      hint.dataset.bad = '1';
      $('#piggyPayout', root).textContent = '—';
      $('#piggyInterest', root).textContent = '—';
    } else {
      delete hint.dataset.bad;
      hint.textContent =
        parsed < minDeposit
          ? `Minimum ${money(minDeposit)}`
          : parsed > state.balance
            ? `Over ${money(state.balance)}`
            : money(parsed);
      const payout = maturedPayoutMinor(BigInt(parsed), Number(config.aprBps), lockDays);
      $('#piggyPayout', root).textContent = parsed > 0 ? money(Number(payout)) : '—';
      $('#piggyInterest', root).textContent =
        parsed > 0 ? '+' + money(Number(payout) - parsed) : '—';
    }
    $('#piggyUnlocks', root).textContent = new Date(Date.now() + lockDays * DAY_MS)
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  amount.addEventListener('input', quote);
  amount.addEventListener('blur', () => {
    const parsed = parseAmount(amount.value);
    if (parsed !== null) amount.value = formatAmountInput(parsed);
    quote();
  });
  days.addEventListener('input', quote);
  quote();

  $('#piggySubmit', root).addEventListener('click', async () => {
    const button = $('#piggySubmit', root);
    const parsed = parseAmount(amount.value);
    if (parsed === null) {
      toast({ kind: 'lose', title: 'Not an amount', body: 'Try 1m, 250k, or 1000000.' });
      return;
    }
    if (parsed < minDeposit) {
      toast({ kind: 'lose', title: 'Below the minimum', body: `Deposits start at ${money(minDeposit)}.` });
      return;
    }
    if (parsed > state.balance) {
      toast({ kind: 'lose', title: 'Not enough balance', body: `That deposit is ${money(parsed)}.` });
      return;
    }
    button.disabled = true;
    try {
      const deposit = await openPiggyBank(parsed, Number(days.value));
      playSound('coin');
      toast({
        kind: 'win',
        title: 'Locked away',
        body: `${money(deposit.principal)} for ${deposit.lockDays} days, pays ${money(deposit.maturedPayout)}.`,
      });
    } catch (error) {
      button.disabled = false;
      showError(error);
    }
  });
}

/* Mirrors the server's simple-interest formula exactly. If these ever disagree the server wins,
 * but quoting one figure before the click and paying a different one after is indefensible. */
function maturedPayoutMinor(principalMinor, aprBps, lockDays) {
  if (principalMinor <= 0n || aprBps <= 0 || lockDays <= 0) return principalMinor;
  const interest =
    (principalMinor * BigInt(Math.trunc(aprBps)) * BigInt(Math.trunc(lockDays))) / (10_000n * 365n);
  return principalMinor + interest;
}

function paintDeposits(mount) {
  const deposits = state.piggyDeposits || [];
  if (!deposits.length) {
    mount.innerHTML = '<p class="empty">No deposits yet.</p>';
    return;
  }
  mount.innerHTML = '';

  deposits.forEach((deposit) => {
    const row = el('article', 'piggycard');
    row.dataset.state = deposit.state;
    const left = deposit.unlocksAt ? deposit.unlocksAt.getTime() - Date.now() : 0;
    const matured = deposit.state === 'open' && left <= 0;

    row.innerHTML = `
      <div class="piggycard__main">
        <b class="piggycard__amount mono">${money(deposit.principal)}</b>
        <span class="piggycard__terms">${deposit.lockDays}d · ${(deposit.aprBps / 100).toFixed(0)}% APR</span>
      </div>
      <div class="piggycard__status">
        ${deposit.state === 'claimed'
          ? `<span class="piggycard__done">claimed ${money(deposit.payout)}</span>`
          : deposit.state === 'broken'
            ? `<span class="piggycard__broke">broken · ${money(deposit.payout)} returned</span>`
            : matured
              ? `<span class="piggycard__ready">matured · ${money(deposit.maturedPayout)} waiting</span>`
              : `<span class="piggycard__wait">unlocks in <b class="mono" data-unlocks="${deposit.unlocksAt?.getTime() ?? 0}">${formatRemaining(left)}</b></span>`}
      </div>`;

    if (deposit.state === 'open') {
      const action = el(
        'button',
        matured ? 'btn btn--go btn--tiny' : 'btn btn--tiny',
        matured ? `Claim ${money(deposit.maturedPayout)}` : 'Break early',
      );
      action.type = 'button';
      action.addEventListener('click', () => {
        if (matured) return settle(deposit, action);
        confirmBreak(deposit, action, left);
      });
      row.appendChild(action);
    }
    mount.appendChild(row);
  });
}

function confirmBreak(deposit, button, left) {
  const lost = deposit.maturedPayout - deposit.principal;
  openModal('Break this deposit?', (body) => {
    body.innerHTML = `
      <p>Breaking early returns your <b>${money(deposit.principal)}</b> principal now and forfeits
        <b>${money(lost)}</b> of interest. This cannot be undone.</p>
      <div class="kv"><span>unlocks in</span><span class="mono">${formatRemaining(left)}</span></div>
      <div class="modal__row">
        <button class="btn" id="breakNo" type="button">Keep it locked</button>
        <button class="btn btn--withdraw" id="breakYes" type="button">Break and forfeit ${money(lost)}</button>
      </div>`;
    $('#breakNo', body).addEventListener('click', closeModal);
    $('#breakYes', body).addEventListener('click', () => {
      closeModal();
      settle(deposit, button);
    });
  });
}

async function settle(deposit, button) {
  button.disabled = true;
  try {
    const result = await settlePiggyBank(deposit.id);
    playSound(result.state === 'claimed' ? 'reward' : 'lose');
    toast({
      kind: result.state === 'claimed' ? 'win' : 'lose',
      title: result.state === 'claimed' ? 'Deposit matured' : 'Deposit broken',
      body: `+${money(result.payout)} returned to your balance`,
    });
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
}

/* ─────────── the cash-out desk ───────────
 * Breaking every open deposit is the one genuinely instant cash-out this platform has: the money
 * is already yours, it is just locked, and principal comes back immediately. This is stated
 * plainly rather than dressed up as a withdrawal to an outside account, which does not exist.
 */
export function openWithdrawDesk() {
  openModal('Cash out', (body) => {
    const open = (state.piggyDeposits || []).filter((entry) => entry.state === 'open');
    const lockedTotal = open.reduce((sum, entry) => sum + entry.principal, 0);
    const forfeit = open.reduce((sum, entry) => sum + (entry.maturedPayout - entry.principal), 0);

    body.innerHTML = `
      <p>Your balance is liquid and spendable right now &mdash; in crates, in the upgrader, and in
        the Piggy Bank.</p>
      <div class="kv"><span>available now</span><span class="mono">${money(state.balance)}</span></div>
      <div class="kv"><span>locked in deposits</span><span class="mono">${money(lockedTotal)}</span></div>
      ${open.length
        ? `<p class="modal__note">Releasing every open deposit returns <b>${money(lockedTotal)}</b>
             immediately and gives up <b>${money(forfeit)}</b> of interest that would have been
             paid at maturity.</p>
           <div class="modal__row">
             <button class="btn" id="wdNo" type="button">Leave them locked</button>
             <button class="btn btn--withdraw" id="wdAll" type="button">Release all · ${money(lockedTotal)}</button>
           </div>`
        : '<p class="modal__note">Nothing is locked. Your whole balance is already available.</p>'}`;

    const no = $('#wdNo', body);
    if (no) no.addEventListener('click', closeModal);

    const all = $('#wdAll', body);
    if (all) {
      all.addEventListener('click', async () => {
        all.disabled = true;
        let released = 0;
        let failed = 0;
        for (const deposit of open) {
          try {
            const result = await settlePiggyBank(deposit.id);
            released += result.payout ?? 0;
          } catch {
            // One deposit failing must not abandon the rest; report the count at the end.
            failed += 1;
          }
        }
        closeModal();
        playSound('coin');
        toast({
          kind: failed ? 'lose' : 'win',
          title: failed ? `Released ${open.length - failed} of ${open.length}` : 'Deposits released',
          body: `+${money(released)} back in your balance`,
        });
      });
    }
  });
}

function formatRemaining(milliseconds) {
  if (milliseconds <= 0) return 'now';
  const days = Math.floor(milliseconds / DAY_MS);
  const hours = Math.floor((milliseconds % DAY_MS) / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function showError(error) {
  toast({
    kind: 'lose',
    title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Request failed',
    body: error?.message || 'The server rejected the request.',
  });
}
