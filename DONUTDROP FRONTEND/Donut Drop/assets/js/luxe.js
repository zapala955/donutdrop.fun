/* luxe.js — the /test shell: the sidebar, the chat panel, Ctrl+K, and the lobby's live counts.
 *
 * Loaded only by test.html, after app.js. app.js still owns every route, the wallet, the account
 * menu, the chat itself and the home lobby's filters; this file adds the furniture the new shell
 * has and the old one did not, and never reaches into a game.
 *
 * Two things are remembered per browser, both conveniences: whether the sidebar is open, and
 * whether the chat panel is showing. Storage can be missing or throw (private windows, blocked
 * site data), and the shell works the same without it.
 */
import { api } from './api.js';
import { SPOTLIGHT_GAMES, isNewGame } from './data.js';
import { $, $$, money, reduceMotion } from './util.js';
import { bus, roundHistory, state } from './store.js';
import { BASE, appPath, currentRouteName, fullPath, navigate, onNavigate } from './routing.js';
import { isMuted, setMuted } from './audio-engine.js';

const SIDE_KEY = 'lx:side';
/* v2 (2026-11-14): the chat now opens by default on a wide screen, so everybody starts from open
 * once; closing it is remembered from then on. */
const CHAT_KEY = 'lx:chat:v2';
const PLAYING_EVERY_MS = 30_000;
/* Below this the menu is a drawer and the chat a sheet over the page. Matches luxe.css. */
const phone = matchMedia('(max-width: 1023px)');

const recall = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* a convenience, not a requirement */ }
};

const body = document.body;
const side = $('#lxSide');
const sideBtn = $('#lxSideBtn');
const dockMenu = $('#lxDockMenu');
const scrim = $('#lxScrim');
const tip = $('#lxTip');

/* ═════════ the sidebar ═════════ */
function paintSide() {
  const open = body.dataset.side === 'open';
  const drawer = body.dataset.drawer === 'open';
  const expanded = phone.matches ? drawer : open;
  sideBtn.setAttribute('aria-expanded', String(expanded));
  sideBtn.setAttribute('aria-label', expanded ? 'Close menu' : 'Open menu');
  dockMenu?.setAttribute('aria-expanded', String(drawer));
  scrim.hidden = !(phone.matches && drawer);
}

function setSide(open) {
  body.dataset.side = open ? 'open' : 'closed';
  remember(SIDE_KEY, body.dataset.side);
  hideTip();
  paintSide();
}

function setDrawer(open) {
  body.dataset.drawer = open ? 'open' : 'closed';
  paintSide();
  if (open) $('.lxnav', side)?.focus();
}

/* Open on a wide screen until the player closes it (2026-11-20, the redesign preview's layout); a
 * remembered choice either way wins. */
const sideSaved = recall(SIDE_KEY);
body.dataset.side = (sideSaved ?? (matchMedia('(min-width: 1280px)').matches ? 'open' : 'closed')) === 'open' ? 'open' : 'closed';
body.dataset.drawer = 'closed';
paintSide();

sideBtn.addEventListener('click', () => {
  if (phone.matches) setDrawer(false);
  else setSide(body.dataset.side !== 'open');
});
dockMenu?.addEventListener('click', () => setDrawer(body.dataset.drawer !== 'open'));
scrim.addEventListener('click', () => setDrawer(false));
phone.addEventListener('change', () => {
  body.dataset.drawer = 'closed';
  paintSide();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && body.dataset.drawer === 'open') {
    setDrawer(false);
    dockMenu?.focus();
  }
});

/* The collapsed rail's labels. One chip, placed beside whatever the pointer or the keyboard is on,
 * shown at once on focus and after a beat on hover so a pass across the rail does not flicker. */
let tipTimer = 0;
function showTip(target, delay) {
  clearTimeout(tipTimer);
  if (phone.matches || body.dataset.side === 'open') return;
  tipTimer = window.setTimeout(() => {
    const rect = target.getBoundingClientRect();
    tip.textContent = target.dataset.tip;
    tip.style.left = `${Math.round(rect.right + 10)}px`;
    tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    tip.hidden = false;
  }, delay);
}
function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
}
side.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) showTip(target, 120);
});
side.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget || !event.target.closest('[data-tip]')?.contains(event.relatedTarget)) hideTip();
});
side.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) showTip(target, 0);
});
side.addEventListener('focusout', hideTip);
$('.lxside__nav', side).addEventListener('scroll', hideTip, { passive: true });

