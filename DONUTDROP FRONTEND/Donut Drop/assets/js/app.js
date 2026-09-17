/* app.js — entry point: shell wiring, hash router, home + crates + inventory. */
import {
  RARITY, IMG,
} from './data.js';
import {
  state, bus, bootstrap, canAfford, openCase as requestCaseOpen,
  startLogin, loginStatus, completeLogin, logout,
  createDeposit, refreshActivity,
} from './store.js';
import {
  $, $$, el, money, itemTile, reduceMotion, safeImage,
} from './util.js';
import {
  toast, initModal, initWallet, fairSheet, broadcast,
  openModal, closeModal,
} from './ui.js';
import { mountUpgrader } from './upgrader.js';
import { mountPiggy, openWithdrawDesk } from './piggy.js';
import { mountCrates } from './crates.js';
import { mountBattles } from './battles.js';
import { mountDuel } from './duel.js';
import { mountSlither } from './slither.js';
import { mountReferrals, captureReferralCode } from './referrals.js';
import { mountVip, initVipWidget } from './vip.js';
import { mountRakeback } from './rakeback.js';
import { mountDaily } from './daily.js';
import { mountDiscord } from './discord.js';
import { mountRace } from './race.js';
import { mountCreators } from './creators.js';
import { mountLeaderboard, mountStatistics } from './board.js';
import { mountProfile, mountWallet, mountHistory, mountSettings } from './account.js';
import { mountSupport, mountTerms } from './info.js';
import { mountStudio } from './studio.js';
import { mountQuests } from './quests.js';
import { mountWar } from './war.js';
import { mountFair } from './fair.js';
import { initTicker } from './ticker.js';
import { initChat } from './chat.js';
import { initVaultJackpot } from './vault-jackpot.js';
import { initAudioEngine, setMuted, isMuted } from './audio-engine.js';
import { mountHero3d } from './hero3d.js';
import { playCutscene, warmCutscene, isJackpot } from './cutscene.js';
import { playReel, warmReel } from './reel.js';
import { initDevMenu } from './devmenu.js';

