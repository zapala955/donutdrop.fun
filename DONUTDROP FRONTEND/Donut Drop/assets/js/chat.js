/* chat.js — the left-docked global chat.
 *
 * Four kinds of line share this log and nothing else does:
 *
 *   1. messages players typed, stored server-side and readable by everyone — an approved
 *      creator's carry a MEDIA nametag with their code;
 *   2. BIG hits only — a real payout over the configured threshold;
 *   3. tips, when one player hands another player money;
 *   4. lava rain: a line when a drop opens and when it pays out.
 *
 * Above the log sits the lava rain card itself, a live pot with a countdown and a claim.
 *
 * Every small drop still scrolls past in the ticker at the bottom of the page. Putting them here
 * too would bury the conversation under its own feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOTHING IN THIS LOG IS INVENTED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every line is a server fact: a stored message, a settled round, a recorded tip, a real pot. There
 * are no simulated players, no scripted banter and no fake wins — and since the header's invented
 * online counter was removed, nothing anywhere on this platform is simulated any more. A chat that
 * pads itself with invented conversation is a chat where the real messages stop meaning anything,
 * and on a site where the next line might be a $50M win that matters more than usual.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * INNERHTML IS NEVER USED HERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every value on a chat line is either a player's own typing or a server-supplied name, so each one
 * is written with textContent and cannot carry markup regardless of what the sanitiser upstream did
 * or did not catch.
 */
import { state, bus, sendChat, refreshChat, refreshBalance } from './store.js';
import { censorName, censorText } from './profanity.js';
import { $, el, money, parseAmount, safeImage } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';
import { api, API_BASE_URL } from './api.js';

// Recovery-only fallback. New messages arrive over /v1/live while the connection is healthy.
const POLL_MS = 30_000;
/* Rain is pushed too: a drop opening, a claim and a settlement each arrive as a `rain` live event.
 * The poll is the fallback for a dropped stream, and the gap is the most often a busy drop is
 * refetched, since every claim on the site is broadcast to every open card. */
const RAIN_POLL_MS = 15_000;
const RAIN_OFF_POLL_MS = 60_000;
const RAIN_EVENT_GAP_MS = 1500;
/* A paid drop older than this is history, not news, and gets no line in the log on page load. */
const RAIN_ANNOUNCE_HORIZON_MS = 30 * 60_000;
const RAIN_PAID_KEY = 'dd.rain.paid';
const MAX_LINES = 60;
/* Within this of the bottom counts as reading the tail. */
const TAIL_SLACK_PX = 60;
/* The games that pay money rather than an item, and the name each one's big-win card carries. */
const TABLE_GAMES = new Map([
  ['roulette', 'Roulette'],
  ['blackjack', 'Blackjack'],
  ['crash', 'Crash'],
  ['mines', 'Mines'],
  ['plinko', 'Plinko'],
]);
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

/** Remembered across sessions so the rail opens the way the player left it. */
const DOCK_KEY = 'dd.chat.collapsed';

let log = null;
let form = null;
let input = null;
let jump = null;
let timer = 0;
let rainCard = null;
let rainTimer = 0;
let rainCountdown = 0;
let rainInFlight = false;
let rainFetchedAt = 0;
let lastRainBoard = null;
/* Slow mode, shown on the send button rather than discovered by being refused. */
let cooldownUntil = 0;
let cooldownTimer = 0;
/* `open:<id>` and `paid:<id>`: the rain lines already in the log. */
const announcedRain = new Set();
const toastedPayouts = new Set();
/* Ids already drawn. Polling returns overlapping windows, so without this every refresh would
 * redraw the same messages and the log would grow without bound. */
const seenMessages = new Set();
const seenHits = new Set();
/* One win card per player per minute. A player on a run -- a crash streak, a battle's worth of
 * big drops, Plinko balls several a second -- filled the chat with their own cards and pushed the
 * conversation off the screen. Measured on each round's own time, not on when this page happened
 * to hear about it, so every viewer holds back the same cards. A win inside a player's minute is
 * still in the live feed; it just gets no chat card. */
const HIT_COOLDOWN_MS = 60_000;
const lastHitAt = new Map(); // player id -> the round time of their last card
let appliedResetId;

export function initChat() {
  log = $('#chatLog');
  form = $('#chatForm');
  input = $('#chatInput');
  if (!log) return;

  initDock();
  initJump();
  initRain();

  if (form) {
    form.addEventListener('submit', onSubmit);
    input.maxLength = 240;
  }

  paintAuthState();
  bus.addEventListener('change', (event) => {
    if (event.detail === 'chat') {
      drainMessages();
      drainBigHits();
      announceRain(lastRainBoard);
    }
    if (event.detail === 'activity' || event.detail === 'ready') drainBigHits();
    if (['login', 'logout', 'ready', 'private'].includes(event.detail)) paintAuthState();
  });

  refreshChat().catch(() => undefined);
  drainBigHits();
  window.clearInterval(timer);
  timer = window.setInterval(() => refreshChat().catch(() => undefined), POLL_MS);
}

/* ═════════════════════════ the dock ═════════════════════════ */

/**
 * The rail collapses on desktop and slides out on mobile, from one piece of state.
 *
 * `data-collapsed` on <body> rather than on the rail itself, because the grid column that makes
 * room for it belongs to the shell — collapsing the panel without collapsing its column leaves a
 * 292px hole where the chat used to be.
 */
