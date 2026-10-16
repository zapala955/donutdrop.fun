/* notices.js — the bell in the top bar: what happened to the player's money that they did not do
 * themselves (services/api-gateway/src/lib/notifications.ts). A deposit landing from the game, a
 * withdrawal the bot has paid or had to refund, a tip, an invite reaching its bar, a staff
 * adjustment; and above them, money waiting to be collected.
 *
 * The live stream says when to look (a per-player 'notice', live.js); a slow poll stands in only
 * while the stream is down. Opening the panel marks what it shows as read, up to the newest item it
 * showed, so a notice that lands while it is open is not marked read unseen. */
import { api } from './api.js';
import { state, bus } from './store.js';
import { $, money } from './util.js';
import { toast } from './ui.js';

/* While the stream is up a notice says when to look; while it is down, this often instead. */
const FALLBACK_POLL_MS = 30_000;
/* A notice is published a beat after the write, and can still beat the COMMIT; one more look. */
const NOTICE_RETRY_MS = 1_500;
/* The stream counts as up while it has spoken this recently (it beats every 2.5s). */
const LIVE_FRESH_MS = 10_000;
/* Deposits are announced by app.js's deposit poll already; the bell only lists them. */
const TOASTED_ELSEWHERE = new Set(['cash_deposit', 'pay_login_deposit']);
const MAX_TOASTS = 2;

const ICONS = {
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14V4"/><path d="m8 8 4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  gift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M3 7h18v3H3zM12 7v13"/><path d="M12 7H8.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h3.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z"/></svg>',
  staff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  coins: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"/><path d="M10 15.4c.9 1.3 2.8 2.1 5 2.1 2.8 0 5-1.1 5-2.5v-4c0-1.4-2.2-2.5-5-2.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
};

/* What each kind says. A kind the page does not know yet is left out rather than shown blank. */
const KINDS = {
  cash_deposit: { icon: 'in', title: () => 'Deposit credited', detail: () => 'Paid in from the game' },
  pay_login_deposit: { icon: 'in', title: () => 'Sign-in payment credited', detail: () => 'Your sign-in payment, in your balance' },
  withdrawal_paid: {
    icon: 'out',
    title: () => 'Withdrawal paid',
    detail: (n) => (n.to ? `Sent to ${n.to} in game` : 'Sent in game'),
    out: true,
  },
  cash_withdrawal_refund: { icon: 'back', title: () => 'Withdrawal refunded', detail: () => 'It could not be sent, so it is back in your balance' },
  tip_received: { icon: 'gift', title: () => 'Tip received', detail: (n) => (n.from ? `From ${n.from}` : 'From another player') },
  referral_bonus: { icon: 'gift', title: () => 'Invite bonus', detail: () => 'Someone you invited reached the wager bar' },
  race_payout: { icon: 'gift', title: () => 'Race prize', detail: () => 'For your place in a wager race' },
  faction_payout: { icon: 'gift', title: () => 'Faction war prize', detail: () => 'Your share of the war pool' },
  jackpot_win: { icon: 'gift', title: () => 'Vault jackpot', detail: () => 'You hit the vault jackpot' },
  admin_adjustment: {
    icon: 'staff',
    title: (n) => (Number(n.amountMinor) < 0 ? 'Balance debited by staff' : 'Balance credited by staff'),
    detail: () => 'An adjustment by the DonutLuxe team',
  },
  discord_join_reward: { icon: 'gift', title: () => 'Discord reward', detail: () => 'For joining and linking the Discord' },
  discord_tag_reward: { icon: 'gift', title: () => 'Discord reward', detail: () => 'For wearing the server tag today' },
  discord_invite_reward: { icon: 'gift', title: () => 'Discord invite reward', detail: () => 'Someone you invited linked their account' },
  signup_bonus: { icon: 'gift', title: () => 'Welcome bonus', detail: () => 'To start you off' },
};

const READY = {
  rakeback: { title: 'Rakeback ready', detail: 'A share of the house edge on your play' },
  referrals: { title: 'Referral earnings ready', detail: 'Your share of what your invites played' },
};

let els = null;
let feed = null;          // { items, ready } as last read
let status = 'idle';      // idle · loading · ready · error
let open = false;
let inflight = null;
let again = false;
let seen = null;          // ids already known; null until the first read, which announces nothing
let shownUnread = new Set();
let lastUnread = 0;
let baseline = false;     // set once the first read has been drawn
let liveAt = 0;
let retryTimer = 0;

/** "+$12.4M" for money in, "$12.4M" for a withdrawal, "-$2M" for a debit. */
function amountText(n) {
  const value = Number(n.amountMinor) || 0;
  if (KINDS[n.kind]?.out) return money(value);
  return value < 0 ? money(value) : '+' + money(value);
}