/* ═════════ home ═════════ */
function mountHome(view) {
  if (view.dataset.built) return;
  view.dataset.built = '1';

  // the hero runs as a live scene; the static art underneath is the fallback
  // and only stands down once WebGL is actually running
  const art = $('.hero__art', view);
  if (art) mountHero3d(art).catch(() => { delete art.dataset.mode; });

  /* Four routes, four figures each.
   *
   * These were paragraphs — one sentence of prose per card, four of them stacked down the
   * homepage, all saying roughly "this is a game and it is fair". A player scanning a lobby is
   * comparing games, and a sentence is the slowest possible way to answer "how many, how long,
   * how much". Every card now carries the same three-slot stat strip, so the four are readable
   * against each other in one pass instead of four reads. */
  const promos = [
    { ac: '#ffaa00', h: 'Crates',      art: 'chest.png',       href: '#/crates',
      stats: [['50', 'CRATES'], ['5', 'TIERS'], ['PUBLISHED', 'ODDS']] },
    { ac: '#ffd700', h: 'Upgrader',    art: 'ender_chest.png', href: '#/upgrader',
      stats: [['CASH', 'IN/OUT'], ['SERVER', 'ROLL'], ['LIVE', 'QUOTE']] },
    { ac: '#ffd700', h: 'Piggy Bank',  art: 'gold_block.png',  href: '#/piggy',
      stats: [['14d', 'MINIMUM'], ['FIXED', 'RETURN'], ['NO', 'RISK']] },
    { ac: '#ffaa00', h: 'Faction War', art: 'nether_star.png', href: '#/war',
      stats: [['3', 'SIDES'], ['7d', 'SEASON'], ['1', 'POOL']] },
  ];
  $('#promos', view).innerHTML = promos.map((p) => `
    <a class="promo" href="${p.href}" style="--ac:${p.ac}">
      <img class="promo__art" src="${IMG}${p.art}" alt="">
      <h3>${p.h}</h3>
      <dl class="statstrip">${p.stats.map(([v, k]) => `
        <div><dt class="statstrip__v mono">${v}</dt><dd class="statstrip__k">${k}</dd></div>`).join('')}
      </dl>
    </a>`).join('');

  const paintAccount = () => {
    const panel = $('#levelTrack', view);
    if (!panel) return;
    /* Cash economy: there are no inventory lots to count. What a player actually has committed is
     * whatever the Piggy Bank is holding under lock, so that is the second figure. */
    const lockedMinor = () => (state.piggyDeposits ?? [])
      .filter((deposit) => deposit.state === 'open')
      .reduce((sum, deposit) => sum + (deposit.principal || 0), 0);
    panel.innerHTML = state.authenticated ? `
      <div class="track__lead">
        <span class="track__lv mono">${escapeText(state.user?.minecraftUsername || 'PLAYER')}</span>
        <span class="track__bar"><i style="--fill:1"></i></span>
        <span class="track__pc mono">LIVE</span>
      </div>
      <div class="track__rows">
        <div class="track__r"><span class="track__k">Server balance</span><span class="track__v mono">${money(state.balance)}</span></div>
        <div class="track__r"><span class="track__k">Piggy Bank locked</span><span class="track__v mono">${money(lockedMinor())}</span></div>
        <div class="track__r"><span class="track__k">Account status</span><span class="track__v mono">${escapeText(state.user?.status || 'unknown')}</span></div>
      </div>` : `
      <div class="track__lead"><span class="track__lv mono">ACCOUNT</span><span>Link your Minecraft identity to load your balance.</span></div>`;
  };

  /* The game grid that used to be built here is gone, and so is its markup. It rendered the same
   * four products the promo row above it already renders, which made the homepage read as padded.
   * See the comment where the grid stood in index.html. */


  /* Big Drops.
   *
   * Built as DOM nodes, not as an interpolated HTML string. The previous version wrote
   * `src="${item.img}"` straight into innerHTML with no escaping on the URL: a catalogue image
   * path containing a double quote would have closed the attribute and let the rest of the value
   * become markup — the `<img onerror>` vector, reached through a field nobody thinks of as user
   * input. Assigning img.src as a property cannot break out of an attribute, and every visible
   * string goes in through textContent.
   *
   * The marquee this also fed is gone. It was a moving strip directly under the navigation that
   * duplicated the live feed at the foot of the page, and a scroller is unreadable the moment you
   * want to actually read a line of it. */
  const paintActivity = () => {
    const drops = $('#bigDrops', view);
    if (!drops) return;
    drops.innerHTML = '';

    /* Faction contributions carry no item, so they are not drops and do not belong in a drop
     * list. They appear in the live feed as their own kind of row. */
    const rounds = state.activities.filter((entry) => entry.item && entry.kind !== 'faction');

    if (!rounds.length) {
      const empty = el('li', 'drops__empty');
      empty.textContent = 'No completed drops yet.';
      drops.appendChild(empty);
      return;
    }

    for (const entry of rounds.slice(0, 7)) {
      const { item, player, sourceName } = entry;
      const row = el('li');
      /* The rarity drives a border and a glow, not just a swatch: a Netherite pull and a Spawner
       * pull should be distinguishable from across the room, which is the whole reason the list
       * exists. rarityFor() can return a tier this table does not carry; fall back rather than
       * throw. */
      row.style.setProperty('--rar', RARITY[item.rarity]?.color ?? '#ffaa00');
      row.dataset.rarity = item.rarity ?? 'common';

      const art = document.createElement('img');
      art.src = safeImage(item.img);
      art.alt = '';
      art.loading = 'lazy';

      const stack = el('span', 'drops__stack');
      const what = el('span', 'what');
      what.textContent = item.name;
      const who = el('span', 'who');
      who.textContent = sourceName ? `${player ?? '???'} · ${sourceName}` : (player ?? '???');
      stack.append(what, who);

      /* The PAYOUT, not the catalogue price. What the round actually paid is the number somebody
       * scanning this list is looking for; the sticker price of the item is a different figure and
       * on a losing round it is not the one that changed hands. */
      const paid = Number(entry.payoutMinor ?? entry.payout_minor ?? 0) || item.value;
      const amount = el('span', 'amt mono');
      amount.textContent = money(paid);

      row.append(art, stack, amount);
      drops.appendChild(row);
    }
  };

  paintAccount();
  paintActivity();
  bus.addEventListener('change', () => {
    if (!view.isConnected) return;
    paintAccount();
    paintActivity();
  });
  /* The two pills that carry a live value. They are filled from the CURRENT commitment, so the
   * card is showing the seed the next roll will actually be settled against rather than a stock
   * string that looks like one. */
  const paintFairPills = () => {
    const hash = state.fairness?.serverSeedHash ?? state.fairness?.server_seed_hash ?? '';
    const nonce = state.fairness?.nonce;
    const hashPill = $('#fairHashPill', view);
    const noncePill = $('#fairNoncePill', view);
    if (hashPill) {
      hashPill.textContent = hash ? `${String(hash).slice(0, 18)}…` : 'log in to see yours';
    }
    if (noncePill) {
      noncePill.textContent =
        nonce === undefined || nonce === null ? 'log in to see yours' : `nonce ${nonce}`;
    }
  };
  paintFairPills();
  bus.addEventListener('change', () => {
    if (view.isConnected) paintFairPills();
  });

  $('#fairBtn', view).addEventListener('click', () => showFairness());
}

