/* quests.js — the Quests tab: the quest board (GET /v1/quests/board, lib/quest-board.ts).
 *
 * Quests the operator writes in the admin console, such as "deposit $10M, get $1M". Every quest
 * resets on the same clock, every three days at 00:00 UTC, and each can be claimed once per period.
 *
 * Everything shown is the server's: the quests, the player's progress (read from their deposits,
 * withdrawals and wagers, never counted here), what is claimed and when the period ends. The page
 * asks again every thirty seconds while it is open, when the player signs in or out, and the moment
 * the period turns over. Readable signed out, because a reward nobody can see before signing up is
 * not one that brings anybody in. Quest names and descriptions are set as text, never as markup.
 *
 * (The daily quests and the weekly deposit race and recruit quest that used to sit here are off; the
 * daily login streak has its own page, Daily Rewards.)
 */
import { api } from './api.js';
import { bus, refreshBalance, state } from './store.js';
import { $, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const REFRESH_MS = 30_000;

const KIND = {
  deposit: {
    verb: 'Deposited',
    // A coin going in.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="14" r="6.5"/><path d="M12 11.5v5M10 3v4.5M14 3v4.5M8.5 5.5 12 9l3.5-3.5"/></svg>',
  },
  wager: {
    verb: 'Wagered',
    // A die.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle class="qb__dot" cx="9" cy="9" r="1.3"/><circle class="qb__dot" cx="15" cy="15" r="1.3"/><circle class="qb__dot" cx="12" cy="12" r="1.3"/></svg>',
  },
};

let root = null;
let board = null;
let loading = null;
let timer = 0;
let tick = 0;
const claiming = new Set();

const cash = (minor) => money(Number(minor ?? 0));

/** "2d 4h", "5h 12m", "12m": what is left until an instant. */
export function timeLeft(iso, now = Date.now()) {
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      board = await api.get('/v1/quests/board');
    } catch {
      board = board ?? null;
    } finally {
      loading = null;
    }
    paint();
  })();
  return loading;
}

async function claim(quest) {
  if (claiming.has(quest.id)) return;
  claiming.add(quest.id);
  paint();
  try {
    const result = await api.post(`/v1/quests/board/${encodeURIComponent(quest.id)}/claim`, {});
    playSound('reward');
    toast({ kind: 'win', title: `${cash(result.rewardMinor)} claimed`, body: quest.name });
    void refreshBalance(false);
  } catch (error) {
    toast({ kind: 'lose', title: 'Not claimed', body: error?.message || 'That quest could not be claimed' });
  } finally {
    claiming.delete(quest.id);
    await load();
  }
}

/* ─────────── painting ─────────── */

function paintClock() {
  const left = root && $('#qbLeft', root);
  if (!left || !board) return;
  left.textContent = timeLeft(board.periodEnd);
}