/* ═════════ where you are ═════════
 * The menu names kinds of game, not games (the redesign preview's, 2026-11-20): on a game's page its
 * kind is lit, read from the game's card in the lobby; on the lobby, the kind picked (/?c=…) or
 * Lobby itself. */
const pickedKind = () => new URLSearchParams(location.search).get('c') || '';
function routeKind(route) {
  const card = $(`#lobby .gcard[href="/${route}"]`);
  return card ? card.dataset.cat.split(' ').find((kind) => kind !== 'new') || '' : '';
}
function markRoute() {
  const route = currentRouteName();
  const kind = route === 'home' ? pickedKind() : routeKind(route);
  for (const link of $$('.lxnav', side)) {
    const on = link.dataset.cat ? link.dataset.cat === kind : link.dataset.route === route && !(route === 'home' && kind);
    link.setAttribute('aria-current', on ? 'page' : 'false');
  }
  for (const link of $$('.lxdock [data-dock]')) {
    link.setAttribute('aria-current', link.dataset.dock === route ? 'page' : 'false');
  }
}

/* ═════════ the chat panel ═════════ */
const chatBtn = $('#lxChatBtn');
const dockChat = $('#lxDockChat');
const drawerHandle = $('#burger');

function setChat(open, { save = true } = {}) {
  body.dataset.chat = open ? 'open' : 'closed';
  chatBtn.setAttribute('aria-pressed', String(open));
  chatBtn.setAttribute('aria-label', open ? 'Hide chat' : 'Show chat');
  if (save) remember(CHAT_KEY, body.dataset.chat);
}
/* Open by default where it fits beside the page without covering a game (wide.matches, the width
 * luxe.css docks it at); below that it lays over the page, so it waits to be asked for. Whatever
 * the player chose last wins. A Discord rain post links here with ?rain=1: the chat opens on the
 * rain card, on a phone as its drawer. */
const wide = matchMedia('(min-width: 1280px)');
{
  const saved = recall(CHAT_KEY);
  setChat(saved ? saved === 'open' : wide.matches, { save: false });
  if (new URLSearchParams(location.search).has('rain')) {
    if (phone.matches) requestAnimationFrame(() => { if (!body.classList.contains('chat-open')) drawerHandle?.click(); });
    else setChat(true, { save: false });
  }
}

/* chat.js still remembers whether the OLD rail was folded away (body[data-chat-collapsed], stored
 * per browser), and social.css answers that flag by squeezing the chat to no width and hiding
 * everything in it. Anybody who had ever folded the old rail opened this panel to find it empty.
 * The panel's own open state above replaces that flag here, so it is cleared. */
delete body.dataset.chatCollapsed;
chatBtn.addEventListener('click', () => setChat(body.dataset.chat !== 'open'));

/* On a phone the chat is app.js's drawer (body.chat-open); its handle is #burger. */
dockChat?.addEventListener('click', () => drawerHandle.click());
new MutationObserver(() => {
  dockChat?.setAttribute('aria-expanded', String(body.classList.contains('chat-open')));
}).observe(body, { attributes: true, attributeFilter: ['class'] });

{
  const head = $('#chat .chat__head');
  if (head && !head.querySelector('.chat__x')) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lxicon chat__x';
    close.setAttribute('aria-label', 'Close chat');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener('click', () => {
      if (phone.matches) {
        if (body.classList.contains('chat-open')) drawerHandle.click();
      } else {
        setChat(false);
        chatBtn.focus();
      }
    });
    head.appendChild(close);
  }
}

/* ═════════ the two doors ═════════ */
$('#lxRegister')?.addEventListener('click', () => $('#loginBtn').click());

/* ═════════ search: Ctrl+K from anywhere ═════════ */
const find = $('#lxFind');
/* The bar's search field (2026-11-20). It types into the lobby's own box, which does the
 * filtering, so there is one search with one set of rules; from another page it opens the lobby
 * first. The lobby's box is hidden wherever this field shows. */