function showFairness() {
  if (!state.fairness) {
    toast({ kind: 'lose', title: 'No fairness commitment', body: 'Log in to request the active server commitment.' });
    return;
  }
  fairSheet({
    server: state.fairness.serverSeedHash,
    client: 'generated securely for each request',
    nonce: state.fairness.nonce,
    algorithm: state.fairness.algorithm,
  });
}

function openLoginModal() {
  if (state.authenticated) {
    toast({ kind: 'win', title: 'Already linked', body: state.user.minecraftUsername });
    return;
  }
  openModal('Sign in with /pay', (body) => {
    body.innerHTML = `<p>Enter your public Minecraft username. You prove the account is yours by paying the bot an exact amount in game. The payment is credited to your balance.</p>
      <form id="linkForm"><div class="modal__label">Minecraft username</div>
      <div class="modal__row"><input id="linkUsername" minlength="3" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" required autocomplete="username">
      <button class="btn btn--go" type="submit">Get my amount</button></div></form>
      <div id="linkProgress" role="status"></div>`;
    $('#linkForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = $('#linkUsername', body).value.trim();
      const submit = $('#linkForm button', body);
      submit.disabled = true;
      try {
        const challenge = await startLogin(username);
        $('#linkProgress', body).innerHTML = `<p>Run this exact command in game:</p>
          <p class="mono" style="font-size:1.25rem;font-weight:700">${escapeText(challenge.instruction)}</p>
          <p class="card__p">Pay exactly $${escapeText(String(challenge.payAmount))} \u2014 the amount is what identifies you, so a different amount will not sign you in.</p>
          <div class="kv"><span>status</span><span id="linkState">waiting for your payment</span></div>
          <div id="linkFinish" hidden><div class="modal__label">Admin TOTP (admins only)</div>
          <div class="modal__row"><input id="linkTotp" inputmode="numeric" maxlength="8" placeholder="optional">
          <button class="btn btn--go" id="linkComplete">Finish login</button></div></div>`;
        pollLink(challenge.challengeId, body);
      } catch (error) {
        showApiError(error);
        submit.disabled = false;
      }
    });
  });
}

async function openDepositModal() {
  if (!state.authenticated) {
    openLoginModal();
    return;
  }
  openModal('Create item deposit', (body) => {
    body.innerHTML = '<p>Requesting a custody bot and one-time signed-chat instruction…</p>';
  });
  try {
    const result = await createDeposit();
    const body = $('#modalBody');
    body.innerHTML = `<p>${escapeText(result.instruction)}</p>
      <div class="kv"><span>status</span><span>${escapeText(result.deposit.status)}</span></div>
      <div class="kv"><span>expires</span><span>${escapeText(result.deposit.expires_at)}</span></div>
      <p class="card__p">${escapeText(result.warning)}</p>`;
  } catch (error) {
    closeModal();
    showApiError(error);
  }
}

const PAY_STATE_TEXT = {
  waiting: 'waiting for your payment',
  verifying: 'payment seen, confirming it arrived',
  confirmed: 'payment confirmed',
  completed: 'already used',
  expired: 'expired, start again',
};

