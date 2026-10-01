/* ui.js — shared chrome: toasts, modal, wallet readout.
 * Imports only data/store/util so nothing here can create an import cycle.
 */
import { $, el, money, safeImage } from './util.js';
import { RARITY } from './data.js';
import { state, bus } from './store.js';
import { navigate, onNavigate } from './routing.js';

/* ─────────── toasts ─────────── */
export function toast({ title, body = '', img = null, kind = 'win', ttl = 4200 }) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const t = el('div', 'toast toast--' + kind);
  t.setAttribute('role', 'status');
  if (img) {
    const art = document.createElement('img');
    art.src = safeImage(img);
    art.alt = '';
    t.appendChild(art);
  }
  const copy = document.createElement('div');
  const heading = document.createElement('b');
  heading.textContent = title;
  copy.appendChild(heading);
  if (body) {
    const detail = document.createElement('span');
    detail.textContent = body;
    copy.appendChild(detail);
  }
  t.appendChild(copy);
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .28s, transform .28s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(18px)';
    setTimeout(() => t.remove(), 300);
  }, ttl);
}

/* ─────────── global chat broadcast ─────────── */
/* Anything worth shouting about goes on the bus; the chat rail renders it. */
export function broadcast({ who = 'DROP', text, img = null, color = null }) {
  bus.dispatchEvent(new CustomEvent('chat:system', { detail: { who, text, img, color } }));
}

/* ─────────── modal ─────────── */
let restoreFocus = null;

export function openModal(title, build, opts = {}) {
  const dlg = $('#modal');
  restoreFocus = document.activeElement;
  dlg.dataset.variant = opts.variant || '';
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  build(body);
  if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
  else dlg.setAttribute('open', '');
  return body;
}

export function closeModal() {
  const dlg = $('#modal');
  if (dlg.open) dlg.close();
  else dlg.removeAttribute('open');
  if (restoreFocus?.focus) restoreFocus.focus();
}

export function initModal() {
  const dlg = $('#modal');
  $('#modalClose').addEventListener('click', closeModal);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); });
  // clicking the backdrop (the dialog element itself) dismisses
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeModal(); });
}

/* ─────────── ⓘ hints on touch screens ───────────
 *
 * matte.css opens a hint's bubble on :hover and :focus-visible. A phone gives it neither: there is
 * no hover, iOS never focuses a tapped button, and Chrome does not count a tap as focus-visible.
 * Every one-sentence explanation on the site was unreachable from a phone.
 *
 * So on a touch screen a tap opens a real element instead, placed against the viewport rather than
 * the icon: a hint beside a heading at the right edge of a 320px screen would otherwise centre its
 * bubble half off the glass. One is open at a time, and the next tap anywhere, a scroll, Escape or
 * a route change closes it. Mouse and keyboard keep the CSS bubble untouched. */
const TOUCH = window.matchMedia('(hover: none)');
const HINT_GAP = 12;
let openHint = null;

function closeHint() {
  if (!openHint) return;
  openHint.bubble.remove();
  openHint.button.setAttribute('aria-expanded', 'false');
  openHint.button.removeAttribute('aria-describedby');
  openHint = null;
}

function showHint(button) {
  const text = button.dataset.tip || button.getAttribute('aria-label');
  if (!text) return;
  const bubble = el('div', 'tipfloat');
  bubble.id = 'tipfloat';
  bubble.setAttribute('role', 'tooltip');
  bubble.textContent = text;
  // Inside an open modal the bubble has to join the dialog's top layer or it renders beneath it.
  (button.closest('dialog[open]') || document.body).appendChild(bubble);

  const icon = button.getBoundingClientRect();
  /* The phone tab bar is fixed over the foot of the viewport; a bubble below that line would sit
   * under it. On wider layouts the same bar lives in the header, which is why it only counts when
   * it is actually down there. */
  const bar = $('.top .tabs')?.getBoundingClientRect();
  const floor = bar && bar.top > innerHeight / 2 ? bar.top : innerHeight;
  const { offsetWidth: width, offsetHeight: height } = bubble;
  const centre = icon.left + icon.width / 2;
  const left = Math.min(Math.max(centre - width / 2, HINT_GAP), innerWidth - HINT_GAP - width);
  const below = icon.bottom + 8;
  const fitsBelow = below + height <= floor - HINT_GAP;
  bubble.dataset.side = fitsBelow ? 'below' : 'above';
  bubble.style.left = `${left}px`;
  bubble.style.top = `${fitsBelow ? below : icon.top - 8 - height}px`;
  bubble.style.setProperty('--tip-arrow', `${centre - left}px`);

  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', bubble.id);
  openHint = { button, bubble };
}

