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
import { $, $$, reduceMotion } from './util.js';
import { BASE, appPath, currentRouteName, fullPath, navigate, onNavigate } from './routing.js';

const SIDE_KEY = 'lx:side';
const CHAT_KEY = 'lx:chat';
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
  if (open) $('.lxmode', side)?.focus();
}

body.dataset.side = recall(SIDE_KEY) === 'open' ? 'open' : 'closed';
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

/* ═════════ where you are ═════════ */
const CASE_ROUTES = new Set(['crates', 'battles', 'studio']);
function markRoute() {
  const route = currentRouteName();
  for (const link of $$('.lxnav[data-route]', side)) {
    link.setAttribute('aria-current', link.dataset.route === route ? 'page' : 'false');
  }
  const mode = CASE_ROUTES.has(route) ? 'cases' : route === 'home' ? 'casino' : '';
  for (const tile of $$('.lxmode', side)) {
    tile.setAttribute('aria-current', tile.dataset.mode === mode ? 'page' : 'false');
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
setChat(recall(CHAT_KEY) === 'open', { save: false });
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
function focusSearch() {
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
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusSearch();
  }
});

/* ═════════ the lobby ═════════ */
const lobby = $('#lobby');
const more = $('#lxMore');

/* "New" is a category the markup cannot know: app.js decides which cards are new (data.js) and
 * shows their tag. Those cards join the category, and the tab goes when none is new. */
function syncNewTab() {
  const tab = $('#lxTabNew');
  if (!tab) return;
  let any = false;
  for (const card of $$('.gcard', lobby)) {
    const isNew = !$('.gcard__badge', card).hidden;
    const cats = new Set(card.dataset.cat.split(' ').filter(Boolean));
    if (isNew) cats.add('new');
    else cats.delete('new');
    card.dataset.cat = [...cats].join(' ');
    any ||= isNew;
  }
  tab.hidden = !any;
}

more?.addEventListener('click', () => {
  const all = lobby.dataset.all !== '1';
  lobby.dataset.all = all ? '1' : '0';
  more.setAttribute('aria-expanded', String(all));
  more.textContent = all ? 'Show fewer' : 'See all games';
  if (!all) $('#lobbyTrack').scrollLeft = 0;
});

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
  }
}
new MutationObserver(() => armGates($('#main'))).observe($('#main'), { childList: true, subtree: true });
armGates($('#main'));

/* ═════════ on every route ═════════ */
function onRoute() {
  markRoute();
  hideTip();
  if (body.dataset.drawer === 'open') setDrawer(false);
  if (currentRouteName() === 'home') syncNewTab();
  schedulePlaying();
}
onNavigate(onRoute);
onRoute();
