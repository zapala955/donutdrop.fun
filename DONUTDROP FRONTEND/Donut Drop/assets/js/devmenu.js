/* devmenu.js — the animation test bench.
 *
 * Every cutscene on this site is gated behind money and probability. The
 * keynote fires on roughly a quarter of one percent of pulls; the magma burn
 * needs a losing upgrader round; the chest arc needs a winning one. Testing any
 * of them meant spending balance and re-rolling until the dice cooperated,
 * which is a terrible way to iterate on a two-second piece of motion and an
 * even worse way to reproduce a bug someone reported.
 *
 * So every effect gets a door that opens without the dice. The bench calls the
 * exact same exported functions the app calls, with real catalogue items — not
 * a parallel preview implementation, which would drift from the real one and
 * start lying about what shipped.
 *
 * It is developer surface, not player surface: hidden by default, opened with a
 * keyboard chord or ?dev=1, and it never touches the balance.
 */
import { ITEMS, BY_ID, CRATES, RARITY } from './data.js';
import { state, devLogin, logout } from './store.js';
import { $, el, money } from './util.js';

/* The developer login token is NEVER persisted.
 *
 * It mints sessions without identity proof, which makes it a credential, and a credential in
 * localStorage is readable by any script that ever runs on this origin — one XSS and the bypass
 * is stolen and replayable. It was cached there for convenience; the convenience is not worth a
 * stored secret that unlocks an authentication bypass.
 *
 * It lives in the input element for the lifetime of the tab and nowhere else. Reloading means
 * typing it again, which is the correct trade.
 */

/* Ctrl+Alt+D. Three keys, none of them a browser shortcut, and nothing a
 * player reaches by accident. ?dev=1 is the shareable version for a bug report. */
const CHORD = (e) => e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D');

/* The tests. Each one names the module it drives, so the bench is also the
 * index of what animation code exists. */
const TESTS = [
  {
    id: 'reel',
    n: '1',
    name: 'CS:GO ticker scroll',
    sub: 'reel.js · 5.6s · forward-only deceleration into a crawl',
    accent: 'var(--rose-mid)',
    async run(opts) {
      const { playReel } = await import('./reel.js');
      const crate = CRATES[2];
      const pool = crate.pool.map((i) => BY_ID[i]).filter(Boolean);
      const item = opts.item || pool[Math.floor(Math.random() * pool.length)];
      return playReel({ item, crate, pool });
    },
  },
  {
    id: 'gold',
    n: '2',
    name: 'Gold tier tease → keynote',
    sub: 'reel.js + cutscene.js · the full two-stage jackpot, end to end',
    accent: 'var(--amber)',
    async run(opts) {
      /* Calls the SAME entry point production calls.
       *
       * This preset used to inline the two-stage pairing itself. That made it a copy of the real
       * flow rather than a test of it, and a copy is free to drift: the bench could keep playing
       * a sequence the crate page had stopped using, and still look green. playMystery is now the
       * one definition of what a mystery landing plays, and this button exercises it. */
      const { playMystery } = await import('./mystery.js');
      const crate = CRATES[1];
      const pool = crate.pool.map((i) => BY_ID[i]).filter(Boolean);
      const item = opts.item || BY_ID.elytra;
      return playMystery({ item, crate, pool });
    },
  },
  {
    id: 'keynote',
    n: '3',
    name: 'High-profit keynote cinematic',
    sub: 'cutscene.js · 7.4s · shroud, riser, dead-stop apex, boom',
    accent: 'var(--amber)',
    async run(opts) {
      const { playCutscene } = await import('./cutscene.js');
      // the Miner Crate Elytra: 350M on a 220K case, the biggest multiple here
      const item = opts.item || BY_ID.elytra;
      const crate = CRATES[1];
      // the pool feeds the decoy silhouettes, so they are real possible drops
      const pool = crate.pool.map((i) => BY_ID[i]).filter(Boolean);
      return playCutscene({ item, crate, pool });
    },
  },
  {
    id: 'chest',
    n: '4',
    name: 'Upgrader arc into the Ender Chest',
    sub: 'reveal.js · 3.05s · ballistic arc, lid snap, particle dust',
    accent: 'var(--cyan)',
    async run(opts) {
      const { playReveal } = await import('./reveal.js');
      const item = opts.item || BY_ID.elytra;
      return playReveal({ won: true, item, stake: 250000, payout: item.value });
    },
  },
  {
    id: 'magma',
    n: '5',
    name: 'Magma & nether lava surge',
    sub: 'reveal.js · 2.05s · surge, bubbling, heat haze, slag to ash',
    accent: 'var(--crimson)',
    async run(opts) {
      const { playReveal } = await import('./reveal.js');
      const item = opts.item || BY_ID.elytra;
      return playReveal({ won: false, item, stake: 250000, payout: 0 });
    },
  },
];

