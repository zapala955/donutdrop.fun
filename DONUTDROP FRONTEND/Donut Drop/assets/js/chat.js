/* chat.js — the left-docked global chat.
 *
 * Four kinds of line share this log and nothing else does:
 *
 *   1. messages players typed, stored server-side and readable by everyone;
 *   2. BIG hits only — a real payout over the configured threshold, with a replay link;
 *   3. tips, when one player hands another player money;
 *   4. the lava rain card, which is a live pot with a countdown and a claim.
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

const POLL_MS = 6000;
const RAIN_POLL_MS = 8000;
const MAX_LINES = 60;
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

/** Remembered across sessions so the rail opens the way the player left it. */
const DOCK_KEY = 'dd.chat.collapsed';

let log = null;
let form = null;
let input = null;
let timer = 0;
let rainTimer = 0;
let rainCountdown = 0;
/* Ids already drawn. Polling returns overlapping windows, so without this every refresh would
 * redraw the same messages and the log would grow without bound. */
const seenMessages = new Set();
const seenHits = new Set();

export function initChat() {
  log = $('#chatLog');
  form = $('#chatForm');
  input = $('#chatInput');
  if (!log) return;

  initDock();
  initRain();

  if (form) {
    form.addEventListener('submit', onSubmit);
    input.maxLength = 240;
  }

  paintAuthState();
  bus.addEventListener('change', (event) => {
    if (event.detail === 'chat') drainMessages();
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
  const card = document.querySelector('.chat__rain');
  if (!card) return;
  card.hidden = true;
  void pollRain(card);
}

async function pollRain(card) {
  window.clearTimeout(rainTimer);
  let board;
  try {
    board = await api.get('/v1/social/rain');
  } catch (error) {
    if (error?.code === 'RAIN_DISABLED') {
      card.remove();
      return;
    }
    rainTimer = window.setTimeout(() => void pollRain(card), RAIN_POLL_MS * 2);
    return;
  }

  paintRain(card, board);
  rainTimer = window.setTimeout(() => void pollRain(card), RAIN_POLL_MS);
}

function paintRain(card, board) {
  window.clearInterval(rainCountdown);
  if (!board.active) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.replaceChildren();

  const art = document.createElement('img');
  art.src = safeImage('assets/img/items/gold_block.png');
  art.alt = '';
  card.appendChild(art);

  const figures = el('div', 'chat__rainfig');
  const pot = el('b', 'mono');
  pot.textContent = money(Number(board.active.poolMinor));
  const caption = el('span');
  caption.textContent = `LAVA RAIN · ${board.active.claimants} IN`;
  figures.append(pot, caption);
  card.appendChild(figures);

  const clockNode = el('span', 'chat__timer mono');
  card.appendChild(clockNode);

  const button = el('button', 'btn btn--tiny');
  const closesAt = new Date(board.active.closesAt).getTime();

  const paintButton = () => {
    const remaining = Math.max(0, closesAt - Date.now());
    clockNode.textContent = `${String(Math.floor(remaining / 60000)).padStart(2, '0')}:${String(
      Math.floor((remaining % 60000) / 1000),
    ).padStart(2, '0')}`;
    if (remaining <= 0) {
      window.clearInterval(rainCountdown);
      void pollRain(card);
    }
  };
  paintButton();
  rainCountdown = window.setInterval(paintButton, 1000);

  if (!state.authenticated) {
    button.textContent = 'LOG IN';
    button.disabled = true;
  } else if (board.you?.claimed) {
    button.textContent = 'CLAIMED';
    button.disabled = true;
  } else if (!board.you?.eligible) {
    /* The bar is stated as a figure, not as a sentence. A player who is short needs to know by how
     * much, and "wager $10M in 60 minutes" is a rule they can act on where a paragraph is not. */
    button.textContent = `NEED ${money(Number(board.active.minWageredMinor))}`;
    button.disabled = true;
    button.title = `Wagered in the last ${board.active.windowMinutes}m: ${money(
      Number(board.you?.wageredMinor ?? 0),
    )}`;
  } else {
    button.textContent = 'CLAIM SHARE';
    button.addEventListener('click', () => void claimRain(card, button));
  }
  card.appendChild(button);
}

async function claimRain(card, button) {
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
    void pollRain(card);
  } catch (error) {
    button.disabled = false;
    toast({ kind: 'lose', title: 'NOT CLAIMED', body: error?.message || 'Try again' });
  }
}

/* ═════════════════════════ sending ═════════════════════════ */

function paintAuthState() {
  if (!form || !input) return;
  const button = form.querySelector('button');
  const online = state.authenticated;
  input.disabled = !online;
  if (button) button.disabled = !online;
  input.placeholder = online ? 'Say something, or /tip name amount' : 'Log in to chat';
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

  const button = form.querySelector('button');
  input.disabled = true;
  if (button) button.disabled = true;
  try {
    await sendChat(body);
    input.value = '';
    playSound('click');
  } catch (error) {
    toast({
      kind: 'lose',
      title:
        error?.code === 'CHAT_SLOW_MODE'
          ? 'Slow down'
          : error?.code === 'CHAT_TIMED_OUT'
            ? 'Timed out'
            : 'Not sent',
      body: error?.message || 'The server rejected the message.',
    });
  } finally {
    input.disabled = !state.authenticated;
    if (button) button.disabled = !state.authenticated;
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
  const messages = state.chat?.messages ?? [];
  for (const message of messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    appendLine(buildMessage(message), message.createdAt);
  }
  trim();
}

function drainBigHits() {
  const threshold = Number(state.chat?.bigHitMinor ?? 0);
  if (threshold <= 0) return;
  for (const activity of state.activities ?? []) {
    const item = activity.item;
    if (!item && activity.kind !== 'roulette') continue;
    // The payout is what actually landed in a wallet; the item's catalogue price is not the same
    // thing on a losing round, where nothing was paid at all.
    const value = Number(activity.payout ?? 0);
    if (value < threshold) continue;
    if (seenHits.has(activity.id)) continue;
    seenHits.add(activity.id);
    appendLine(buildHit(activity, value), activity.createdAt);
  }
  trim();
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
  if (message.isStaff) line.dataset.staff = '1';
  if (message.vip?.isHighRoller) line.dataset.whale = '1';

  const top = el('div', 'msg__top');

  const avatar = avatarFor(message.authorId, message.author);
  avatar.addEventListener('click', () => openTipSheet(message.authorId, message.author));
  avatar.title = `Tip ${censorName(message.author)}`;

  const who = el('span', 'msg__who');
  /* Masked for display only. `message.author` stays the real Mojang username everywhere it is
   * sent back to the server â€” tipping and the admin timeout endpoints both resolve it against
   * normalized_username, and a masked name resolves to nobody. */
  who.textContent = censorName(message.author);

  top.append(avatar, who);

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
  const line = el('div', isRoulette ? 'msg msg--hit msg--roulette' : 'msg msg--hit');

  const top = el('div', 'msg__top');
  top.append(avatarFor(activity.playerId, activity.player || 'Steve'));
  const who = el('span', 'msg__who');
  who.textContent = censorName(activity.player) || 'Someone';
  top.append(who);
  if (isRoulette) {
    const game = el('i', 'msg__badge msg__badge--roulette');
    game.textContent = 'ROULETTE';
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
  // Sort key kept on the node so a hit arriving between two polls still lands in time order.
  node.dataset.at = String(when ? new Date(when).getTime() : Date.now());
  const nodeAt = Number(node.dataset.at);

  /* Measure before changing the log. Measuring after append makes a newly-added line increase
   * scrollHeight first, so a reader who was exactly at the bottom suddenly appears not to be and
   * the rail stops following. An empty log always follows while its initial history is filled. */
  const followTail =
    !log.children.length || log.scrollHeight - log.scrollTop - log.clientHeight < 60;

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
}

function trim() {
  while (log.children.length > MAX_LINES) log.firstElementChild.remove();
  if (!log.children.length) {
    const empty = el('div', 'msg msg--sys');
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