function questCard(quest) {
  const kind = KIND[quest.kind] ?? KIND.deposit;
  const signedIn = quest.progressMinor !== null && state.authenticated;
  const target = BigInt(quest.targetMinor);
  const done = signedIn ? BigInt(quest.progressMinor) : 0n;
  const ratio = target > 0n ? Math.min(1, Number(done) / Number(target)) : 0;
  const status = !signedIn ? 'out' : quest.claimed ? 'claimed' : quest.claimable ? 'ready' : 'going';

  const card = node('li', 'qb__quest');
  card.dataset.state = status;
  card.dataset.kind = quest.kind;

  const icon = node('span', 'qb__icon');
  icon.innerHTML = kind.icon;

  const body = node('div', 'qb__body');
  body.append(node('h3', 'qb__name', quest.name));
  if (quest.description) body.append(node('p', 'qb__desc', quest.description));
  const bar = node('div', 'qb__bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `${quest.name}: progress`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  const fill = node('span', 'qb__fill');
  fill.style.setProperty('--p', ratio.toFixed(4));
  bar.append(fill);
  const count = node('p', 'qb__count');
  if (signedIn) {
    count.append(node('span', '', `${kind.verb} `), node('b', '', cash(done)), node('span', '', ` of ${cash(target)}`));
  } else {
    count.append(node('span', '', `${kind.verb === 'Deposited' ? 'Deposit' : 'Wager'} ${cash(target)} within the period`));
  }
  body.append(bar, count);

  const side = node('div', 'qb__side');
  const reward = node('p', 'qb__reward');
  reward.append(node('span', 'qb__rewardlabel', 'Reward'), node('b', 'qb__rewardamt', cash(quest.rewardMinor)));
  side.append(reward);
  if (status === 'claimed') {
    side.append(node('span', 'qb__done', 'Claimed'));
  } else {
    const button = node('button', 'qb__claim');
    button.type = 'button';
    if (status === 'out') {
      button.textContent = 'Log in';
      button.addEventListener('click', () => $('#loginBtn')?.click());
    } else {
      const busy = claiming.has(quest.id);
      button.textContent = busy ? 'Claiming…' : 'Claim';
      button.disabled = status !== 'ready' || busy;
      button.setAttribute('aria-busy', String(busy));
      button.addEventListener('click', () => void claim(quest));
    }
    side.append(button);
  }

  card.append(icon, body, side);
  return card;
}

function paint() {
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="qb__head">
        <p class="qb__period">Resets every 3 days · <span>next reset in <b id="qbLeft">—</b></span></p>
      </div>
      <ul class="qb__list" id="qbList" aria-label="Quests"></ul>
      <div class="qb__empty" id="qbEmpty" hidden>
        <p class="qb__emptytitle">No quests right now</p>
        <p class="qb__emptyline">New quests are on the way. Check back soon.</p>
      </div>
      <p class="qb__note" id="qbNote"></p>`;
  }
  const list = $('#qbList', root);
  const empty = $('#qbEmpty', root);
  const note = $('#qbNote', root);
  if (!board) {
    list.replaceChildren();
    empty.hidden = loading !== null;
    $('.qb__emptytitle', root).textContent = loading ? '' : 'Quests are not answering';
    $('.qb__emptyline', root).textContent = loading ? '' : 'Try again in a moment.';
    note.textContent = '';
    return;
  }
  list.replaceChildren(...board.quests.map(questCard));
  empty.hidden = board.quests.length > 0;
  $('.qb__emptytitle', root).textContent = 'No quests right now';
  $('.qb__emptyline', root).textContent = 'New quests are on the way. Check back soon.';
  // The wager requirement is the signup bonus's (lib/wager-requirements.ts); at 0 there is none to mention.
  const wagered = board.wagerMultiplier > 0
    ? ` A reward is free money: it is wagered ${board.wagerMultiplier}× before it can be withdrawn.`
    : '';
  note.textContent = board.quests.length
    ? `Deposits count net of withdrawals, and only within the period.${wagered}`
    : '';
  note.hidden = !board.quests.length;
  paintClock();
}

/* ─────────── mounting ─────────── */

function schedule() {
  window.clearInterval(timer);
  window.clearInterval(tick);
  timer = window.setInterval(() => {
    if (!root?.isConnected || root.closest('.view')?.hidden) return;
    if (document.visibilityState === 'visible') void load();
  }, REFRESH_MS);
  // The clock, and a fresh board the moment the period turns over.
  tick = window.setInterval(() => {
    if (!root?.isConnected || root.closest('.view')?.hidden || !board) return;
    if (Date.now() >= new Date(board.periodEnd).getTime()) void load();
    else paintClock();
  }, 15_000);
}

export function mountQuests(view) {
  root = $('#questRoot', view);
  if (!root) return;
  if (!root.dataset.listening) {
    root.dataset.listening = '1';
    bus.addEventListener('change', (event) => {
      if (['login', 'logout', 'ready'].includes(event.detail) && root?.isConnected) void load();
    });
  }
  paint();
  void load();
  schedule();
}