async function pollLink(challengeId, body) {
  if (!body.isConnected || !$('#modal').open) return;
  try {
    const result = await loginStatus(challengeId);
    const state = result.state || result.status;
    const status = $('#linkState', body);
    if (status) status.textContent = PAY_STATE_TEXT[state] || state;
    if (state === 'confirmed') {
      const finish = $('#linkFinish', body);
      finish.hidden = false;
      $('#linkComplete', body).addEventListener('click', async () => {
        const button = $('#linkComplete', body);
        button.disabled = true;
        try {
          const user = await completeLogin(challengeId, $('#linkTotp', body).value.trim());
          closeModal();
          toast({ kind: 'win', title: 'Account linked', body: user.minecraftUsername });
        } catch (error) {
          showApiError(error);
          button.disabled = false;
        }
      }, { once: true });
      return;
    }
    if (['expired', 'locked', 'completed'].includes(state)) return;
  } catch (error) {
    showApiError(error);
    return;
  }
  setTimeout(() => pollLink(challengeId, body), 2000);
}

function showApiError(error) {
  const message = error?.message || 'The server rejected the request.';
  toast({ kind: 'lose', title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Request failed', body: message });
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/* ═════════ router ═════════ */
const VIEWS = {
  home: mountHome,
  crates: mountCrates,
  battles: mountBattles,
  'skill-duel': mountDuel,
  slither: mountSlither,
  referrals: mountReferrals,
  studio: mountStudio,
  upgrader: mountUpgrader,
  piggy: mountPiggy,
  quests: mountQuests,
  war: mountWar,
  fairness: mountFair,
  vip: mountVip,
  rakeback: mountRakeback,
  'daily-rewards': mountDaily,
  discord: mountDiscord,
  race: mountRace,
  'creator-media': mountCreators,
  leaderboard: mountLeaderboard,
  statistics: mountStatistics,
  profile: mountProfile,
  wallet: mountWallet,
  history: mountHistory,
  settings: mountSettings,
  support: mountSupport,
  terms: mountTerms,
};

const isActive = (name) => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home') === name;

/* ═════════ the Cases disclosure ═════════
 *
 * Opens on click, closes on a click anywhere else, on Escape, and on choosing a row. Marked
 * aria-expanded so a screen reader is told it is a disclosure rather than a link that did
 * nothing, and the parent never navigates on its own — it owns three routes and picking between
 * them IS the decision.
 *
 * ── why the menu is moved to <body> ──
 * The nav bar scrolls sideways on a phone, so `.tabs` carries `overflow-x: auto`. That is not a
 * cosmetic detail: an overflow value other than `visible` makes the element CLIP its absolutely
 * positioned descendants, and `overflow-x: auto` forces `overflow-y` to compute to `auto` as
 * well. The menu therefore opened correctly — `hidden` went false, aria-expanded went true — and
 * was clipped to the 37px-tall nav strip, with 183px of it cut off and unclickable.
 *
 * It was invisible to the user and invisible to a test that asserted `hidden === false`, which
 * is exactly what the first version of this checked.
 *
 * So the menu is portalled: moved to the end of <body> once, and positioned with `position: fixed`
 * from the button's own rect. document.body has no transformed or filtered ancestor, so fixed
 * resolves against the viewport and no overflow box anywhere can clip it. The header itself
 * carries `backdrop-filter`, which WOULD have become the containing block had the menu stayed
 * inside it — another reason to hang it off the body rather than the bar.
 */
function initCasesMenu() {
  const wrap = $('#casesDrop');
  const button = $('#casesBtn');
  const menu = $('#casesMenu');
  if (!wrap || !button || !menu) return;

  // Out of the clipping context, once, at boot.
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.dataset.portal = '1';

  /**
   * Anchors the menu to the button and keeps it on screen. Recomputed on every open, and again
   * whenever anything moves while it is open.
   *
   * It FLIPS rather than only clamping. Below 900px the nav is not a top bar at all — it becomes
   * a fixed bottom tab bar — so the button sits a few pixels from the bottom edge and a menu
   * placed underneath it renders entirely off screen. Opening downward is the preference, not the
   * rule: whichever side has room wins, and the result is clamped into the viewport either way.
   */
  const place = () => {
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 190;

    const below = rect.bottom + gap;
    const above = rect.top - height - gap;
    const fitsBelow = below + height <= window.innerHeight - gap;
    const top = fitsBelow ? below : Math.max(gap, above);

    const left = Math.min(Math.max(gap, rect.left), window.innerWidth - width - gap);
    menu.style.top = `${Math.round(Math.min(top, window.innerHeight - height - gap))}px`;
    menu.style.left = `${Math.round(Math.max(gap, left))}px`;
    menu.dataset.flipped = fitsBelow ? '0' : '1';
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    /* Capture phase, so the menu follows the button when any scrolling ancestor moves — including
     * the nav bar itself scrolling sideways on a phone. */
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) close();
  });
  document.addEventListener('click', (event) => {
    // The menu no longer lives inside `wrap`, so both have to be consulted.
    if (!wrap.contains(event.target) && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      close();
      button.focus();
    }
  });

  /* The "not live yet" handler that used to sit here is gone with the placeholder it explained.
   * 1v1 Skill is a real route now, so the nav entry is an ordinary link and needs no interception
   * to tell the player it does not go anywhere. */
}

function route() {
  const seg = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  const name = VIEWS[seg] ? seg : 'home';

  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  const CASES_ROUTES = ['crates', 'battles', 'studio'];
  const casesBtn = $('#casesBtn');
  if (casesBtn) {
    // The parent reads as current whenever any route it owns is the live one.
    casesBtn.dataset.on = CASES_ROUTES.includes(name) ? '1' : '0';
  }

  $$('.tabs a').forEach((a) => {
    const on = a.dataset.route === name;
    a.setAttribute('aria-current', on ? 'page' : 'false');
    // the bar scrolls on phones, so keep the live tab in view
    if (on) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  });

  const mount = VIEWS[name];
  if (typeof mount !== 'function') {
    location.hash = '#/home';
    return;
  }
  mount($(`.view[data-view="${name}"]`));

  document.body.classList.remove('chat-open');
  $('#burger').setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0 });
}