function findInLobby() {
  const run = () => {
    const input = $('#lobbySearch');
    if (!input) return;
    input.value = find.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Results in sight: under the offers the grid can sit below the fold.
    const lobbyBox = $('#lobby');
    if (lobbyBox && lobbyBox.getBoundingClientRect().top > innerHeight * 0.6) {
      lobbyBox.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
  };
  if (currentRouteName() !== 'home') {
    navigate('/');
    requestAnimationFrame(run);
  } else {
    run();
  }
}
if (find) {
  find.addEventListener('input', findInLobby);
  find.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && find.value) {
      event.preventDefault();
      find.value = '';
      findInLobby();
    }
  });
  // "Show every game" under an empty result clears the lobby's box; this one follows.
  $('#lobbyReset')?.addEventListener('click', () => { find.value = ''; });
}

function focusSearch() {
  /* Under 1024px the lobby's box is folded away until the magnifier asks for it (the preview's
   * phone bar); it folds again when it is left empty. */
  document.body.dataset.find = 'open';
  if (find && find.offsetParent !== null) {
    find.focus();
    find.select();
    return;
  }
  const go = () => {
    const input = $('#lobbySearch');
    if (!input) return;
    input.focus({ preventScroll: true });
    input.closest('.lxsearch')?.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  };
  if (currentRouteName() !== 'home') {
    navigate('/');
    requestAnimationFrame(go);
  } else {
    go();
  }
}
$('#lxSearchBtn')?.addEventListener('click', focusSearch);
$('#lobbySearch')?.addEventListener('blur', (event) => {
  if (!event.target.value.trim()) delete document.body.dataset.find;
});
/* The bottom bar's Wallet: the Wallet window signed in, the sign-in signed out. */
$('#lxDockWallet')?.addEventListener('click', () => {
  $(document.body.dataset.auth === 'in' ? '#depositBtn' : '#loginBtn')?.click();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusSearch();
  }
});

/* ═════════ the lobby ═════════ */
const lobby = $('#lobby');

/* "New" is a category the markup cannot know: data.js says which games are new. Those cards join
 * the category, and the tab goes when none is new. The cards carry no "New" tag since 2026-11-10
 * (the owner asked for the tags to go). */
function syncNewTab() {
  const tab = $('#lxTabNew');
  if (!tab) return;
  let any = false;
  for (const card of $$('.gcard', lobby)) {
    const game = SPOTLIGHT_GAMES.find((entry) => entry.route === card.getAttribute('href'));
    const isNew = Boolean(game && isNewGame(game));
    const cats = new Set(card.dataset.cat.split(' ').filter(Boolean));
    if (isNew) cats.add('new');
    else cats.delete('new');
    card.dataset.cat = [...cats].join(' ');
    any ||= isNew;
  }
  tab.hidden = !any;
}

/* "N playing": distinct players with a round in each game over the server's window. A game with
 * nobody in it says nothing, rather than a zero next to its name. */
let playingTimer = 0;
async function paintPlaying() {
  if (currentRouteName() !== 'home' || document.visibilityState !== 'visible') return;
  let games;
  try {
    ({ games } = await api.get('/v1/activity/playing'));
  } catch {
    return; // the next tick tries again; a missing count is only a missing count
  }
  for (const line of $$('[data-live]', lobby)) {
    const players = Number(games?.[line.dataset.live] ?? 0);
    line.hidden = !(players > 0);
    if (players > 0) $('b', line).textContent = players.toLocaleString('en-US');
  }
}
function schedulePlaying() {
  clearInterval(playingTimer);
  if (currentRouteName() !== 'home') return;
  void paintPlaying();
  playingTimer = window.setInterval(paintPlaying, PLAYING_EVERY_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void paintPlaying();
});

/* ═════════ the lobby's rows (2026-11-20, the redesign preview's) ═════════
 * How many games of each kind (the menu, each row's head), the search field's "Search 18 games", the
 * Originals row's arrows, and a kind of game on its own page at /?c=casino, /?c=slots, /?c=pvp or
 * /?c=cases: a heading, a line on it, the kinds as chips and every game of the kind in a grid. */