function initDock() {
  const rail = $('#chat');
  if (!rail) return;

  let collapsed = false;
  try {
    collapsed = window.localStorage.getItem(DOCK_KEY) === '1';
  } catch {
    /* Private windows throw on read. Defaulting to open is the right failure. */
  }

  const toggle = el('button', 'chat__dock');
  toggle.type = 'button';
  const paint = () => {
    document.body.dataset.chatCollapsed = collapsed ? '1' : '0';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Open chat' : 'Close chat');
    toggle.textContent = collapsed ? '›' : '‹';
  };
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try {
      window.localStorage.setItem(DOCK_KEY, collapsed ? '1' : '0');
    } catch {
      /* A remembered preference is a convenience, never a correctness requirement. */
    }
    paint();
    playSound('click');
  });
  rail.appendChild(toggle);
  paint();
}

/**
 * The "new messages" pill.
 *
 * The log already refuses to yank a reader away from a line they are reading (see appendLine). The
 * cost was that someone scrolled up had no way to know the conversation had moved on under them.
 */
function initJump() {
  const rail = $('#chat');
  if (!rail || !log) return;
  jump = el('button', 'chat__jump');
  jump.type = 'button';
  jump.hidden = true;
  jump.textContent = 'New messages ↓';
  jump.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
  });
  log.addEventListener(
    'scroll',
    () => {
      if (!jump.hidden && atTail()) jump.hidden = true;
    },
    { passive: true },
  );
  rail.appendChild(jump);
}

function atTail() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < TAIL_SLACK_PX;
}

/* ═════════════════════════ lava rain ═════════════════════════ */

/**
 * The drop card, which is a live server object rather than a decoration.
 *
 * The rail used to carry a "RAIN POT" that counted down to nothing and had no endpoint behind it.
 * This replaces it with the real one: a pool somebody funded, a window that actually closes, an
 * eligibility bar checked on the server, and a claim that registers an entitlement paid when the
 * window shuts and the divisor is finally known.
 */
function initRain() {
  rainCard = document.querySelector('.chat__rain');
  if (!rainCard) return;
  rainCard.hidden = true;
  /* Opened, claimed into, settled, or switched on in the admin panel: live.js turns each of those
   * into this event, so a five-minute window is not spent waiting for a poll to notice it. */
  window.addEventListener('donut:rain', scheduleRain);
  /* The button depends on who is looking. Logging in used to leave a disabled LOG IN on the card
   * until the next poll came round. */
  bus.addEventListener('change', (event) => {
    if (event.detail === 'login' || event.detail === 'logout') scheduleRain();
  });
  void pollRain();
}

/** Every claim on the site is broadcast, so a busy drop is refetched at most once per gap. */
function scheduleRain() {
  if (!rainCard) return;
  window.clearTimeout(rainTimer);
  const wait = Math.max(0, rainFetchedAt + RAIN_EVENT_GAP_MS - Date.now());
  rainTimer = window.setTimeout(() => void pollRain(), wait);
}

async function pollRain() {
  if (!rainCard) return;
  window.clearTimeout(rainTimer);
  if (rainInFlight) {
    rainTimer = window.setTimeout(() => void pollRain(), RAIN_EVENT_GAP_MS);
    return;
  }
  rainInFlight = true;
  rainFetchedAt = Date.now();
  let board;
  try {
    board = await api.get('/v1/social/rain');
  } catch (error) {
    /* Switched off is a state, not an ending. The card used to be removed from the page here, so
     * an operator turning Lava Rain on mid-session reached nobody who already had the site open. */
    const off = error?.code === 'RAIN_DISABLED';
    if (off) hideRain();
    rainTimer = window.setTimeout(() => void pollRain(), off ? RAIN_OFF_POLL_MS : RAIN_POLL_MS * 2);
    return;
  } finally {
    rainInFlight = false;
  }

  lastRainBoard = board;
  paintRain(board);
  announceRain(board);
  noticePayout(board);
  rainTimer = window.setTimeout(() => void pollRain(), RAIN_POLL_MS);
}

function hideRain() {
  window.clearInterval(rainCountdown);
  if (rainCard) rainCard.hidden = true;
  delete document.body.dataset.rain;
}

