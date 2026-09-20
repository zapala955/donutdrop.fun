/* rewards.js — claimable referral rewards and the optional rakeback tiers in one place. */
import {
  state,
  bus,
  refreshReferrals,
  claimReferralRewards,
  refreshRakeback,
  claimRakeback,
} from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const TIERS = [
  { key: 'instant', name: 'Instant', clock: 'No cooldown' },
  { key: 'daily', name: 'Daily', clock: 'Every 24h' },
  { key: 'weekly', name: 'Weekly', clock: 'Every 7d' },
  { key: 'monthly', name: 'Monthly', clock: 'Every 30d' },
];

let root = null;
let ticker = 0;
let claiming = '';

export function mountRewards(view) {
  root = $('#rewardsRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'private', 'referrals', 'rakeback'].includes(event.detail)) {
        paint();
      }
    });
  }
  if (state.authenticated) {
    Promise.all([refreshReferrals(false), refreshRakeback(false)])
      .then(paint)
      .catch(() => undefined);
  }
  paint();
  startTicker();
}

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
      if (remaining <= 0) expired = true;
      else node.textContent = formatRemaining(remaining);
    }
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
  root.replaceChildren();

  if (!state.authenticated) {
    root.appendChild(notice('Log in to view and claim your rewards.'));
    return;
  }

  const referrals = state.referrals;
  const rakeback = state.rakeback;
  if (!referrals && !rakeback) {
    root.appendChild(notice('Rewards are not switched on yet.'));
    return;
  }

  root.appendChild(summary(referrals, rakeback));

  if (referrals) {
    const section = el('section', 'rake__section');
    section.appendChild(sectionTitle('Referral rewards'));
    section.appendChild(referralCard(referrals));
    if (referrals.claims?.length) {
      section.appendChild(historyTable('Recent referral claims', referrals.claims, 'Referral share'));
    }
    root.appendChild(section);
  }

  if (rakeback) {
    const section = el('section', 'rake__section');
    section.appendChild(sectionTitle('Rakeback tiers'));
    const grid = el('div', 'rake__grid');
    const byTier = new Map(rakeback.tiers.map((tier) => [tier.tier, tier]));
    for (const meta of TIERS) {
      const tier = byTier.get(meta.key);
      if (tier) grid.appendChild(tierCard(meta, tier));
    }
    section.appendChild(grid);
    if (rakeback.history.length) {
      section.appendChild(historyTable('Recent rakeback claims', rakeback.history));
    }
    root.appendChild(section);
  }
}

function notice(message) {
  const card = el('div', 'rake__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function sectionTitle(text) {
  const title = el('h2', 'rake__subtitle');
  title.textContent = text;
  return title;
}

function summary(referrals, rakeback) {
  const referralClaimable = Number(referrals?.totals?.revshareClaimableMinor ?? 0);
  const referralClaimed = Number(referrals?.totals?.revsharePaidMinor ?? 0);
  const rakebackClaimable = Number(rakeback?.totals?.claimableMinor ?? 0);
  const rakebackClaimed = Number(rakeback?.totals?.lifetimeMinor ?? 0);
  const third = referrals
    ? ['Invite bonus', money(Number(referrals.terms.bonusMinor))]
    : ['House edge', `${(rakeback.houseEdgeBps / 100).toFixed(2)}%`];

  const wrap = el('div', 'rake__summary');
  for (const [label, value, gold] of [
    ['Claimable now', money(referralClaimable + rakebackClaimable), true],
    ['Claimed lifetime', money(referralClaimed + rakebackClaimed), false],
    [third[0], third[1], false],
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

function referralCard(data) {
  const amount = Number(data.totals.revshareClaimableMinor ?? 0);
  const claimed = Number(data.totals.revsharePaidMinor ?? 0);
  const rate = Number(data.terms.revshareWagerBps ?? 0) / 100;
  const card = el('article', 'rake__card rake__card--referral');
  card.dataset.armed = amount > 0 ? '1' : '0';

  const head = el('header', 'rake__head');
  const name = el('span', 'rake__name');
  name.textContent = 'Your referral share';
  const badge = el('span', 'rake__rate mono');
  badge.textContent = `${rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}% of wagers`;
  head.append(name, badge);

  const copy = el('p', 'rake__copy');
  copy.textContent = 'Earn on every wager made by players who joined through your invite link.';
  const figure = el('b', 'rake__figure mono');
  figure.textContent = money(amount);

  const meter = el('div', 'rake__meter');
  const invites = el('span', 'rake__clock mono');
  invites.textContent = `${data.totals.invites} referred player${data.totals.invites === 1 ? '' : 's'}`;
  const lifetime = el('span', 'rake__life mono');
  lifetime.textContent = `${money(claimed)} claimed`;
  meter.append(invites, lifetime);

  const button = el('button', 'btn btn--go rake__claim');
  button.type = 'button';
  button.textContent = claiming === 'referrals' ? 'CLAIMING…' : 'CLAIM REWARDS';
  button.disabled = amount <= 0 || claiming === 'referrals';
  button.addEventListener('click', claimReferrals);

  card.append(head, copy, figure, meter, button);
  return card;
}

function tierCard(meta, tier) {
  const card = el('article', 'rake__card');
  card.dataset.tier = meta.key;
  card.dataset.armed = tier.claimable ? '1' : '0';

  const head = el('header', 'rake__head');
  const name = el('span', 'rake__name');
  name.textContent = meta.name;
  const rate = el('span', 'rake__rate mono');
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
  button.addEventListener('click', () => claimTier(meta.key));

  card.append(head, figure, meter, button);
  return card;
}

async function claimReferrals() {
  if (claiming) return;
  claiming = 'referrals';
  paint();
  try {
    const result = await claimReferralRewards();
    playSound('coin');
    toast({ kind: 'gold', title: 'Referral rewards claimed', body: money(Number(result.claimedMinor)) });
  } catch (error) {
    toast({ kind: 'lose', title: 'Nothing to claim', body: error?.message || '' });
    await refreshReferrals(false).catch(() => undefined);
  } finally {
    claiming = '';
    paint();
  }
}

async function claimTier(tier) {
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
    await refreshRakeback(false).catch(() => undefined);
  } finally {
    claiming = '';
    paint();
  }
}

function historyTable(labelText, history, fixedLabel = '') {
  const card = el('section', 'rake__history');
  const label = el('span', 'rake__label');
  label.textContent = labelText;
  card.appendChild(label);

  const table = el('table', 'dtable');
  const body = el('tbody');
  for (const entry of history) {
    const row = el('tr');
    const labelCell = el('td');
    labelCell.textContent = fixedLabel || entry.tier;
    const amount = el('td', 'dtable__num mono');
    amount.textContent = money(Number(entry.amountMinor));
    const when = el('td', 'dtable__num mono dtable__dim');
    when.textContent = new Date(entry.createdAt).toLocaleDateString();
    row.append(labelCell, amount, when);
    body.appendChild(row);
  }
  table.appendChild(body);
  card.appendChild(table);
  return card;
}