const KINDS = {
  casino: { name: 'Originals', icon: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
    lede: 'Games made for DonutLuxe. Every result is committed before you bet and can be checked after.' },
  slots: { name: 'Slots', icon: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 5v14M15 5v14',
    lede: 'Five reels and free spins. Both paytables list every pay before you spin.' },
  pvp: { name: 'PvP', icon: 'M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5 6 3M14 10l6.5-6.5V3H21M5 14l4 4M7 17l-3 3M3 19l2 2',
    lede: 'Play other players head to head.' },
  cases: { name: 'Cases', icon: 'M3 8 12 3l9 5v8l-9 5-9-5zm0 0 9 5 9-5M12 13v8',
    lede: 'Open cases for DonutSMP items and upgrade what you own. Every drop table shows its odds first.' },
};
const chipIcon = (d) => `<svg class="lxi" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function paintCounts() {
  const cards = $$('.gcard', lobby);
  for (const line of $$('[data-count]')) {
    const n = cards.filter((card) => card.dataset.cat.split(' ').includes(line.dataset.count)).length;
    line.textContent = line.closest('#origRow') ? `${n} games` : String(n);
  }
  find?.setAttribute('placeholder', `Search ${cards.length} games`);
}

function paintKind() {
  if (currentRouteName() !== 'home' || !lobby) return;
  const asked = pickedKind();
  const kind = KINDS[asked] ? asked : '';
  body.dataset.kind = kind;
  const head = $('#lxCat');
  head.hidden = !kind;
  if (kind) {
    $('#lxCatH').textContent = KINDS[kind].name;
    $('#lxCatP').textContent = KINDS[kind].lede;
    $('#lxChips').innerHTML = `<a class="lxchip" href="/">${chipIcon('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z')}Lobby</a>`
      + Object.entries(KINDS).map(([code, entry]) => `<a class="lxchip" href="/?c=${code}"${code === kind ? ' aria-current="page"' : ''}>${chipIcon(entry.icon)}${entry.name}</a>`).join('');
  }
  // The lobby's own tabs do the filtering (app.js); they are hidden, and this presses one.
  const tab = $(`.lobby__tab[data-cat="${kind || 'all'}"]`, lobby);
  if (tab && tab.getAttribute('aria-pressed') !== 'true') tab.click();
}

function wireRails() {
  for (const button of $$('[data-rail-prev], [data-rail-next]', lobby)) {
    const track = $(`#${button.dataset.railPrev || button.dataset.railNext}`);
    if (!track) continue;
    const step = button.dataset.railPrev ? -1 : 1;
    button.addEventListener('click', () => {
      track.scrollBy({ left: step * track.clientWidth * 0.9, behavior: reduceMotion() ? 'auto' : 'smooth' });
    });
  }
  for (const track of $$('.lxrail', lobby)) {
    const sync = () => {
      const max = track.scrollWidth - track.clientWidth - 2;
      const prev = $(`[data-rail-prev="${track.id}"]`);
      const next = $(`[data-rail-next="${track.id}"]`);
      if (prev) prev.disabled = track.scrollLeft <= 2;
      if (next) next.disabled = track.scrollLeft >= max;
    };
    track.addEventListener('scroll', sync, { passive: true });
    new ResizeObserver(sync).observe(track);
    sync();
  }
}
if (lobby) {
  paintCounts();
  wireRails();
}

/* The account button wears the player's head, as the preview's does: the same picture the sign-in
 * button carries (app.js), and the outline figure until it loads or if it cannot. */
function paintAcctHead() {
  const button = $('#acctBtn');
  const src = $('#loginHead')?.getAttribute('src');
  if (!button) return;
  let img = $('.acct__head', button);
  if (!state.authenticated || !src) {
    img?.remove();
    delete button.dataset.head;
    return;
  }
  if (!img) {
    img = document.createElement('img');
    img.className = 'acct__head';
    img.alt = '';
    img.width = 36;
    img.height = 36;
    img.addEventListener('error', () => { img.remove(); delete button.dataset.head; });
    img.addEventListener('load', () => { button.dataset.head = '1'; });
    button.appendChild(img);
  }
  if (img.getAttribute('src') !== src) img.src = src;
}
bus.addEventListener('change', () => requestAnimationFrame(paintAcctHead));
requestAnimationFrame(paintAcctHead);

/* ═════════ links under /test ═════════
 * A click is already routed (app.js reads the path through appPath). What has to be right before
 * the browser takes over is the address a middle click, a new tab or "copy link" uses: point it
 * under the preview prefix just before that happens. */