function paintRain(board) {
  const card = rainCard;
  window.clearInterval(rainCountdown);
  if (!board.active) {
    hideRain();
    return;
  }
  card.hidden = false;
  document.body.dataset.rain = '1';
  card.replaceChildren();

  const active = board.active;
  const you = board.you;

  const art = document.createElement('img');
  art.src = safeImage('assets/img/items/gold_block.png');
  art.alt = '';
  card.appendChild(art);

  const figures = el('div', 'chat__rainfig');
  const pot = el('b', 'mono');
  pot.textContent = money(Number(active.poolMinor));
  const caption = el('span');
  caption.textContent = you?.claimed
    ? `YOU'RE IN · ${active.claimants} IN`
    : `LAVA RAIN · ${active.claimants} IN`;
  figures.append(pot, caption);
  /* What a share is worth right now. Labelled as an estimate everywhere it appears, because every
   * claim until the window shuts moves the divisor. */
  figures.title = `About ${money(
    Number(active.poolMinor) / Math.max(1, active.claimants + (you?.claimed ? 0 : 1)),
  )} each if you claim now · split evenly when the window closes`;
  card.appendChild(figures);

  const clockNode = el('span', 'chat__timer mono');
  card.appendChild(clockNode);

  const button = el('button', 'btn btn--tiny');
  button.type = 'button';
  const closesAt = new Date(active.closesAt).getTime();

  const paintClock = () => {
    const remaining = Math.max(0, closesAt - Date.now());
    clockNode.textContent = `${String(Math.floor(remaining / 60000)).padStart(2, '0')}:${String(
      Math.floor((remaining % 60000) / 1000),
    ).padStart(2, '0')}`;
    card.dataset.closing = remaining <= 30_000 ? '1' : '0';
    if (remaining <= 0) {
      window.clearInterval(rainCountdown);
      /* Throttled, not immediate. The server decides when the window has shut by its own clock;
       * a browser running a few seconds fast used to refetch, still see the drop open, repaint at
       * 00:00 and refetch again, as fast as the network allowed, until the server caught up. */
      scheduleRain();
    }
  };
  paintClock();
  rainCountdown = window.setInterval(paintClock, 1000);

  if (!state.authenticated) {
    /* A disabled LOG IN was a dead end on the one card with a deadline on it. */
    button.textContent = 'LOG IN';
    button.addEventListener('click', () => document.querySelector('#loginBtn')?.click());
  } else if (you?.claimed) {
    button.textContent = 'CLAIMED';
    button.disabled = true;
  } else if (!you?.eligible) {
    /* The bar is stated as a figure, not as a sentence. A player who is short needs to know by how
     * much, and "wager $10M in 60 minutes" is a rule they can act on where a paragraph is not. The
     * figure is the shortfall, not the bar: someone $1M away should not read "NEED $10M". */
    const short = Number(BigInt(active.minWageredMinor) - BigInt(you?.wageredMinor ?? '0'));
    button.textContent = `NEED ${money(Math.max(0, short))}`;
    button.disabled = true;
    button.title = `Wager ${money(Number(active.minWageredMinor))} in ${active.windowMinutes}m to claim · ${money(
      Number(you?.wageredMinor ?? 0),
    )} so far`;
  } else {
    button.textContent = 'CLAIM';
    button.addEventListener('click', () => void claimRain(button));
  }
  card.appendChild(button);
}

async function claimRain(button) {
  button.disabled = true;
  try {
    const result = await api.post('/v1/social/rain/claim', {});
    playSound('chime');
    toast({
      kind: 'gold',
      title: 'IN THE RAIN',
      /* Labelled an estimate on purpose: the divisor is still moving while the window is open. */
      body: `${result.claimants} in · about ${money(Number(result.estimatedShareMinor))} each`,
    });
    void pollRain();
  } catch (error) {
    button.disabled = false;
    toast({ kind: 'lose', title: 'NOT CLAIMED', body: error?.message || 'Try again' });
    /* Already claimed, window shut, or no longer eligible: all of them mean the card is stale. */
    scheduleRain();
  }
}

/**
 * The viewer's share, once it has actually landed.
 *
 * Settlement pays everybody at once when the window shuts, usually while the claimant is looking
 * at something else, and nothing used to say so: the balance just went up. Shown once per drop,
 * remembered for the tab so a reload inside the server's ten-minute window does not replay it.
 */
function noticePayout(board) {
  const payout = board.yourPayout;
  if (!payout?.eventId) return;
  let shown = '';
  try {
    shown = window.sessionStorage.getItem(RAIN_PAID_KEY) || '';
  } catch {
    /* No storage: the in-memory set below still holds for this page. */
  }
  if (shown === payout.eventId || toastedPayouts.has(payout.eventId)) return;
  toastedPayouts.add(payout.eventId);
  try {
    window.sessionStorage.setItem(RAIN_PAID_KEY, payout.eventId);
  } catch {
    /* A repeat toast after a reload is the worst case. */
  }
  playSound('coin');
  toast({
    kind: 'gold',
    title: 'LAVA RAIN PAID',
    body: `${money(Number(payout.paidMinor))} landed · split ${payout.claimants} ${
      payout.claimants === 1 ? 'way' : 'ways'
    }`,
  });
  void refreshBalance();
}

/**
 * A drop opening and a drop paying out, as lines in the conversation.
 *
 * The card at the top of the rail is easy to scroll past and invisible inside a closed drawer; a
 * line in the log is where people are already looking. Both are server facts with server times, so
 * they sort into the timeline like everything else and honour a chat reset like everything else.
 */
function announceRain(board) {
  /* Not before the timeline has loaded: the reset boundary is not known yet, and the first load
   * of a cleared chat would otherwise wipe these lines straight back out. The chat load calls
   * back in here with the last board. */
  if (!log || !board || !state.chat?.loaded) return;
  applyChatReset();
  const clearedAt = resetTimestamp();
  let added = false;

  const active = board.active;
  if (active?.id && !announcedRain.has(`open:${active.id}`)) {
    const at = new Date(active.opensAt ?? Date.now()).getTime();
    announcedRain.add(`open:${active.id}`);
    if (at > clearedAt) {
      const bar = BigInt(active.minWageredMinor ?? '0');
      const text =
        `${money(Number(active.poolMinor))} is falling. Claim a share above` +
        (bar > 0n ? ` · needs ${money(Number(bar))} wagered in ${active.windowMinutes}m.` : '.');
      appendLine(buildRainLine('LIVE', text, at), at);
      added = true;
    }
  }

  const horizon = Date.now() - RAIN_ANNOUNCE_HORIZON_MS;
  for (const drop of board.recent ?? []) {
    if (!drop?.id || !drop.settledAt || announcedRain.has(`paid:${drop.id}`)) continue;
    announcedRain.add(`paid:${drop.id}`);
    const at = new Date(drop.settledAt).getTime();
    if (at <= clearedAt || at < horizon) continue;
    const ways = Number(drop.claimants) || 0;
    const text = `${money(Number(drop.poolMinor))} split ${ways} ${ways === 1 ? 'way' : 'ways'} · ${money(
      Number(drop.perClaimMinor ?? 0),
    )} each.`;
    appendLine(buildRainLine('PAID', text, at), at);
    added = true;
  }
  if (added) trim();
}

