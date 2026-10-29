/* staking.js — the house pool on the Rewards page (services/api-gateway/src/lib/staking.ts).
 *
 * A player stakes balance and shares the house's daily game result, the losing days as well as the
 * winning ones. Everything shown is the server's: the terms, how full the pool is, what each 1B in
 * it made or lost on every settled day, and the player's own stakes. The page never estimates a
 * return; a past day is a fact, not a forecast, and the copy says so.
 */
import { api } from './api.js';
import { state, bus, refreshBalance } from './store.js';
import { toast } from './ui.js';
import { el, money, parseAmount } from './util.js';

let root = null;
let view = null;
let status = 'idle'; // idle · loading · ready · error
let busy = false;

function text(tag, cls, value) {
  const node = el(tag, cls);
  node.textContent = value;
  return node;
}

/** "in 1d 6h", "in 40m". */
function inTime(iso) {
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return 'any moment';
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.max(1, minutes)}m`;
}

const signed = (minor) => {
  const value = Number(minor) || 0;
  return value > 0 ? `+${money(value)}` : money(value);
};

export function mountStaking(container) {
  root = container;
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      /* 'ready' and 'private': the session is restored after the page mounts, on a reload. */
      if (root?.isConnected && ['login', 'logout', 'ready', 'private'].includes(event.detail)) void load();
      if (root?.isConnected && event.detail === 'balance') paint();
    });
    /* A day settled or a stake came back: the bell hears first (live.js), and so do we. */
    window.addEventListener('donut:notice', () => {
      if (root?.isConnected) void load();
    });
  }
  void load();
  paint();
}

async function load() {
  if (!view) status = 'loading';
  try {
    view = await api.get('/v1/staking');
    status = 'ready';
  } catch (error) {
    if (!view) status = 'error';
    console.warn('[donutluxe] house pool failed', error?.code || error);
  }
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  root.replaceChildren();
  if (!view) {
    if (status === 'loading') root.appendChild(text('p', 'pool__note', 'Loading the house pool…'));
    return;
  }
  const hasStakes = Boolean(view.you?.lots?.length);
  if (!view.enabled && !hasStakes) return;

  const share = (view.shareBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const head = el('div', 'pool__head');
  head.append(
    text('h2', 'pool__title', 'House pool'),
    text(
      'p',
      'pool__lede',
      `Be the house. A full pool shares ${share}% of the house's game result every UTC day, the ` +
        `losing days as well as the winning ones, split by stake. A stake earns from the next full ` +
        `day; unstaking takes ${view.unstakeHours}h and the stake keeps sharing results until then.`,
    ),
  );
  root.appendChild(head);

  const grid = el('div', 'pool__grid');
  grid.append(poolCard(), historyCard());
  root.appendChild(grid);

  if (!state.authenticated) {
    root.appendChild(text('p', 'pool__note', 'Log in to stake.'));
    return;
  }
  root.appendChild(mineCard());
}

function poolCard() {
  const card = el('section', 'pool__card');
  const staked = Number(view.pool.stakedMinor);
  const cap = Number(view.poolCapMinor);
  card.appendChild(text('h3', 'pool__sub', 'The pool'));
  card.appendChild(text('div', 'pool__big', `${money(staked)} of ${money(cap)}`));
  const bar = el('div', 'pool__bar');
  const fill = el('span', 'pool__fill');
  fill.style.width = `${Math.min(100, cap > 0 ? (staked / cap) * 100 : 0).toFixed(1)}%`;
  bar.appendChild(fill);
  card.appendChild(bar);
  card.appendChild(
    text(
      'p',
      'pool__note',
      `${view.pool.stakers} staker${view.pool.stakers === 1 ? '' : 's'} · ` +
        `${money(Number(view.minStakeMinor))} to ${money(Number(view.maxPerPlayerMinor))} per player`,
    ),
  );
  if (view.enabled && state.authenticated) card.appendChild(stakeForm());
  else if (!view.enabled) card.appendChild(text('p', 'pool__note', 'The pool takes no new stakes right now.'));
  return card;
}