if (BASE) {
  const prefix = (event) => {
    const link = event.target.closest?.('a[href^="/"]');
    if (!link) return;
    const href = link.getAttribute('href');
    const url = new URL(href, location.origin);
    if (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`)) return;
    link.setAttribute('href', fullPath(appPath(url.pathname)) + url.search);
  };
  document.addEventListener('pointerdown', prefix, true);
  document.addEventListener('contextmenu', prefix, true);
  document.addEventListener('focusin', prefix, true);
}

/* ═════════ pages that need you signed in ═════════
 * Each page module says "Log in to …" in a one-line card of its own. Under that line goes the
 * button that does it, so the empty state is something you can act on. The card is rebuilt by its
 * module, so this watches for it rather than finding it once. */
const GATES = '.vip__notice, .acct__notice, .rake__notice, .daily__notice, .stats__notice, .creator__notice, .refer__card';
function armGates(scope) {
  for (const card of $$(GATES, scope)) {
    if (card.querySelector('.lxgate') || !/^Log in\b/.test(card.textContent.trim().replace(/^Invite & earn/, '').trim())) continue;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'lxbtn lxbtn--gold lxgate';
    go.textContent = 'Log in';
    go.addEventListener('click', () => $('#loginBtn').click());
    card.appendChild(go);
    // Only a real sign-in prompt wears the padlock (luxe-games.css); the same classes carry other notes.
    card.classList.add('lxgated');
  }
}
new MutationObserver(() => armGates($('#main'))).observe($('#main'), { childList: true, subtree: true });
armGates($('#main'));

/* ═════════ on every route ═════════ */
function onRoute() {
  markRoute();
  paintKind();
  hideTip();
  if (body.dataset.drawer === 'open') setDrawer(false);
  if (currentRouteName() === 'home') syncNewTab();
  schedulePlaying();
}
onNavigate(onRoute);
onRoute();

/* Slides only from here on: the remembered layout is already in place (see .lx-anim in luxe.css). */
requestAnimationFrame(() => requestAnimationFrame(() => body.classList.add('lx-anim')));

/* ═════════ "Jump back in" (2026-11-20, the redesign preview's) ═════════
 * The last three games the player had a round in, each linking back to it, with the last round's
 * result: the multiplier when it paid, what was lost when it did not. From GET /v1/history, asked
 * when the session is known and each time the lobby opens -- not on every settled round, which
 * would be a request per bet for a row the player is not looking at. */
const back = $('#lxBack');
const backList = $('#lxBackList');
let backAsked = 0;

function whenText(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(at)) / 86_400_000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function backCard(round, card) {
  const link = document.createElement('a');
  link.className = 'lxback__g';
  link.href = card.getAttribute('href');
  const art = document.createElement('img');
  art.src = card.querySelector('.lxcard__art')?.getAttribute('src') || '';
  art.alt = '';
  art.width = 40;
  art.height = 40;
  const copy = document.createElement('span');
  copy.className = 'lxback__copy';
  const name = document.createElement('b');
  name.textContent = card.querySelector('.gcard__name')?.textContent || round.name;
  const when = document.createElement('small');
  when.textContent = whenText(round.at);
  copy.append(name, when);
  const result = document.createElement('span');
  const wager = Number(round.wagerMinor);
  const payout = Number(round.payoutMinor);
  if (payout >= wager && wager > 0) {
    result.className = 'lxback__res is-up';
    result.textContent = `${(round.multiplier ?? payout / wager).toFixed(2)}×`;
  } else {
    result.className = 'lxback__res';
    result.textContent = `-${money(wager - payout)}`;
  }
  link.append(art, copy, result);
  return link;
}

async function paintBack() {
  if (!back || !backList) return;
  const asked = ++backAsked;
  if (!state.authenticated) {
    back.hidden = true;
    return;
  }
  let rounds;
  try {
    rounds = (await roundHistory({ limit: 40 })).rounds || [];
  } catch {
    return; // A lobby row is not worth an error: it keeps what it showed.
  }
  if (asked !== backAsked || !state.authenticated) return;
  const seen = new Set();
  const picks = [];
  for (const round of rounds) {
    // The history calls the case room "cases"; its lobby card is "crates".
    const key = round.game === 'cases' ? 'crates' : round.game;
    if (seen.has(key)) continue;
    const card = $(`#lobby .gcard[data-game="${CSS.escape(key)}"]`);
    if (!card) continue;
    seen.add(key);
    picks.push(backCard(round, card));
    if (picks.length === 3) break;
  }
  backList.replaceChildren(...picks);
  back.hidden = picks.length === 0;
}

bus.addEventListener('change', (event) => {
  if (['ready', 'login', 'logout', 'private'].includes(event.detail)) void paintBack();
});
onNavigate(() => {
  if (currentRouteName() === 'home') void paintBack();
});
if (state.ready) void paintBack();

/* ═════════ the game pages (2026-11-20, the redesign preview's) ═════════
 * Under each single table: a "Provably fair" chip on the bar, and a card with two tabs, how the
 * game works (the bar's own hint text, so the words stay where the game's author wrote them) and
 * how a result is checked. Built once, from the markup that is already there. */
const TABLES = '.crash, .mines, .tower, .chicken, .dice, .limbo, .cflip, .stocks, .fishing, .icefish, .derby, .slots, .plinko, .bj, .roulette, .upg, .crates, .battles';
const FAIR_TEXT = 'Every result comes from a server seed that is committed before you bet, your own client seed and a round number. Once a seed is revealed, you can check any round yourself.';

function fairChip() {
  const chip = document.createElement('a');
  chip.className = 'pvfair';
  chip.href = '/fairness';
  chip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg><span>Provably fair</span>';
  return chip;
}

function howCard(view, how) {
  const card = document.createElement('section');
  card.className = 'pvhow';
  card.setAttribute('aria-label', 'About this game');
  const tabs = document.createElement('div');
  tabs.className = 'pvhow__tabs';
  tabs.setAttribute('role', 'tablist');
  const body = document.createElement('p');
  body.className = 'pvhow__body';
  body.setAttribute('role', 'tabpanel');
  body.id = `pvhow-${view.dataset.view}`;
  const show = (which) => {
    for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.tab === which));
    if (which === 'how') {
      body.textContent = how;
    } else {
      const check = document.createElement('a');
      check.href = '/fairness';
      check.textContent = 'Check a round';
      body.replaceChildren(`${FAIR_TEXT} `, check);
    }
  };
  for (const [key, label] of [['how', 'How it works'], ['fair', 'Fairness']]) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.tab = key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', body.id);
    tab.textContent = label;
    tab.addEventListener('click', () => show(key));
    tabs.appendChild(tab);
  }
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = tabs.querySelector('[aria-selected="false"]');
    show(next.dataset.tab);
    next.focus();
  });
  card.append(tabs, body);
  show('how');
  return card;
}