/* ═════════════════════════ sending ═════════════════════════ */

function paintAuthState() {
  paintMine();
  if (!form || !input) return;
  const online = state.authenticated;
  input.disabled = !online;
  paintSendButton();
  input.placeholder = online ? 'Say something, or /tip name amount' : 'Log in to chat';
}

/** Marks the viewer's own lines, again on every login and logout since the viewer changed. */
function paintMine() {
  if (!log) return;
  const me = state.authenticated ? state.user?.id : null;
  for (const node of log.querySelectorAll('[data-author]')) {
    node.classList.toggle('msg--me', Boolean(me) && node.dataset.author === me);
  }
}

/* ─────────── slow mode ───────────
 * The server has always enforced it; the client only found out by being refused, which arrived as
 * a red "Slow down" toast on a message the player had already finished typing. The button now
 * counts the wait down instead, and Enter does nothing until it is over. */
function startCooldown(seconds) {
  if (!form || !(seconds > 0)) return;
  cooldownUntil = Date.now() + seconds * 1000;
  window.clearInterval(cooldownTimer);
  cooldownTimer = window.setInterval(paintSendButton, 250);
  paintSendButton();
}

function paintSendButton() {
  const button = form?.querySelector('button');
  if (!button) return;
  button.disabled = !state.authenticated;
  const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
  /* aria-disabled rather than disabled: a form whose submit button is disabled refuses Enter
   * entirely, and `/tip` goes through this form without being subject to slow mode. */
  if (left > 0 && state.authenticated) {
    button.textContent = `${left}s`;
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  window.clearInterval(cooldownTimer);
  button.textContent = 'Send';
  button.removeAttribute('aria-disabled');
}

async function onSubmit(event) {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in to chat', body: 'Messages are tied to your account.' });
    return;
  }

  /* `/tip name amount` is handled here rather than being sent to the chat endpoint. A slash command
   * that reaches the message table is a message that says "/tip" in public and moves no money. */
  const tip = /^\/tip\s+([A-Za-z0-9_]{1,16})\s+(\S+)\s*(.{0,80})$/.exec(body);
  if (tip) {
    input.value = '';
    await sendTip(tip[1], parseAmount(tip[2]), tip[3]?.trim() || undefined);
    return;
  }
  // Slow mode is a chat rule; a tip is not a message and is not held back by it.
  if (Date.now() < cooldownUntil) return;

  const button = form.querySelector('button');
  input.disabled = true;
  if (button) button.disabled = true;
  try {
    await sendChat(body);
    input.value = '';
    playSound('click');
    startCooldown(Number(state.chat?.slowModeSeconds) || 0);
  } catch (error) {
    if (error?.code === 'CHAT_SLOW_MODE') {
      /* Another tab, or a clock that drifted: take the server's figure and keep the text. */
      const wait = Number(/(\d+)s/.exec(error?.message || '')?.[1]) || 0;
      startCooldown(wait);
      return;
    }
    toast({
      kind: 'lose',
      title:
        error?.code === 'CHAT_SLOW_MODE'
          ? 'Slow down'
          : error?.code === 'CHAT_TIMED_OUT'
            ? 'Timed out'
            : error?.code === 'CHAT_LINK_BLOCKED'
              ? 'No links'
              : 'Not sent',
      body: error?.message || 'The server rejected the message.',
    });
  } finally {
    input.disabled = !state.authenticated;
    paintSendButton();
    input.focus();
  }
}

/* ═════════════════════════ tipping ═════════════════════════ */

async function sendTip(username, amountMinor, note, userId) {
  if (!amountMinor || amountMinor <= 0) {
    toast({ kind: 'lose', title: 'BAD AMOUNT', body: 'Try /tip name 5m' });
    return;
  }
  try {
    const result = await api.post('/v1/social/tip', {
      toUsername: username,
      /* Sent when we have it — the avatar path does, the typed command does not. The server
       * prefers it, so clicking a head tips that person rather than whoever holds their name by
       * the time the request lands. */
      ...(userId ? { toUserId: userId } : {}),
      amountMinor: String(amountMinor),
      ...(note ? { note } : {}),
    });
    playSound('coin');
    toast({
      kind: 'gold',
      title: 'TIP SENT',
      body: `${money(Number(result.amountMinor))} to ${result.toUsername}`,
    });
    appendLine(buildTip(result.toUsername, Number(result.amountMinor), note), Date.now());
    await refreshBalance();
  } catch (error) {
    toast({ kind: 'lose', title: 'NOT SENT', body: error?.message || 'Try again' });
  }
}

