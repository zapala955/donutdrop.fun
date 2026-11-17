/* rakeback.js — the Rewards tab: rakeback, the referral share and the Discord server tag reward.
 *
 * Hallmark · component: rewards page (summary panel, three reward cards, claim history)
 * genre: atmospheric · theme: site tokens, flat obsidian (the VIP page's panel, hairline and type)
 * states: card default · ready · waiting · locked; claim button default · hover · focus · active ·
 * disabled · loading. Icons: Phosphor bold, the set the nav uses (MIT).
 *
 * The owner, 2026-11-17: "recode the rewards tab like u did with basically everything to make it more
 * premium and fit the new design and make it so the discord tag rewards automatically go there and
 * users dont need to do /tag". The server tag reward is claimed here now: the gateway checks the tag
 * with Discord at the claim (POST /v1/discord/tag/claim) on the rules /tag had -- the first whenever
 * the tag is on, each after it once it has been worn 24 hours straight.
 */
import {
  state,
  bus,
  refreshReferrals,
  claimReferralRewards,
  refreshRakeback,
  claimRakeback,
} from './store.js';
import { api } from './api.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { mountStaking } from './staking.js';

const ICONS = {
  'coins': '<path d="M188,86.11V84c0-14.62-10.83-27.55-30.51-36.4C140.87,40.12,119,36,96,36S51.13,40.12,34.51,47.6C14.83,56.45,4,69.38,4,84v40c0,14.62,10.83,27.55,30.51,36.4A131.67,131.67,0,0,0,68,169.88V172c0,14.62,10.83,27.55,30.51,36.4C115.13,215.88,137,220,160,220s44.87-4.12,61.49-11.6C241.17,199.55,252,186.62,252,172V132C252,109.86,226.71,92.08,188,86.11ZM228,132c0,7.75-21.77,22.48-61.81,23.88C180.33,147.4,188,136.3,188,124V110.44C213.88,115.15,228,125.48,228,132ZM107.37,147.63c-3.63.24-7.42.37-11.37.37-5.08,0-9.89-.22-14.43-.61a10.94,10.94,0,0,0-1.14-.09c-1.51-.14-3-.3-4.43-.48V130.93A187,187,0,0,0,96,132a187,187,0,0,0,20-1.07v15.89c-2.49.3-5.07.56-7.75.75C108,147.58,107.66,147.6,107.37,147.63ZM164,117.14V124c0,4.78-8.28,12.21-24,17.54v-15a115.32,115.32,0,0,0,17.49-6.13Q160.93,118.86,164,117.14ZM96,60c44,0,68,15.85,68,24s-24,24-68,24S28,92.15,28,84,52,60,96,60ZM28,124v-6.86q3.08,1.71,6.51,3.26A115.32,115.32,0,0,0,52,126.53v15C36.28,136.21,28,128.78,28,124Zm64,48v0c1.33,0,2.66,0,4,0q5.44,0,10.77-.32,4.45,1.57,9.23,2.86v15C100.28,184.21,92,176.78,92,172Zm48,22.82V178.94A186.45,186.45,0,0,0,160,180a187,187,0,0,0,20-1.07v15.89a170.08,170.08,0,0,1-40,0Zm64-5.28v-15a115.32,115.32,0,0,0,17.49-6.13q3.44-1.54,6.51-3.26V172C228,176.78,219.72,184.21,204,189.54Z"/>',
  'users-three': '<path d="M164.38,181.1a52,52,0,1,0-72.76,0,75.89,75.89,0,0,0-30,28.89,12,12,0,0,0,20.78,12,53,53,0,0,1,91.22,0,12,12,0,1,0,20.78-12A75.89,75.89,0,0,0,164.38,181.1ZM100,144a28,28,0,1,1,28,28A28,28,0,0,1,100,144Zm147.21,9.59a12,12,0,0,1-16.81-2.39c-8.33-11.09-19.85-19.59-29.33-21.64a12,12,0,0,1-1.82-22.91,20,20,0,1,0-24.78-28.3,12,12,0,1,1-21-11.6,44,44,0,1,1,73.28,48.35,92.18,92.18,0,0,1,22.85,21.69A12,12,0,0,1,247.21,153.59Zm-192.28-24c-9.48,2.05-21,10.55-29.33,21.65A12,12,0,0,1,6.41,136.79,92.37,92.37,0,0,1,29.26,115.1a44,44,0,1,1,73.28-48.35,12,12,0,1,1-21,11.6,20,20,0,1,0-24.78,28.3,12,12,0,0,1-1.82,22.91Z"/>',
  'tag': '<path d="M246.15,133.18,146.83,33.86A19.85,19.85,0,0,0,132.69,28H40A12,12,0,0,0,28,40v92.69a19.85,19.85,0,0,0,5.86,14.14l99.32,99.32a20,20,0,0,0,28.28,0l84.69-84.69A20,20,0,0,0,246.15,133.18Zm-98.83,93.17L52,131V52h79l95.32,95.32ZM104,88A16,16,0,1,1,88,72,16,16,0,0,1,104,88Z"/>',
  'clock-counter-clockwise': '<path d="M140,80v41.21l34.17,20.5a12,12,0,1,1-12.34,20.58l-40-24A12,12,0,0,1,116,128V80a12,12,0,0,1,24,0ZM128,28A99.38,99.38,0,0,0,57.24,57.34c-4.69,4.74-9,9.37-13.24,14V64a12,12,0,0,0-24,0v40a12,12,0,0,0,12,12H72a12,12,0,0,0,0-24H57.77C63,86,68.37,80.22,74.26,74.26a76,76,0,1,1,1.58,109,12,12,0,0,0-16.48,17.46A100,100,0,1,0,128,28Z"/>',
};