/* The preview's sound key on the bar, beside the chip: the same switch as the top bar's. Only on
 * the games the owner has had moved to the preview's own panel (2026-11-21: Dice); the others keep
 * their bars as they were. */
const SOUND_KEY_GAMES = new Set(['dice']);
const SOUND_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.5v5h3.25L13 18V6L8.25 9.5H5z"/><path d="M16 9a4.25 4.25 0 0 1 0 6"/><path d="M18.5 6.5a7.75 7.75 0 0 1 0 11"/></svg>';
const SOUND_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.5v5h3.25L13 18V6L8.25 9.5H5z"/><path d="m16.5 9.5 5 5m0-5-5 5"/></svg>';
const soundKeys = [];
function paintSoundKeys() {
  const off = isMuted();
  for (const key of soundKeys) {
    key.innerHTML = off ? SOUND_OFF : SOUND_ON;
    key.setAttribute('aria-pressed', String(!off));
    key.setAttribute('aria-label', off ? 'Unmute sound' : 'Mute sound');
  }
}
function soundKey() {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = 'pvsound';
  key.addEventListener('click', () => setMuted(!isMuted()));
  soundKeys.push(key);
  return key;
}
window.addEventListener('lx:mute', paintSoundKeys);

for (const view of $$('.view')) {
  const head = view.querySelector(':scope > .phead--game');
  if (!head || !view.querySelector(`:scope > :is(${TABLES})`)) continue;
  if (SOUND_KEY_GAMES.has(view.dataset.view)) head.appendChild(soundKey());
  head.appendChild(fairChip());
  const how = head.querySelector('.phead__how')?.dataset.tip;
  if (how) {
    view.appendChild(howCard(view, how));
    view.classList.add('has-pvhow');
  }
}
paintSoundKeys();