/** The modal behind an avatar click. Same endpoint, fewer keystrokes. */
function openTipSheet(userId, username) {
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Tips come out of your balance.' });
    return;
  }
  let amount = 1_000_000;

  openModal('Tip cash', (host) => {
    const wrap = el('div', 'tipsheet');

    const target = el('div', 'tipsheet__who');
    target.append(
      avatarFor(userId, username, 40),
      Object.assign(el('b'), { textContent: censorName(username) }),
    );

    const figure = el('b', 'tipsheet__amt mono');
    const field = el('input', 'tipsheet__input mono');
    field.type = 'text';
    field.inputMode = 'numeric';
    field.setAttribute('aria-label', 'Tip amount');

    const paint = ({ retype = true } = {}) => {
      figure.textContent = money(amount);
      if (retype) field.value = String(amount);
    };

    const chips = el('div', 'qchips');
    for (const preset of [1_000_000, 5_000_000, 25_000_000]) {
      const chip = el('button', 'qchip');
      chip.type = 'button';
      chip.textContent = `+${money(preset)}`;
      chip.addEventListener('click', () => {
        amount += preset;
        paint();
      });
      chips.append(chip);
    }

    field.addEventListener('input', () => {
      const parsed = parseAmount(field.value);
      if (parsed !== null) {
        amount = parsed;
        paint({ retype: false });
      }
    });

    const go = el('button', 'btn btn--go tipsheet__go');
    go.textContent = '💸 TIP CASH';
    go.addEventListener('click', () => {
      go.disabled = true;
      void sendTip(username, amount, undefined, userId).then(closeModal);
    });

    wrap.append(target, figure, field, chips, go);
    host.append(wrap);
    paint();
  });
}

/* ═════════════════════════ rendering ═════════════════════════ */

function drainMessages() {
  applyChatReset();
  const clearedAt = resetTimestamp();
  const messages = state.chat?.messages ?? [];
  pruneRemoved(messages);
  for (const message of messages) {
    if (new Date(message.createdAt).getTime() <= clearedAt) continue;
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    appendLine(buildMessage(message), message.createdAt);
  }
  trim();
}

/**
 * Takes down lines a moderator deleted.
 *
 * The delete endpoint soft-deletes and publishes `chat`, and the next snapshot simply leaves the
 * message out -- but this log only ever added, so the moderator's own screen was the only one the
 * line disappeared from. Everybody else kept reading it until they reloaded.
 *
 * A line is only judged against a snapshot that could have contained it: it must have been on
 * screen before that request was sent (so a message posted while a refresh was in flight is not
 * mistaken for a deleted one), and it must fall inside the window the server returned (a full page
 * of 50 says nothing about anything older than its oldest row). Its id stays in `seenMessages`, so
 * a deleted message can never be drawn again by a later snapshot that happens to be stale.
 */
function pruneRemoved(messages) {
  const requestedAt = Number(state.chat?.requestedAt || 0);
  if (!requestedAt || !log) return;
  const present = new Set(messages.map((message) => message.id));
  const full = messages.length >= Number(state.chat?.limit || Infinity);
  const floor = full && messages[0] ? new Date(messages[0].createdAt).getTime() : -Infinity;
  for (const node of log.querySelectorAll('[data-mid]')) {
    if (present.has(node.dataset.mid)) continue;
    if (Number(node.dataset.seen || 0) >= requestedAt) continue;
    if (Number(node.dataset.at || 0) <= floor) continue;
    node.remove();
  }
}

function drainBigHits() {
  if (!state.chat?.loaded) return;
  applyChatReset();
  const clearedAt = resetTimestamp();
  const threshold = Number(state.chat?.bigHitMinor ?? 0);
  if (threshold <= 0) return;
  const fresh = [];
  for (const activity of state.activities ?? []) {
    if (new Date(activity.createdAt).getTime() <= clearedAt) continue;
    const item = activity.item;
    if (!item && !TABLE_GAMES.has(activity.kind)) continue;
    // The payout is what actually landed in a wallet; the item's catalogue price is not the same
    // thing on a losing round, where nothing was paid at all.
    const value = Number(activity.payout ?? 0);
    if (value < threshold) continue;
    /* And it has to be a win: more back than went in. A $1B Plinko ball landing on 0.9x pays
     * $900M, over any threshold, and is a loss; so is a $500M crate that drops a $300M item. */
    if (BigInt(activity.payoutMinor ?? '0') <= BigInt(activity.wagerMinor ?? '0')) continue;
    if (seenHits.has(activity.id)) continue;
    // Decided once: a win held back by the cooldown is not reconsidered on the next refresh.
    seenHits.add(activity.id);
    fresh.push({ activity, value, at: new Date(activity.createdAt).getTime() });
  }
  /* Oldest first, so the cooldown is measured forwards in time from the card that was shown. */
  fresh.sort((a, b) => a.at - b.at);
  for (const { activity, value, at } of fresh) {
    const who = activity.playerId ?? activity.player ?? '';
    const last = lastHitAt.get(who);
    if (last !== undefined && Math.abs(at - last) < HIT_COOLDOWN_MS) continue;
    lastHitAt.set(who, at);
    appendLine(buildHit(activity, value), activity.createdAt);
  }
  trim();
}