function icon(name) {
  const box = el('span', 'rw__icon');
  box.innerHTML = `<svg viewBox="0 0 256 256" aria-hidden="true" fill="currentColor">${ICONS[name]}</svg>`;
  return box;
}

let root = null;
let ticker = 0;
let claiming = '';
let discord = null; // GET /v1/discord/rewards for the signed-in player, or null until it answers

export function mountRewards(view) {
  mountStaking($('#stakingRoot', view));
  root = $('#rewardsRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (event.detail === 'logout') discord = null;
      /* The store reloads rakeback and the referral share itself when the session arrives; the
       * Discord status is this page's own, so it is asked for here as well as at mount. */
      if (['login', 'ready'].includes(event.detail) && state.authenticated) loadDiscord().then(paint);
      if (['login', 'logout', 'ready', 'private', 'referrals', 'rakeback'].includes(event.detail)) paint();
    });
  }
  if (state.authenticated) {
    // Settled, not all: a programme that is switched off must not keep the others from being drawn.
    Promise.allSettled([refreshReferrals(false), refreshRakeback(false), loadDiscord()]).then(paint);
  }
  paint();
  startTicker();
}

async function loadDiscord() {
  try {
    discord = await api.get('/v1/discord/rewards');
  } catch {
    discord = null;
  }
}

function startTicker() {
  if (ticker) window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (!root?.isConnected) {
      window.clearInterval(ticker);
      ticker = 0;
      return;
    }
    let expired = false;
    for (const node of root.querySelectorAll('[data-ready-at]')) {
      const remaining = new Date(node.dataset.readyAt).getTime() - Date.now();
      if (remaining <= 0) expired = true;
      else node.textContent = node.dataset.prefix + clock(remaining);
    }
    if (expired) Promise.allSettled([refreshRakeback(false), loadDiscord()]).then(paint);
  }, 1000);
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/* ── what each reward stands at ─────────────────────────────────────────────────────────────── */

function rakebackState(rakeback) {
  const tier = rakeback?.tiers?.find((entry) => entry.tier === 'instant') ?? rakeback?.tiers?.[0] ?? null;
  if (!tier) return null;
  return {
    claimable: Number(tier.claimableMinor ?? 0),
    claimed: Number(tier.claimedMinor ?? 0),
    rateBps: Number(tier.rateBps ?? 0),
    ready: Boolean(tier.claimable),
    availableAt: tier.availableAt ?? null,
    tier: tier.tier,
  };
}

function referralState(referrals) {
  if (!referrals) return null;
  return {
    claimable: Number(referrals.totals?.revshareClaimableMinor ?? 0),
    claimed: Number(referrals.totals?.revsharePaidMinor ?? 0),
    invites: Number(referrals.totals?.invites ?? 0),
  };
}

function tagState(status) {
  if (!status || !status.enabled) return null;
  const amount = Number(status.amounts?.tagMinor ?? 0);
  if (amount <= 0) return null;
  const tag = status.tag ?? {};
  const nextAt = tag.nextAt ? new Date(tag.nextAt) : null;
  let phase = 'unlinked';
  if (status.linked) {
    if (tag.ready) phase = 'ready';
    else if (nextAt && nextAt.getTime() > Date.now()) phase = 'waiting';
    else phase = 'tag-off';
  }
  return {
    amount,
    phase,
    nextAt,
    first: Number(tag.days ?? 0) === 0,
    days: Number(tag.days ?? 0),
    total: Number(tag.totalMinor ?? 0),
  };
}

/* ── painting ─────────────────────────────────────────────────────────────────────────────────── */

