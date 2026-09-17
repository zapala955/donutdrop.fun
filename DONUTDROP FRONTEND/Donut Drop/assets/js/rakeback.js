/* rakeback.js — the four cash-back tiers.
 *
 * Four cards, four balances, four clocks. Everything on screen is a figure or a control; the one
 * sentence the page needs — that the rates are shares of the house margin rather than of turnover
 * — lives behind the icon in the heading, because it is the sort of thing a player reads once.
 *
 * Nothing accrues in the browser. The balances come off /v1/rakeback, which reads the same rows
 * the claim route locks, so a card can never offer money the claim would refuse. The only thing
 * that ticks locally is the cooldown, and it counts down to a server-supplied timestamp rather
 * than to a locally computed one, so it cannot drift into claiming early.
 */
import { state, bus, refreshRakeback, claimRakeback } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

/* The order is the claim cadence, fastest first, which is also how often a player will look at
 * each one. Instant sits where the eye lands. */
const TIERS = [
  { key: 'instant', name: 'Instant', clock: 'No cooldown' },
  { key: 'daily', name: 'Daily', clock: 'Every 24h' },
  { key: 'weekly', name: 'Weekly', clock: 'Every 7d' },
  { key: 'monthly', name: 'Monthly', clock: 'Every 30d' },
];

let root = null;
let ticker = 0;
let claiming = '';

export function mountRakeback(view) {
  root = $('#rakeRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'private', 'rakeback'].includes(event.detail)) paint();
    });
  }
  if (state.authenticated) refreshRakeback(false).then(paint).catch(() => undefined);
  paint();
  startTicker();
}

/* One interval for every countdown on the page rather than one each. The cards are re-rendered
 * wholesale on any state change, so the timer re-reads the DOM each tick and stops itself once
 * the nodes it was driving are gone. */
function startTicker() {
  if (ticker) window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    const nodes = root?.isConnected ? root.querySelectorAll('[data-ready-at]') : [];
    if (!root?.isConnected) {
      window.clearInterval(ticker);
      ticker = 0;
      return;
    }
    let expired = false;
    for (const node of nodes) {
      const remaining = new Date(node.dataset.readyAt).getTime() - Date.now();
      if (remaining <= 0) {
        expired = true;
        continue;
      }
      node.textContent = formatRemaining(remaining);
    }
    // A clock that just ran out changes a button from disabled to armed, which is a repaint the
    // ticker cannot do itself without the server's word for the new balance.
    if (expired) refreshRakeback().catch(() => undefined);
  }, 1000);
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to collect rakeback.'));
    return;
  }
  const data = state.rakeback;
  if (!data) {
    root.appendChild(notice('Rakeback is not switched on yet.'));
    return;
  }

  root.appendChild(summary(data));

  const grid = el('div', 'rake__grid');
  const byTier = new Map(data.tiers.map((tier) => [tier.tier, tier]));
  for (const meta of TIERS) {
    const tier = byTier.get(meta.key);
    if (tier) grid.appendChild(tierCard(meta, tier));
  }
  root.appendChild(grid);

  if (data.history.length) root.appendChild(historyTable(data.history));
}

function notice(message) {
  const card = el('div', 'rake__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function summary(data) {
  const wrap = el('div', 'rake__summary');
  for (const [label, value, gold] of [
    ['Claimable now', money(Number(data.totals.claimableMinor)), true],
    ['Claimed lifetime', money(Number(data.totals.lifetimeMinor)), false],
    ['House edge', `${(data.houseEdgeBps / 100).toFixed(2)}%`, false],
  ]) {
    const cell = el('div', 'rake__sumcell');
    const key = el('span', 'rake__sumk');
    key.textContent = label;
    const figure = el('b', `rake__sumv${gold ? ' rake__sumv--gold' : ''}`);
    figure.textContent = value;
    cell.append(key, figure);
    wrap.appendChild(cell);
  }
  return wrap;
}

function tierCard(meta, tier) {
  const card = el('article', 'rake__card');
  card.dataset.tier = meta.key;
  card.dataset.armed = tier.claimable ? '1' : '0';

  const head = el('header', 'rake__head');
  const name = el('span', 'rake__name');
  name.textContent = meta.name;
  const rate = el('span', 'rake__rate mono');
  // Of the margin. The heading's icon carries that qualifier once for the whole page rather than
  // four times here.
  rate.textContent = `${(tier.rateBps / 100).toFixed(0)}%`;
  head.append(name, rate);

  const figure = el('b', 'rake__figure mono');
  figure.textContent = money(Number(tier.claimableMinor));

  const meter = el('div', 'rake__meter');
  const clock = el('span', 'rake__clock mono');
  if (tier.availableAt) {
    clock.dataset.readyAt = tier.availableAt;
    clock.textContent = formatRemaining(new Date(tier.availableAt).getTime() - Date.now());
  } else {
    clock.textContent = meta.clock;
  }
  const lifetime = el('span', 'rake__life mono');
  lifetime.textContent = money(Number(tier.claimedMinor));
  meter.append(clock, lifetime);

  const button = el('button', 'btn btn--go rake__claim');
  button.type = 'button';
  button.textContent = claiming === meta.key ? 'CLAIMING…' : 'CLAIM CASH';
  button.disabled = !tier.claimable || claiming === meta.key;
  button.addEventListener('click', () => claim(meta.key));

  card.append(head, figure, meter, button);
  return card;
}

async function claim(tier) {
  if (claiming) return;
  claiming = tier;
  paint();
  try {
    const result = await claimRakeback(tier);
    playSound('coin');
    toast({ kind: 'gold', title: 'Rakeback claimed', body: money(Number(result.claimedMinor)) });
  } catch (error) {
    toast({
      kind: 'lose',
      title: error?.code === 'RAKEBACK_COOLING_DOWN' ? 'Still on cooldown' : 'Nothing to claim',
      body: error?.message || '',
    });
    // The refusal usually means this client's snapshot is stale, so take the server's word for it.
    await refreshRakeback(false).catch(() => undefined);
  } finally {
    claiming = '';
    paint();
  }
}

function historyTable(history) {
  const card = el('section', 'rake__history');
  const label = el('span', 'rake__label');
  label.textContent = 'Recent claims';
  card.appendChild(label);

  const table = el('table', 'dtable');
  const body = el('tbody');
  for (const entry of history) {
    const row = el('tr');
    const tier = el('td');
    tier.textContent = entry.tier;
    const amount = el('td', 'dtable__num mono');
    amount.textContent = money(Number(entry.amountMinor));
    const when = el('td', 'dtable__num mono dtable__dim');
    when.textContent = new Date(entry.createdAt).toLocaleDateString();
    row.append(tier, amount, when);
    body.appendChild(row);
  }
  table.appendChild(body);
  card.appendChild(table);
  return card;
}