function resetTimestamp() {
  const value = new Date(state.chat?.clearedAt ?? 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function applyChatReset() {
  const resetId = state.chat?.resetId ?? null;
  if (appliedResetId === undefined) {
    appliedResetId = resetId;
    return;
  }
  if (resetId === appliedResetId) return;
  appliedResetId = resetId;
  seenMessages.clear();
  seenHits.clear();
  lastHitAt.clear();
  announcedRain.clear();
  log.replaceChildren();
  if (jump) jump.hidden = true;
}

/**
 * A player's head, from this origin, by internal id.
 *
 * It used to be an <img> pointed straight at `mc-heads.net/avatar/<username>/<size>`. That put the
 * player's real Minecraft name in a URL, on a page that masks that name in every visible place:
 * right-clicking the head and opening it in a new tab read it out of the address bar, and devtools
 * showed it without even that. The mask beside it was decoration. It also meant every rendered
 * line was the viewer's own browser telling mc-heads.net which players were in this chat, on every
 * poll.
 *
 * The id is a uuid that means nothing outside our database — it does not resolve to a name at
 * Mojang and it is not a credential — and it was already in the chat payload. The server resolves
 * it privately and fetches upstream by account UUID. See routes/avatars.ts.
 *
 * This is not anonymity: `message.author` is still the real name in the payload, because tipping
 * and the moderation endpoints resolve against it. It closes the URL, which is the part that was
 * handing the name to people who were not looking for it.
 *
 * `onerror` falls back to initials, so a miss — a Bedrock player with no Mojang head, upstream
 * down, the proxy refusing — degrades to the treatment the duel screen already uses rather than to
 * a broken-image icon on every line.
 */
function avatarFor(userId, name, size = 22) {
  const wrap = el('span', 'msg__av');
  wrap.style.setProperty('--av', `${size}px`);

  /* One letter, matching the masked name beside it. Two would render the first asterisk. */
  const initials = () => {
    const mark = el('i');
    mark.textContent = (censorName(name) || '?').slice(0, 1).toUpperCase();
    wrap.appendChild(mark);
    return wrap;
  };

  /* No id, no head.
   *
   * The drop cards and tip lines have only a name, and the name they have is already masked by the
   * server — the activity feed is public and deliberately does not say who lost what. There is
   * nothing to look a head up by that would not mean un-masking it first, so those lines get the
   * letter tile. */
  if (!userId) return initials();

  const art = document.createElement('img');
  art.width = size;
  art.height = size;
  art.loading = 'lazy';
  art.alt = '';
  /* This origin, by internal id. It used to be `mc-heads.net/avatar/<username>/<size>`, which put
   * the player's real name in a URL one right-click away on a page that masks it everywhere else,
   * and told mc-heads who was in the chat on every poll. The id means nothing outside our own
   * database; the server resolves it privately. See routes/avatars.ts. */
  art.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(userId)}?s=${size}`;
  art.addEventListener('error', () => {
    art.remove();
    initials();
  });
  wrap.appendChild(art);
  return wrap;
}

function buildMessage(message) {
  const line = el('div', 'msg');
  // Carried so a moderator deleting a message can find the line it is on without a second lookup.
  line.dataset.mid = message.id;
  // When this page first drew it, by this page's clock. See pruneRemoved.
  line.dataset.seen = String(Date.now());
  if (message.authorId) line.dataset.author = message.authorId;
  if (state.authenticated && message.authorId && message.authorId === state.user?.id) {
    line.classList.add('msg--me');
  }
  if (message.isStaff) line.dataset.staff = '1';
  if (message.vip?.isHighRoller) line.dataset.whale = '1';

  const top = el('div', 'msg__top');

  const avatar = avatarFor(message.authorId, message.author);
  avatar.addEventListener('click', () => openTipSheet(message.authorId, message.author));
  avatar.title = `Tip ${censorName(message.author)}`;

  const who = el('span', 'msg__who');
  /* Masked for display only. `message.author` stays the real Mojang username everywhere it is
   * sent back to the server — tipping and the admin timeout endpoints both resolve it against
   * normalized_username, and a masked name resolves to nobody. */
  who.textContent = censorName(message.author);

  top.append(avatar, who);

  if (message.media?.code) {
    line.dataset.media = '1';
    if (message.media.platform) line.dataset.platform = message.media.platform;
    top.append(mediaTag(message.media));
  }

  if (message.isStaff) {
    const badge = el('i', 'msg__badge msg__badge--staff');
    badge.textContent = 'ADMIN';
    top.append(badge);
  } else if (message.vip) {
    /* The tier label, not the level number. "Gold III" is a rank a player recognises; "17" is an
     * index into a table they have never seen. */
    const badge = el('i', 'msg__badge');
    badge.dataset.tier = message.vip.tier;
    badge.textContent = message.vip.label.toUpperCase();
    top.append(badge);
  }

  const when = el('span', 'msg__t');
  when.textContent = clock(message.createdAt);
  top.append(when);

  const body = el('div', 'msg__body');
  const text = el('span');
  /* textContent, never innerHTML: this is another player's typing.
   *
   * Slurs are masked for display only. The stored row keeps what was actually said, because a
   * moderator deciding whether to ban somebody needs the real text, not asterisks. */
  text.textContent = censorText(message.body);
  body.appendChild(text);

  line.append(top, body);

  /* Moderation lives behind the context menu rather than on a visible button, so the rail looks the
   * same to staff as it does to everybody else until they ask for it. */
  line.addEventListener('contextmenu', (event) => {
    if (!state.user || state.user.role !== 'admin') return;
    event.preventDefault();
    openModTools(message, event.clientX, event.clientY);
  });

  return line;
}

const PLATFORM_NAMES = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  tiktok: 'TikTok',
  kick: 'Kick',
  x: 'X',
};

/**
 * The media nametag: MEDIA and the creator's code, on every line an approved creator posts.
 *
 * The server only sends it for a creator whose application was approved, with the code that
 * currently works (see routes/chat.ts), so there is nothing here to verify. It is a button because
 * the one thing a viewer wants from somebody else's code is a copy of it.
 */
function mediaTag(media) {
  const code = String(media.code);
  const platform = PLATFORM_NAMES[media.platform] ?? '';
  const tag = el('button', 'msg__badge msg__badge--media');
  tag.type = 'button';
  if (media.platform) tag.dataset.platform = media.platform;
  tag.append(document.createTextNode('MEDIA'));
  const label = el('b');
  label.textContent = code;
  tag.append(label);
  const describe = `Creator code ${code}${platform ? ` · ${platform}` : ''}`;
  tag.title = `${describe} · tap to copy`;
  tag.setAttribute('aria-label', `${describe}. Copy code`);
  tag.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      toast({
        kind: 'gold',
        title: 'CODE COPIED',
        body: state.authenticated ? `Creator code ${code}` : `${code} · use it when you sign up`,
      });
    } catch {
      /* No clipboard permission (an insecure origin, an old browser): show it to type instead. */
      toast({ kind: 'gold', title: 'CREATOR CODE', body: code });
    }
  });
  return tag;
}

/** A Lava Rain fact in the log. Its own small art, no player, nothing to tip. */
function buildRainLine(label, text, at) {
  const line = el('div', 'msg msg--rain');
  const top = el('div', 'msg__top');
  const mark = el('span', 'msg__av');
  const art = document.createElement('img');
  art.src = safeImage('assets/img/items/gold_block.png');
  art.alt = '';
  mark.appendChild(art);
  const who = el('span', 'msg__who');
  who.textContent = 'Lava Rain';
  const badge = el('i', 'msg__badge msg__badge--rain');
  badge.textContent = label;
  const when = el('span', 'msg__t');
  when.textContent = clock(at);
  top.append(mark, who, badge, when);
  const body = el('div', 'msg__body');
  const span = el('span');
  span.textContent = text;
  body.appendChild(span);
  line.append(top, body);
  return line;
}

/**
 * A win, as a card rather than a sentence.
 *
 * The old line read `D******** hit Block of Netherite for $78M` — a payout buried mid-sentence, in
 * body text, at the same weight as somebody saying hello. The figure is the entire reason the line
 * exists, so it is now the largest thing on it, and the item it came out of is shown rather than
 * named. Everything else is a chip.
 *
 * The visible name stays masked. The head resolves through the same-origin avatar proxy using the
 * activity's opaque internal player id, so the browser never builds a third-party URL from a
 * username. Bedrock accounts and upstream misses still fall back to the initial tile.
 */
function buildHit(activity, value) {
  const isRoulette = activity.kind === 'roulette';
  const isTable = TABLE_GAMES.has(activity.kind);
  const line = el('div', isTable ? 'msg msg--hit msg--roulette' : 'msg msg--hit');

  const top = el('div', 'msg__top');
  top.append(avatarFor(activity.playerId, activity.player || 'Steve'));
  const who = el('span', 'msg__who');
  who.textContent = censorName(activity.player) || 'Someone';
  top.append(who);
  if (isTable) {
    const game = el('i', 'msg__badge msg__badge--roulette');
    game.textContent = TABLE_GAMES.get(activity.kind).toUpperCase();
    top.append(game);
  }
  if (activity.vip) {
    const tier = el('i', 'msg__badge');
    tier.dataset.tier = activity.vip.tier;
    tier.textContent = String(activity.vip.label).toUpperCase();
    top.append(tier);
  }
  const when = el('span', 'msg__t');
  when.textContent = clock(activity.createdAt);
  top.append(when);

  /* The payout and the thing it came out of, side by side. */
  const figure = el('div', 'flexwin');
  if (isRoulette) {
    const result = Number(activity.rouletteResult);
    const wheel = el('span', 'flexwin__roulette mono');
    wheel.dataset.color = rouletteColor(result);
    wheel.textContent = Number.isInteger(result) ? String(result) : '?';
    wheel.setAttribute('aria-label', `Roulette landed on ${wheel.textContent}`);
    figure.appendChild(wheel);
  } else if (activity.item?.img) {
    const art = document.createElement('img');
    art.className = 'flexwin__art';
    art.src = safeImage(activity.item.img);
    art.alt = '';
    figure.appendChild(art);
  }
  const stack = el('div', 'flexwin__stack');
  const tag = el('b', 'flexwin__tag mono');
  tag.textContent = money(value);
  const from = el('span', 'flexwin__from');
  if (isRoulette) {
    const result = Number(activity.rouletteResult);
    const count = Math.max(1, Number(activity.betCount) || 1);
    const landed = Number.isInteger(result) ? ` · ${result} ${rouletteColor(result)}` : '';
    from.textContent = `Roulette · ${count} ${count === 1 ? 'chip' : 'chips'}${landed}`;
  } else if (isTable) {
    // Blackjack and crash: the multiple is what came back over what was risked.
    const multiple = activity.wager > 0 ? activity.payout / activity.wager : 0;
    from.textContent = `${TABLE_GAMES.get(activity.kind)} · ${multiple.toFixed(2)}×`;
  } else {
    from.textContent = activity.item?.displayName || activity.item?.name || 'a round';
  }
  stack.append(tag, from);
  figure.append(stack);

  /* A REPLAY button stood here. It never replayed anything — there is no stored recording — it
   * just routed to the mode the win happened in, which is a link wearing a verb it could not
   * honour. The crate and the upgrader are both one tap away in the nav already. */

  line.append(top, figure);
  return line;
}

function rouletteColor(result) {
  if (result === 0) return 'green';
  return ROULETTE_RED.has(result) ? 'red' : 'black';
}

function buildTip(username, amount, note) {
  const line = el('div', 'msg msg--tip');
  const top = el('div', 'msg__top');
  top.append(avatarFor(null, username));
  const who = el('span', 'msg__who');
  who.textContent = censorName(username);
  const badge = el('i', 'msg__badge msg__badge--tip');
  badge.textContent = 'TIP';
  top.append(who, badge);
  const body = el('div', 'msg__body');
  const text = el('span');
  text.textContent = note ? `${money(amount)} — ${note}` : `received ${money(amount)}`;
  body.appendChild(text);
  line.append(top, body);
  return line;
}

/* ═════════════════════════ moderation ═════════════════════════ */

function openModTools(message, x, y) {
  document.querySelector('.modmenu')?.remove();
  const menu = el('div', 'modmenu');
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`;

  const heading = el('div', 'modmenu__who');
  heading.textContent = message.author;
  menu.append(heading);

  const act = (label, run) => {
    const button = el('button', 'modmenu__row');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      menu.remove();
      void run();
    });
    menu.append(button);
  };

  act('Delete message', async () => {
    try {
      await api.delete(`/v1/chat/${message.id}`);
      document.querySelectorAll('.msg').forEach((node) => {
        if (node.dataset.mid === message.id) node.remove();
      });
      toast({ kind: 'gold', title: 'DELETED', body: 'Message removed' });
    } catch (error) {
      toast({ kind: 'lose', title: 'NOT DELETED', body: error?.message || 'Try again' });
    }
  });

  for (const minutes of [5, 60, 1440]) {
    act(`Timeout ${minutes >= 1440 ? '24h' : minutes >= 60 ? '1h' : '5m'}`, async () => {
      try {
        await api.post('/v1/chat/timeouts', { username: message.author, minutes });
        toast({ kind: 'gold', title: 'TIMED OUT', body: `${message.author} muted` });
      } catch (error) {
        toast({ kind: 'lose', title: 'NOT MUTED', body: error?.message || 'Try again' });
      }
    });
  }

  act('Lift timeout', async () => {
    try {
      const result = await api.delete(`/v1/chat/timeouts/${message.author}`);
      toast({ kind: 'gold', title: 'LIFTED', body: `${result.lifted} removed` });
    } catch (error) {
      toast({ kind: 'lose', title: 'NOT LIFTED', body: error?.message || 'Try again' });
    }
  });

  document.body.appendChild(menu);
  const close = (event) => {
    if (menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener('click', close);
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/* ═════════════════════════ the log ═════════════════════════ */

function appendLine(node, when) {
  log.querySelector('[data-chat-empty]')?.remove();
  // Sort key kept on the node so a hit arriving between two polls still lands in time order.
  node.dataset.at = String(when ? new Date(when).getTime() : Date.now());
  const nodeAt = Number(node.dataset.at);

  /* Measure before changing the log. Measuring after append makes a newly-added line increase
   * scrollHeight first, so a reader who was exactly at the bottom suddenly appears not to be and
   * the rail stops following. An empty log always follows while its initial history is filled. */
  const followTail = !log.children.length || atTail();

  /* Messages and big hits come from separate requests and either one can finish first. Comparing
   * only with the final row is not enough: after one older hit is inserted, that final row remains
   * the same and every later hit piles up immediately in front of it. Scan the whole merged feed
   * so the first row newer than this one becomes its insertion point. Equal timestamps retain
   * their arrival order. */
  let inserted = false;
  for (const child of log.children) {
    if (Number(child.dataset.at || 0) <= nodeAt) continue;
    log.insertBefore(node, child);
    inserted = true;
    break;
  }
  if (!inserted) log.appendChild(node);

  // Only follow the tail when the reader is already at it; yanking someone away from a line they
  // are reading is the most annoying thing a chat can do.
  if (followTail) log.scrollTop = log.scrollHeight;
  // Only for something that landed below the reader. An older card slotting in above them is not news.
  else if (jump && log.lastElementChild === node) jump.hidden = false;
}

function trim() {
  while (log.children.length > MAX_LINES) log.firstElementChild.remove();
  if (!log.children.length) {
    const empty = el('div', 'msg msg--sys');
    empty.dataset.chatEmpty = '1';
    const body = el('div', 'msg__body');
    const text = el('span');
    text.textContent = 'Quiet so far. Big hits and messages show up here.';
    body.appendChild(text);
    empty.appendChild(body);
    log.appendChild(empty);
  }
}

function clock(value) {
  const at = value ? new Date(value) : new Date();
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