function paint() {
  if (!root?.isConnected) return;
  root.replaceChildren();
  root.className = 'rw';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to see and claim your rewards.'));
    return;
  }
  const rake = rakebackState(state.rakeback);
  const refer = referralState(state.referrals);
  const tag = tagState(discord);
  if (!rake && !refer && !tag) {
    root.appendChild(notice('Rewards are not switched on yet.'));
    return;
  }

  root.appendChild(summary(rake, refer, tag));
  const cards = el('div', 'rw__cards');
  if (rake) cards.appendChild(rakebackCard(rake));
  if (refer) cards.appendChild(referralCard(refer));
  if (tag) cards.appendChild(tagCard(tag));
  root.appendChild(cards);

  const history = historyPanel(state.rakeback?.history ?? [], state.referrals?.claims ?? []);
  if (history) root.appendChild(history);
}

function notice(message) {
  const card = el('div', 'rw__notice');
  card.textContent = message;
  return card;
}

function summary(rake, refer, tag) {
  const ready = (rake?.ready ? rake.claimable : 0) + (refer?.claimable ?? 0) + (tag?.phase === 'ready' ? tag.amount : 0);
  const claimed = (rake?.claimed ?? 0) + (refer?.claimed ?? 0) + (tag?.total ?? 0);
  const panel = el('section', 'rw__hero');
  const lead = el('div', 'rw__herolead');
  const k = el('span', 'rw__k');
  k.textContent = 'Ready to claim';
  const big = el('b', `rw__big${ready > 0 ? ' rw__big--live' : ''}`);
  big.textContent = money(ready);
  lead.append(k, big);
  const stats = el('div', 'rw__herostats');
  for (const [label, value] of [
    ['Claimed all time', money(claimed)],
    ['Rakeback rate', rake ? `${(rake.rateBps / 100).toFixed(rake.rateBps % 100 ? 2 : 0)}%` : '—'],
    ['Tag rewards', tag ? String(tag.days) : '—'],
  ]) {
    const cell = el('div', 'rw__stat');
    const key = el('span', 'rw__k');
    key.textContent = label;
    const figure = el('b', 'rw__v');
    figure.textContent = value;
    cell.append(key, figure);
    stats.appendChild(cell);
  }
  panel.append(lead, stats);
  return panel;
}

function card(kind, iconName, title, sub, ready) {
  const node = el('article', 'rw__card');
  node.dataset.kind = kind;
  node.dataset.state = ready ? 'ready' : 'idle';
  const head = el('header', 'rw__head');
  const titles = el('div', 'rw__titles');
  const name = el('h2', 'rw__title');
  name.textContent = title;
  const line = el('p', 'rw__sub');
  line.textContent = sub;
  titles.append(name, line);
  head.append(icon(iconName), titles);
  node.appendChild(head);
  return node;
}

function amountLine(value, live) {
  const figure = el('b', `rw__amount${live ? ' rw__amount--live' : ''}`);
  figure.textContent = money(value);
  return figure;
}

function meta(rows) {
  const list = el('dl', 'rw__meta');
  for (const [label, value, readyAt, prefix] of rows) {
    const item = el('div', 'rw__metarow');
    const dt = el('dt');
    dt.textContent = label;
    const dd = el('dd');
    dd.textContent = value;
    if (readyAt) {
      dd.dataset.readyAt = readyAt;
      dd.dataset.prefix = prefix ?? '';
    }
    item.append(dt, dd);
    list.appendChild(item);
  }
  return list;
}

function claimButton(key, label, enabled, onClick) {
  const button = el('button', 'btn btn--go rw__claim');
  button.type = 'button';
  button.textContent = claiming === key ? 'Claiming…' : label;
  button.disabled = !enabled || Boolean(claiming);
  if (claiming === key) button.dataset.state = 'loading';
  button.addEventListener('click', onClick);
  return button;
}

function rakebackCard(rake) {
  const node = card('rakeback', 'coins', 'Rakeback', 'Part of the house edge back on every bet, any time.', rake.ready);
  const rows = [['Rate', `${(rake.rateBps / 100).toFixed(rake.rateBps % 100 ? 2 : 0)}% of the edge`], ['Claimed', money(rake.claimed)]];
  if (rake.availableAt && !rake.ready) {
    rows.unshift(['Next claim', clock(new Date(rake.availableAt).getTime() - Date.now()), rake.availableAt, '']);
  }
  node.append(
    amountLine(rake.claimable, rake.ready),
    meta(rows),
    claimButton('rakeback', rake.ready ? `Claim ${money(rake.claimable)}` : 'Nothing to claim yet', rake.ready, () => claimRake(rake.tier)),
  );
  return node;
}

function referralCard(refer) {
  const node = card('referral', 'users-three', 'Referral share', 'A share of every bet your invited players make.', refer.claimable > 0);
  node.append(
    amountLine(refer.claimable, refer.claimable > 0),
    meta([
      ['Invited players', refer.invites.toLocaleString('en-US')],
      ['Claimed', money(refer.claimed)],
    ]),
    claimButton('referral', refer.claimable > 0 ? `Claim ${money(refer.claimable)}` : 'Nothing to claim yet', refer.claimable > 0, claimReferral),
  );
  return node;
}