/* ═════════ boot ═════════ */
initModal();
initCasesMenu();
initWallet();
/* The level pill. Owns its own bus subscription, so it repaints on every snapshot without the
 * router having to remember it. */
initVipWidget();
initChat();
initVaultJackpot(document.getElementById('vaultJackpot'));
initAudioEngine();
initTicker(document.getElementById('tickerRoot'));

/* The mute control drives the synthesised engine. The old sample player is gone with the asset
 * files it used to load. */
{
  const muteButton = $('#muteBtn');
  if (muteButton) {
    const paintMute = () => {
      const off = isMuted();
      muteButton.dataset.muted = off ? '1' : '0';
      muteButton.setAttribute('aria-pressed', String(off));
      muteButton.setAttribute('aria-label', off ? 'Unmute sound' : 'Mute sound');
    };
    muteButton.addEventListener('click', () => { setMuted(!isMuted()); paintMute(); });
    paintMute();
  }
}

$('#loginBtn').addEventListener('click', openLoginModal);
$('#depositBtn').addEventListener('click', openDepositModal);
$('#withdrawBtn').addEventListener('click', openWithdrawDesk);
$('#signOutBtn')?.addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    await logout();
    location.hash = '#/home';
    toast({ kind: 'win', title: 'Signed out' });
  } catch (error) {
    showApiError(error);
  }
});

const paintAuthChrome = () => {
  const label = $('#loginBtn span');
  if (label) label.textContent = state.authenticated ? state.user.minecraftUsername : 'Log in';
  $('#loginBtn').dataset.authenticated = state.authenticated ? '1' : '0';
};
bus.addEventListener('change', paintAuthChrome);
paintAuthChrome();

/* Read the invite code off the URL before anything navigates, because the router rewrites the
 * hash and the login round trip replaces it outright. It is only spent once there is a session to
 * attach it to. */
captureReferralCode();
bootstrap().catch(showApiError);
setInterval(() => {
  if (!document.hidden) refreshActivity().catch(() => undefined);
}, 15_000);

/* the animation test bench — hidden until Ctrl+Alt+D or ?dev=1 */
initDevMenu(document.getElementById('devRoot'));
$('#burger').addEventListener('click', () => {
  const open = document.body.classList.toggle('chat-open');
  $('#burger').setAttribute('aria-expanded', String(open));
});

/* ═════════ account menu ═════════ */
{
  const btn = $('#acctBtn');
  const menu = $('#acctMenu');
  if (btn && menu) {
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    // click-away and Escape both close it; a menu you cannot dismiss is a trap
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });

    const paintInvites = () => {
      const n = $('#menuInvites');
      if (!n) return;
      // Off the referral ledger, not off the retired client-side counter that used to sit here.
      n.textContent = money(Number(state.referrals?.totals?.earnedMinor ?? 0));
    };
    paintInvites();
    bus.addEventListener('change', paintInvites);
  }
}

window.addEventListener('hashchange', route);
route();