function stakeForm() {
  const form = el('form', 'pool__form');
  const input = el('input', 'pool__input');
  input.placeholder = 'Amount, e.g. 100m';
  input.autocomplete = 'off';
  input.inputMode = 'decimal';
  const max = text('button', 'pool__chip', 'Max');
  max.type = 'button';
  max.addEventListener('click', () => {
    const room = Number(view.poolCapMinor) - Number(view.pool.stakedMinor);
    const mine = (view.you?.lots ?? [])
      .filter((lot) => lot.status !== 'closed')
      .reduce((sum, lot) => sum + Number(lot.principalMinor), 0);
    const amount = Math.max(
      0,
      Math.min(Number(state.balanceMinor || 0), room, Number(view.maxPerPlayerMinor) - mine),
    );
    input.value = String(Math.floor(amount));
  });
  const go = text('button', 'pool__go', 'Stake');
  go.type = 'submit';
  form.append(input, max, go);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const amount = parseAmount(input.value);
    if (!amount) {
      toast({ title: 'Enter an amount', body: 'Try 100m or 1b.', kind: 'lose' });
      return;
    }
    busy = true;
    go.disabled = true;
    try {
      const result = await api.post('/v1/staking/stake', { amountMinor: String(Math.round(amount)) });
      toast({ title: 'Staked', body: `${money(amount)} earns from ${result.earningFrom} (UTC).`, kind: 'win' });
      input.value = '';
      await Promise.allSettled([refreshBalance(false), load()]);
    } catch (error) {
      toast({ title: 'Not staked', body: error?.message || 'Try again.', kind: 'lose' });
    } finally {
      busy = false;
      go.disabled = false;
    }
  });
  return form;
}

function historyCard() {
  const card = el('section', 'pool__card');
  card.appendChild(text('h3', 'pool__sub', 'Per 1B staked, by day'));
  const days = (view.days ?? []).filter((day) => day.per1bMinor !== null).slice(0, 14);
  if (!days.length) {
    card.appendChild(text('p', 'pool__note', 'No day has been settled yet.'));
    return card;
  }
  const peak = Math.max(...days.map((day) => Math.abs(Number(day.per1bMinor))), 1);
  const chart = el('div', 'pool__chart');
  for (const day of [...days].reverse()) {
    const value = Number(day.per1bMinor);
    const bar = el('span', 'pool__day');
    bar.dataset.tone = value < 0 ? 'loss' : 'gain';
    bar.style.setProperty('--h', `${Math.max(4, (Math.abs(value) / peak) * 100).toFixed(1)}%`);
    bar.title = `${day.day}: ${signed(value)} per 1B`;
    chart.appendChild(bar);
  }
  card.appendChild(chart);
  const total = days.reduce((sum, day) => sum + Number(day.per1bMinor), 0);
  card.appendChild(
    text(
      'p',
      'pool__note',
      `Last ${days.length} settled day${days.length === 1 ? '' : 's'}: ${signed(total)} per 1B. Past days are not a promise.`,
    ),
  );
  return card;
}

function mineCard() {
  const card = el('section', 'pool__card pool__mine');
  card.appendChild(text('h3', 'pool__sub', 'Your stakes'));
  const you = view.you;
  if (!you?.lots?.length) {
    card.appendChild(text('p', 'pool__note', 'You have nothing staked.'));
    return card;
  }
  card.appendChild(
    text('p', 'pool__totals', `Earned ${money(Number(you.earnedMinor))} · Lost ${money(Number(you.lostMinor))}`),
  );
  const list = el('ul', 'pool__lots');
  const today = new Date().toISOString().slice(0, 10);
  for (const lot of you.lots) {
    const row = el('li', 'pool__lot');
    row.dataset.status = lot.status;
    const amount = el('div', 'pool__lotamt');
    amount.append(
      text('strong', '', money(Number(lot.principalMinor))),
      text('span', 'pool__dim', lot.principalMinor === lot.originalMinor ? '' : ` of ${money(Number(lot.originalMinor))}`),
    );
    let state_ = '';
    if (lot.status === 'closed') state_ = 'Paid back';
    else if (lot.status === 'unstaking') state_ = `Unstaking · back ${inTime(lot.unlocksAt)}`;
    else if (lot.earningFrom > today) state_ = `Earns from ${lot.earningFrom}`;
    else state_ = 'Earning';
    row.append(amount, text('span', 'pool__state', state_));
    if (lot.status === 'active') {
      const out = text('button', 'pool__chip', 'Unstake');
      out.type = 'button';
      out.addEventListener('click', async () => {
        if (busy) return;
        if (!window.confirm(`Unstake ${money(Number(lot.principalMinor))}? It keeps sharing results for ${view.unstakeHours}h, then comes back to your balance.`)) return;
        busy = true;
        out.disabled = true;
        try {
          const result = await api.post(`/v1/staking/lots/${lot.id}/unstake`, {});
          toast({ title: 'Unstaking', body: `Back ${inTime(result.unlocksAt)}.`, kind: 'win' });
          await load();
        } catch (error) {
          out.disabled = false;
          toast({ title: 'Not unstaked', body: error?.message || 'Try again.', kind: 'lose' });
        } finally {
          busy = false;
        }
      });
      row.appendChild(out);
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}
