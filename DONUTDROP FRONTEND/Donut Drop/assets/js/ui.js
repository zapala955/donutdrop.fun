/* ui.js — shared chrome: toasts, modal, wallet readout.
 * Imports only data/store/util so nothing here can create an import cycle.
 */
import { $, el, money, safeImage } from './util.js';
import { RARITY } from './data.js';
import { state, bus } from './store.js';

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
    location.hash = '#/vip';
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