function ago(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function icon(name, extra = '') {
  const tile = node('span', 'notif__ico' + extra);
  tile.innerHTML = ICONS[name] ?? ICONS.bell; // constant markup, never data
  return tile;
}

function unreadCount() {
  return feed ? feed.items.filter((n) => n.unread).length : 0;
}

/* ─────────── reading ─────────── */

function apply(result) {
  const items = (Array.isArray(result?.items) ? result.items : []).filter(
    (n) => n && typeof n.id === 'string' && KINDS[n.kind],
  );
  const ready = (Array.isArray(result?.ready) ? result.ready : []).filter((r) => r && READY[r.kind]);
  const fresh = seen ? items.filter((n) => n.unread && !seen.has(n.id)) : [];
  seen = new Set(items.map((n) => n.id));
  feed = { items, ready };
  status = 'ready';
  announce(fresh);
}

function load() {
  if (!state.authenticated) return Promise.resolve();
  if (inflight) {
    again = true;
    return inflight;
  }
  if (!feed) status = 'loading';
  render();
  inflight = (async () => {
    try {
      const result = await api.get('/v1/notifications');
      if (!state.authenticated) return;
      apply(result);
      if (open) markRead();
    } catch (error) {
      // A failed refresh keeps the last good list; only a panel with nothing to show says so.
      if (!feed) status = 'error';
      console.warn('[donutluxe] notifications failed', error?.code || error);
    } finally {
      inflight = null;
      render();
      if (feed) baseline = true;
      if (again) {
        again = false;
        void load();
      }
    }
  })();
  return inflight;
}

/* Marks read up to the newest item the panel is showing. Optimistic: the badge clears now, and a
 * failed write only means the next read shows them unread again. */
function markRead() {
  if (!feed?.items.length || !feed.items.some((n) => n.unread)) return;
  const until = feed.items[0].at;
  for (const n of feed.items) {
    if (n.unread) shownUnread.add(n.id);
    n.unread = false;
  }
  renderBadge();
  api.post('/v1/notifications/read', { until }).catch(() => undefined);
}

function announce(fresh) {
  const toToast = fresh.filter((n) => !TOASTED_ELSEWHERE.has(n.kind)).slice(0, MAX_TOASTS);
  for (const n of toToast) {
    const kind = KINDS[n.kind];
    toast({ kind: 'win', title: kind.title(n), body: `${amountText(n)} · ${kind.detail(n)}` });
  }
}

function reset() {
  feed = null;
  seen = null;
  status = 'idle';
  lastUnread = 0;
  baseline = false;
  shownUnread = new Set();
  if (open) setOpen(false);
  render();
}

/* ─────────── drawing ─────────── */

function renderBadge() {
  const unread = unreadCount();
  const { badge, btn, say } = els;
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  btn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  /* One status line, and only when the count goes up: a screen reader hears "2 new notifications"
   * when they land, not a bare number on every redraw, and nothing for what was there on arrival. */
  if (unread > lastUnread && baseline) say.textContent = unread === 1 ? '1 new notification' : `${unread} new notifications`;
  lastUnread = unread;
  els.meta.textContent = unread ? `${unread} new` : '';
}

function row(n) {
  const kind = KINDS[n.kind];
  const li = node('li', 'notif__item');
  if (shownUnread.has(n.id) || n.unread) li.dataset.unread = '1';
  li.append(icon(kind.icon));
  const text = node('div', 'notif__text');
  text.append(node('b', 'notif__name', kind.title(n)), node('span', 'notif__detail', kind.detail(n)));
  const side = node('div', 'notif__side');
  const amount = node('b', 'notif__amt mono', amountText(n));
  if (Number(n.amountMinor) < 0) amount.dataset.tone = 'loss';
  else if (kind.out) amount.dataset.tone = 'out';
  const time = node('time', 'notif__time', ago(n.at));
  time.dateTime = n.at;
  time.title = new Date(n.at).toLocaleString();
  side.append(amount, time);
  li.append(text, side);
  return li;
}

function readyRow(r) {
  const copy = READY[r.kind];
  const link = node('a', 'notif__ready');
  link.href = r.path === '/referrals' ? '/referrals' : '/rakeback';
  link.append(icon('coins', ' notif__ico--gold'));
  const text = node('div', 'notif__text');
  text.append(node('b', 'notif__name', copy.title), node('span', 'notif__detail', copy.detail));
  const side = node('div', 'notif__side');
  side.append(node('b', 'notif__amt mono', money(Number(r.amountMinor) || 0)), node('span', 'notif__claim', 'Claim'));
  link.append(text, side);
  return link;
}

function skeleton() {
  const list = node('ul', 'notif__list');
  list.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const li = node('li', 'notif__item notif__item--skel');
    li.append(node('span', 'notif__ico'), node('span', 'notif__bar'), node('span', 'notif__bar notif__bar--short'));
    list.append(li);
  }
  return list;
}