export function initHints() {
  document.addEventListener('click', (event) => {
    if (!TOUCH.matches) return;
    const button = event.target instanceof Element ? event.target.closest('.ihint') : null;
    const wasOpen = openHint?.button;
    closeHint();
    // A second tap on the same icon is the close, not a reopen.
    if (button && button !== wasOpen) showHint(button);
  });
  /* Only a scroll that moves the icon closes it. Capture sees every scroller on the page, and the
   * chat log or a live strip ticking over somewhere else is not a reason to snatch the bubble away
   * mid-sentence. */
  window.addEventListener('scroll', (event) => {
    const moved = event.target;
    if (!openHint) return;
    if (moved === document || (moved instanceof Node && moved.contains(openHint.button))) closeHint();
  }, { passive: true, capture: true });
  window.addEventListener('resize', closeHint);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeHint();
  });
  onNavigate(closeHint);
}

/* ─────────── wallet readout ─────────── */
export function initWallet() {
  const cash = $('#wCash');
  const paint = () => {
    const next = money(state.balance);
    if (cash.textContent !== next) {
      cash.textContent = next;
      /* Restart the pop by removing the class, forcing a reflow, then re-adding it. Without the
       * reflow the browser coalesces the two mutations and the animation never replays, so a
       * second win of the same size would land silently. */
      cash.classList.remove('pop');
      void cash.offsetWidth;
      cash.classList.add('pop');
    }
  };
  bus.addEventListener('change', paint);
  /* The pill is a link to the dashboard now rather than a modal apologising for not having one.
   * vip.js owns what it displays; this only owns where it goes. */
  $('#lvlPill').addEventListener('click', () => {
    navigate('/vip');
  });
  paint();
}

/* ─────────── item detail ───────────
 * Catalog details are read-only; inventory actions live on the Inventory page. */
/* itemSheet is retired along with inventory: nothing in a cash-only platform hands the player an
 * item to inspect. Removed rather than left dormant — a dead innerHTML sink that renders
 * server-supplied names is exactly the kind of thing that gets wired back up later by someone who
 * does not know it was never escaped. */

/* ─────────── deposit sheet (mock) ─────────── */
export function depositSheet({ credit, addKeys }) {
  openModal('Add balance', (body) => {
    body.innerHTML =
      `<p>This is a front-end mockup — no real money moves, and nothing here touches a DonutSMP account.
       Top up your fake balance to keep testing.</p>
       <div class="modal__label">In-game dollars</div>
       <div class="modal__row" id="depCash"></div>
       <div class="modal__label">Crate keys</div>
       <div class="modal__row" id="depKeys"></div>`;
    const cashRow = body.querySelector('#depCash');
    [500_000, 2_000_000, 10_000_000, 50_000_000].forEach((v) => {
      const b = el('button', 'btn', money(v));
      b.addEventListener('click', () => {
        credit(v);
        toast({ kind: 'gold', title: 'Balance topped up', body: money(v) + ' added' });
        closeModal();
      });
      cashRow.appendChild(b);
    });
    const keyRow = body.querySelector('#depKeys');
    [1, 3, 10].forEach((k) => {
      const b = el('button', 'btn', k + (k > 1 ? ' keys' : ' key'));
      b.addEventListener('click', () => {
        addKeys(k);
        toast({ kind: 'gold', title: 'Keys added', body: k + ' on your ring' });
        closeModal();
      });
      keyRow.appendChild(b);
    });
  });
}

/* ─────────── provably-fair sheet ─────────── */
export function fairSheet(seed) {
  openModal('Provably fair', (body) => {
    body.innerHTML =
      `<p>Every roll is committed before you play. The server seed is hashed up front; after the round
       the raw seed is published so you can re-hash it and replay the exact outcome.</p>
       <div class="kv"><span>server seed (hashed)</span><span>${seed.server.slice(0, 26)}…</span></div>
       <div class="kv"><span>client seed</span><span>${seed.client}</span></div>
       <div class="kv"><span>nonce</span><span>${seed.nonce}</span></div>
       <div class="kv"><span>crate odds</span><span>rarity weight ÷ pool</span></div>
       <div class="kv"><span>algorithm</span><span>${seed.algorithm || 'HMAC-SHA256-v1'}</span></div>
       <p style="margin-top:14px">Completed case and upgrader rounds return the raw server seed, digest, nonce, and recorded roll for independent verification.</p>`;
  });
}