let root = null;
let open = false;
let busy = false;

export function initDevMenu(mount) {
  root = mount || document.getElementById('devRoot');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';

  root.innerHTML = `
    <button class="devfab" id="devFab" aria-expanded="false"
            aria-controls="devPanel" title="Animation test menu (Ctrl+Alt+D)">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4v16M5 8h9a3 3 0 0 1 0 6H5"/><circle cx="18" cy="18" r="2.4"/>
      </svg>
      <span>FX</span>
    </button>

    <div class="devpanel" id="devPanel" role="dialog" aria-label="Animation test menu" hidden>
      <div class="devpanel__top">
        <span class="devpanel__title mono">ANIMATION TEST BENCH</span>
        <button class="devpanel__x" id="devClose" aria-label="Close test menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="devpanel__note">
        Runs the real exported animation, not a preview copy. Nothing here spends balance.
      </p>

      <label class="devpanel__field">
        <span class="devpanel__label mono">ITEM</span>
        <select class="devpanel__sel mono" id="devItem"></select>
      </label>

      <!-- Test login. The pay-login flow needs a custody bot online to take a payment and
           confirm it; this needs nothing but the backend. -->
      <div class="devauth">
        <span class="devpanel__label mono">TEST LOGIN</span>
        <p class="devauth__note">
          Signs in as a disposable verified account with a funded balance, seeded inventory and a
          stocked house, with no bot running. Requires the backend started with
          <code class="mono">DEV_LOGIN_ENABLED=true</code>.
        </p>
        <div class="devauth__row">
          <input class="devauth__in mono" id="devToken" type="password" autocomplete="off"
                 spellcheck="false" placeholder="DEV_LOGIN_TOKEN" aria-label="Developer login token">
          <button class="devauth__go mono" id="devLoginBtn" type="button">LOG IN</button>
        </div>
        <div class="devauth__row">
          <button class="devauth__alt mono" id="devRefreshBtn" type="button"
                  title="Re-stamps the dev bot heartbeat so wagers stop failing">REFRESH BOT</button>
          <button class="devauth__alt mono" id="devLogoutBtn" type="button">LOG OUT</button>
        </div>
        <span class="devauth__state mono" id="devAuthState">signed out</span>
      </div>

      <div class="devlist" id="devList"></div>

      <div class="devpanel__foot mono">
        <span id="devStatus">idle</span>
        <span class="devpanel__keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>D</kbd></span>
      </div>
    </div>`;

  const panel = $('#devPanel', root);
  const fab = $('#devFab', root);
  const status = $('#devStatus', root);

  /* the item picker: every catalogue item, richest first, so the interesting
     ones to test against are at the top */
  const sel = $('#devItem', root);
  sel.innerHTML = '<option value="">— random from the test’s own pool —</option>' +
    [...ITEMS].sort((a, b) => b.value - a.value).map((it) =>
      `<option value="${it.id}">${it.name} · ${money(it.value)} · ${RARITY[it.rarity].name}</option>`
    ).join('');

  wireDevAuth(root);

  const list = $('#devList', root);
  for (const test of TESTS) {
    const row = el('button', 'devrow');
    row.type = 'button';
    row.style.setProperty('--ac', test.accent);
    row.dataset.test = test.id;
    row.innerHTML = `
      <span class="devrow__n mono">${test.n}</span>
      <span class="devrow__body">
        <span class="devrow__name">${test.name}</span>
        <span class="devrow__sub mono">${test.sub}</span>
      </span>
      <span class="devrow__go mono">RUN</span>`;
    row.addEventListener('click', () => fire(test));
    list.appendChild(row);
  }

  async function fire(test) {
    if (busy) return;
    busy = true;
    root.dataset.busy = '1';
    status.textContent = 'running ' + test.id + '…';
    /* The panel gets out of the way for the duration. An overlay is a full-
     * screen fixed layer and the panel sits above everything, so leaving it up
     * would put a debug UI in the middle of the shot being debugged. */
    setOpen(false, true);
    const t0 = performance.now();
    try {
      const id = sel.value;
      await test.run({ item: id ? BY_ID[id] : null });
      status.textContent = `${test.id} finished in ${((performance.now() - t0) / 1000).toFixed(2)}s`;
    } catch (err) {
      status.textContent = test.id + ' FAILED — see console';
      console.error('[test bench] ' + test.id + ' failed', err);
    } finally {
      busy = false;
      delete root.dataset.busy;
      setOpen(true, true);
    }
  }

  function setOpen(v, quiet) {
    open = v;
    panel.hidden = !v;
    fab.setAttribute('aria-expanded', String(v));
    root.dataset.open = v ? '1' : '0';
    if (v && !quiet) $('#devItem', root).focus();
  }

  fab.addEventListener('click', () => setOpen(!open));
  $('#devClose', root).addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (CHORD(e)) { e.preventDefault(); reveal(); setOpen(!open); }
    else if (e.key === 'Escape' && open && !busy) setOpen(false);
  });

  /* Hidden until asked for. A player who never types the chord and never adds
   * ?dev=1 has no idea it exists, which is the correct default for a control
   * that can play a jackpot cinematic on demand. */
  const wanted = new URLSearchParams(location.search).get('dev') === '1';
  function reveal() { root.dataset.on = '1'; }
  if (wanted) { reveal(); setOpen(true); }
}