function emptyState() {
  const box = node('div', 'notif__empty');
  box.append(icon('bell', ' notif__ico--big'));
  box.append(node('b', 'notif__name', 'Nothing here yet'));
  box.append(node('p', 'notif__detail', 'Deposits, paid withdrawals, tips and rewards show up here as they land.'));
  const go = node('button', 'notif__cta', 'Deposit');
  go.type = 'button';
  go.addEventListener('click', () => {
    setOpen(false);
    $('#depositBtn')?.click();
  });
  box.append(go);
  return box;
}

function errorState() {
  const box = node('div', 'notif__empty notif__empty--error');
  box.append(node('b', 'notif__name', 'Notifications did not load'));
  box.append(node('p', 'notif__detail', 'Your balance and history are unaffected. Try again in a moment.'));
  const retry = node('button', 'notif__cta notif__cta--ghost', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => {
    status = 'loading';
    void load();
  });
  box.append(retry);
  return box;
}

function render() {
  if (!els) return;
  renderBadge();
  if (!open) return;
  const { body } = els;
  body.setAttribute('aria-busy', String(status === 'loading'));
  const parts = [];
  if (!feed && status === 'error') parts.push(errorState());
  else if (!feed) parts.push(skeleton());
  else {
    if (feed.ready.length) {
      const ready = node('div', 'notif__group');
      ready.append(node('p', 'notif__label', 'Ready to collect'));
      for (const r of feed.ready) ready.append(readyRow(r));
      parts.push(ready);
    }
    if (feed.items.length) {
      const list = node('ul', 'notif__list');
      for (const n of feed.items) list.append(row(n));
      parts.push(list);
    } else if (!feed.ready.length) {
      parts.push(emptyState());
    } else {
      parts.push(node('p', 'notif__quiet', 'Nothing else in the last 30 days.'));
    }
  }
  // A redraw must not drop the keyboard: focus inside the list goes back to the panel itself.
  const hadFocus = body.contains(document.activeElement);
  body.replaceChildren(...parts);
  if (hadFocus) els.panel.focus({ preventScroll: true });
}

/* ─────────── opening and closing ─────────── */

function setOpen(next) {
  if (!els || open === next) return;
  open = next;
  els.panel.hidden = !open;
  els.btn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  shownUnread = new Set();
  markRead();
  render();
  els.panel.focus({ preventScroll: true });
  void load();
}

function liveIsUp() {
  return Date.now() - liveAt < LIVE_FRESH_MS;
}

export function initNotices() {
  const root = $('#notif');
  if (!root) return;
  els = {
    root,
    btn: $('#notifBtn'),
    badge: $('#notifBadge'),
    panel: $('#notifPanel'),
    body: $('#notifBody'),
    meta: $('#notifMeta'),
    say: $('#notifSay'),
  };
  if (Object.values(els).some((el) => !el)) {
    els = null;
    return;
  }

  els.btn.addEventListener('click', () => setOpen(!open));
  /* Capture, not bubble: the account button stops its click from bubbling, and opening that menu
   * has to close this panel too. */
  document.addEventListener(
    'click',
    (event) => {
      if (open && !root.contains(event.target)) setOpen(false);
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return;
    setOpen(false);
    els.btn.focus();
  });
  // Tabbing out of the panel closes it, so it never sits open behind the focus.
  root.addEventListener('focusout', (event) => {
    if (open && event.relatedTarget && !root.contains(event.relatedTarget)) setOpen(false);
  });
  // A link inside (Claim, Wallet history) navigates; the panel goes with it.
  els.panel.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) setOpen(false);
  });

  window.addEventListener('donut:live-status', (event) => {
    liveAt = event.detail?.connected ? Date.now() : 0;
  });
  window.addEventListener('donut:notice', () => {
    if (document.hidden || !state.authenticated) return;
    void load();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void load(), NOTICE_RETRY_MS);
  });
  bus.addEventListener('change', (event) => {
    if (!state.authenticated) {
      if (feed || status !== 'idle') reset();
      return;
    }
    if (event.detail === 'login' || event.detail === 'ready') void load();
  });
  setInterval(() => {
    if (!document.hidden && state.authenticated && !liveIsUp()) void load();
  }, FALLBACK_POLL_MS);
  // The relative times ("4m ago") are redrawn while the panel is open.
  setInterval(() => {
    if (open && feed) render();
  }, 30_000);

  if (state.authenticated) void load();
}