function tagCard(tag) {
  const subs = {
    unlinked: 'Link your Discord, wear the DonutLuxe server tag, and claim it here.',
    ready: tag.first
      ? 'Wear the DonutLuxe server tag on your Discord profile, then claim.'
      : 'Your tag has been on for 24 hours. Claim it.',
    waiting: 'Keep the server tag on: the next one opens after 24 hours of wearing it.',
    'tag-off': 'Put the server tag back on: each reward after the first needs it worn 24 hours straight.',
  };
  const node = card('tag', 'tag', 'Discord server tag', subs[tag.phase], tag.phase === 'ready');
  const rows = [];
  if (tag.phase === 'waiting' && tag.nextAt) {
    rows.push(['Next reward in', clock(tag.nextAt.getTime() - Date.now()), tag.nextAt.toISOString(), '']);
  }
  rows.push(['Collected', `${tag.days} · ${money(tag.total)}`]);
  node.append(amountLine(tag.amount, tag.phase === 'ready'), meta(rows));

  if (tag.phase === 'unlinked') {
    const link = el('a', 'btn btn--ghost rw__claim');
    link.href = '/discord';
    link.dataset.route = 'discord';
    link.textContent = 'Link Discord';
    node.appendChild(link);
  } else if (tag.phase === 'waiting') {
    node.appendChild(claimButton('tag', 'Keep the tag on', false, () => undefined));
  } else {
    // Ready, or the tag is not seen on: a claim checks it with Discord either way, and says why not.
    node.appendChild(claimButton('tag', tag.phase === 'ready' ? `Claim ${money(tag.amount)}` : 'Check my tag', true, claimTag));
  }
  return node;
}

function historyPanel(rakebackHistory, referralClaims) {
  const rows = [
    ...rakebackHistory.map((entry) => ({ kind: 'Rakeback', amount: Number(entry.amountMinor), at: entry.createdAt })),
    ...referralClaims.map((entry) => ({ kind: 'Referral share', amount: Number(entry.amountMinor), at: entry.createdAt })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 12);
  if (!rows.length) return null;
  const panel = el('section', 'rw__history');
  const title = el('h2', 'rw__h');
  title.append(icon('clock-counter-clockwise'), document.createTextNode('Recent claims'));
  const list = el('div', 'rw__rows');
  for (const row of rows) {
    const line = el('div', 'rw__row');
    const kind = el('span', 'rw__pill');
    kind.dataset.kind = row.kind === 'Rakeback' ? 'rakeback' : 'referral';
    kind.textContent = row.kind;
    const amount = el('b', 'rw__rowamt');
    amount.textContent = money(row.amount);
    const when = el('span', 'rw__rowat');
    when.textContent = new Date(row.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    line.append(kind, amount, when);
    list.appendChild(line);
  }
  panel.append(title, list);
  return panel;
}

/* ── claims ───────────────────────────────────────────────────────────────────────────────────── */

async function claimRake(tier) {
  if (claiming) return;
  claiming = 'rakeback';
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

async function claimReferral() {
  if (claiming) return;
  claiming = 'referral';
  paint();
  try {
    const result = await claimReferralRewards();
    playSound('coin');
    // An invite on the player's own network is voided at the claim and left out of it.
    const voided = Number(result.voidedInvites) || 0;
    toast({
      kind: 'gold',
      title: 'Referral share claimed',
      body: money(Number(result.claimedMinor)) + (voided
        ? ` · ${voided === 1 ? 'an invite' : `${voided} invites`} on your own network voided and left out`
        : ''),
    });
  } catch (error) {
    toast({ kind: 'lose', title: 'Nothing to claim', body: error?.message || '' });
    await refreshReferrals(false).catch(() => undefined);
  } finally {
    claiming = '';
    paint();
  }
}

async function claimTag() {
  if (claiming) return;
  claiming = 'tag';
  paint();
  try {
    const result = await api.post('/v1/discord/tag/claim', {});
    if (result.paid) {
      playSound('coin');
      toast({ kind: 'gold', title: 'Tag reward claimed', body: `${money(Number(result.amountMinor))} · keep the tag on for the next one` });
    } else {
      const next = result.nextAt ? ` Next one in ${clock(new Date(result.nextAt).getTime() - Date.now())}.` : '';
      toast({ kind: 'lose', title: 'No tag reward yet', body: `${result.reason}.${next}` });
    }
  } catch (error) {
    toast({ kind: 'lose', title: 'Could not claim', body: error?.message || '' });
  } finally {
    claiming = '';
    await loadDiscord();
    paint();
  }
}