/* ─────────── test login ─────────── */
function wireDevAuth(scope) {
  const input = $('#devToken', scope);
  const loginBtn = $('#devLoginBtn', scope);
  const refreshBtn = $('#devRefreshBtn', scope);
  const logoutBtn = $('#devLogoutBtn', scope);
  const label = $('#devAuthState', scope);

  // Deliberately not prefilled: the token is never stored anywhere to prefill it from.

  const paint = () => {
    if (state.authenticated) {
      label.dataset.on = '1';
      label.textContent = `signed in as ${state.user?.minecraftUsername || 'unknown'} · ${money(state.balance)}`;
    } else {
      delete label.dataset.on;
      label.textContent = 'signed out';
    }
  };

  /* The custody bot's heartbeat has to be inside 45 seconds or the upgrader and the case opener
   * refuse to touch stock. With no bot process running it goes stale about a minute after login,
   * so re-running the login is the way to re-stamp it — that is what this button does. */
  const run = async (button, working) => {
    const token = input.value.trim();
    if (!token) {
      label.dataset.err = '1';
      label.textContent = 'enter DEV_LOGIN_TOKEN first';
      return;
    }
    button.disabled = true;
    delete label.dataset.err;
    label.textContent = working;
    try {
      const result = await devLogin(token);
      paint();
      label.textContent =
        `signed in · ${money(Number(result.balanceMinor))} · +${result.lotsSeeded} lots · +${result.houseLotsSeeded} house`;
    } catch (error) {
      label.dataset.err = '1';
      label.textContent = error?.status === 404
        ? 'backend has DEV_LOGIN_ENABLED off'
        : `${error?.code || 'failed'} — ${error?.message || 'see console'}`;
      console.error('[test bench] dev login failed', error);
    } finally {
      button.disabled = false;
    }
  };

  loginBtn.addEventListener('click', () => run(loginBtn, 'signing in…'));
  refreshBtn.addEventListener('click', () => run(refreshBtn, 're-stamping bot…'));

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await logout();
      paint();
    } catch (error) {
      label.dataset.err = '1';
      label.textContent = 'logout failed — see console';
      console.error('[test bench] logout failed', error);
    } finally {
      logoutBtn.disabled = false;
    }
  });

  paint();
}
