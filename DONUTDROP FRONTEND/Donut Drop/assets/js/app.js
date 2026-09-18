/* app.js — entry point: shell wiring, hash router, home + crates + inventory. */
import {
  RARITY, IMG,
} from './data.js';
import {
  state, bus, bootstrap, canAfford, openCase as requestCaseOpen,
  startLogin, loginStatus, completeLogin, logout,
  cashDepositInfo, refreshActivity, refreshBalance, pollDeposits,
  cashWithdrawalInfo, requestCashWithdrawal, cashWithdrawalStatus, turnstileConfig,
} from './store.js';
import {
  $, $$, el, money, itemTile, reduceMotion, safeImage, parseAmount,
} from './util.js';
import {
  toast, initModal, initWallet, broadcast,
  openModal, closeModal,
} from './ui.js';
import { mountUpgrader } from './upgrader.js';
import { mountPiggy } from './piggy.js';
import { mountCrates } from './crates.js';
import { mountBattles } from './battles.js';
import { mountDuel } from './duel.js';
import { mountSlither } from './slither.js';
import { mountReferrals, captureReferralCode, setPendingReferralCode } from './referrals.js';
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
import { initAudioEngine, setMuted, isMuted, playSound } from './audio-engine.js';
import { mountHero3d } from './hero3d.js';
import { playCutscene, warmCutscene, isJackpot } from './cutscene.js';
import { playReel, warmReel } from './reel.js';
import { initDevMenu } from './devmenu.js';

/** The biggest multiplier the server will quote, as a player would say it. */
function topMultiplierLabel() {
  const bps = Number(state.upgradeConfig?.maxMultiplierBps ?? 0);
  return Number.isFinite(bps) && bps > 10_000 ? `${Math.floor(bps / 10_000)}×` : '—';
}

/** The upgrader's published stake ceiling, or an em dash before the server has said. */
function maxStakeLabel() {
  const published = Number(state.upgradeConfig?.maxStakeMinor ?? 0);
  return Number.isFinite(published) && published > 0 ? money(published) : '—';
}

/** A countable thing's size, or an em dash while it is still unknown. */
function count(collection) {
  const size = Array.isArray(collection)
    ? collection.length
    : collection && typeof collection === 'object'
      ? Object.keys(collection).length
      : 0;
  return size > 0 ? String(size) : '—';
}

/* ═════════ home ═════════ */
function mountHome(view) {
  if (view.dataset.built) return;
  view.dataset.built = '1';

  // the hero runs as a live scene; the static art underneath is the fallback
  // and only stands down once WebGL is actually running
  const art = $('.hero__art', view);
  if (art) mountHero3d(art).catch(() => { delete art.dataset.mode; });

  /* Four routes, two figures each.
   *
   * The strip stays, because a player scanning a lobby is comparing games and a sentence is the
   * slowest way to answer "how much, how long". What changed is what the figures say. Half of them
   * described the machinery rather than the game — SERVER ROLL, LIVE QUOTE, PUBLISHED ODDS — which
   * answers a question nobody standing in a lobby is asking, in words they would have to look up.
   *
   * Two cells rather than three is also what stops them clipping: the cells divide the card width
   * evenly and ellipsise the overflow, so PUBLISHED ODDS rendered as "PUBLI…".
   *
   * Every figure is read from something that knows the answer rather than typed here. The crate
   * count was hard-coded as 50 and nothing on the page had ever checked; it now counts the
   * catalogue the server actually sent, and reads "—" until that arrives instead of asserting a
   * number before it could possibly be known. */
  const promos = () => [
    { ac: '#ffaa00', h: 'Crates',      art: 'chest.png',       href: '#/crates',
      stats: [[count(state.cases), 'CRATES'], [count(RARITY), 'RARITIES']] },
    { ac: '#ffd700', h: 'Upgrader',    art: 'ender_chest.png', href: '#/upgrader',
      stats: [[maxStakeLabel(), 'MAX STAKE'], [topMultiplierLabel(), 'TOP PAYOUT']] },
    { ac: '#ffd700', h: 'Piggy Bank',  art: 'gold_block.png',  href: '#/piggy',
      stats: [['FIXED', 'RETURN'], ['NO', 'RISK']] },
    { ac: '#ffaa00', h: 'Faction War', art: 'nether_star.png', href: '#/war',
      stats: [[count(state.war?.factions), 'SIDES'], ['ONE', 'PRIZE POT']] },
  ];

  const paintPromos = () => {
    const row = $('#promos', view);
    if (!row) return;
    row.innerHTML = promos().map((p) => `
    <a class="promo" href="${p.href}" style="--ac:${p.ac}">
      <img class="promo__art" src="${IMG}${p.art}" alt="">
      <h3>${p.h}</h3>
      <dl class="statstrip">${p.stats.map(([v, k]) => `
        <div><dt class="statstrip__v mono">${escapeText(v)}</dt><dd class="statstrip__k">${k}</dd></div>`).join('')}
      </dl>
    </a>`).join('');
  };
  paintPromos();

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
    paintPromos();
    paintAccount();
    paintActivity();
  });
}


/* The two shapes a name can take on the way in.
 *
 * Java is the plain 3–16 rule. Bedrock players reach DonutSMP through its Floodgate bridge, which
 * prepends a dot and truncates the result to Minecraft's 16-character ceiling — so the part the
 * player types is capped at 15, and the dot is added by the checkbox rather than by them. */
const JAVA_NAME = /^[A-Za-z0-9_]{3,16}$/;
const BEDROCK_NAME = /^[A-Za-z0-9_]{2,15}$/;
const REFERRAL_CODE = /^[A-Z0-9]{6,16}$/;

const PERSON_ICON =
  '<svg class="auth__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

/**
 * Loads Cloudflare's Turnstile script, once per page.
 *
 * Deliberately not in index.html: a deployment with no challenge configured should not fetch a
 * third-party script on every page load to then not use it. The promise is cached so reopening the
 * sign-in card does not add another tag, and cleared on failure so a transient network error does
 * not permanently poison it.
 */
let turnstileScript;
function loadTurnstile() {
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      tag.async = true;
      tag.onload = () => resolve(window.turnstile);
      tag.onerror = () => {
        turnstileScript = undefined;
        reject(new Error('Turnstile could not be loaded'));
      };
      document.head.appendChild(tag);
    });
  }
  return turnstileScript;
}

function openLoginModal() {
  if (state.authenticated) {
    toast({ kind: 'win', title: 'Already linked', body: state.user.minecraftUsername });
    return;
  }
  openModal('Sign In or Sign Up', (body) => {
    body.innerHTML = `<h3 class="auth__title" aria-hidden="true">Sign In or Sign Up</h3>
      <p class="auth__lede">Log in with your Minecraft username, then verify your account by
        paying the bot an exact amount in game. The payment lands in your balance.</p>
      <hr class="auth__rule">
      <form id="linkForm" novalidate>
        <label class="auth__label" for="linkUsername">Minecraft username</label>
        <div class="auth__field" id="linkField">
          ${PERSON_ICON}
          <span class="auth__prefix" id="linkPrefix" hidden>.</span>
          <input id="linkUsername" class="auth__input" type="text" maxlength="16" required
                 autocomplete="username" autocapitalize="none" spellcheck="false"
                 placeholder="Enter your minecraft username…">
        </div>
        <p class="auth__err" id="linkError" role="alert" hidden></p>

        <div class="auth__checks">
          <label class="auth__check">
            <input type="checkbox" id="linkTerms">
            <span class="auth__box" aria-hidden="true"></span>
            <span class="auth__txt">I agree to all <a href="#/terms">Terms &amp; Conditions</a>.</span>
          </label>
          <label class="auth__check">
            <input type="checkbox" id="linkBedrock">
            <span class="auth__box" aria-hidden="true"></span>
            <span class="auth__txt">I play Bedrock Edition (adds a <span class="mono">.</span> before your name)</span>
          </label>
        </div>

        <details class="auth__ref">
          <summary>Have a referral code?</summary>
          <div class="auth__refbody">
            <div class="auth__field">
              <input id="linkRef" class="auth__input" type="text" maxlength="16"
                     autocapitalize="characters" spellcheck="false" placeholder="e.g. DONUT2026">
            </div>
            <p class="auth__note">Six to sixteen letters and numbers. It is applied for you once
              the account is linked.</p>
          </div>
        </details>

        <div class="auth__challenge" id="linkChallenge" hidden></div>
        <button class="btn btn--go auth__go" type="submit" id="linkGo" disabled>Continue</button>
      </form>
      <div id="linkProgress" role="status"></div>`;

    const form = $('#linkForm', body);
    const field = $('#linkField', body);
    const input = $('#linkUsername', body);
    const prefix = $('#linkPrefix', body);
    const terms = $('#linkTerms', body);
    const bedrock = $('#linkBedrock', body);
    const referral = $('#linkRef', body);
    const go = $('#linkGo', body);
    const slot = $('#linkChallenge', body);
    const inlineError = $('#linkError', body);

    const typedName = () => input.value.trim();
    const referralCode = () => referral.value.trim().toUpperCase();
    const nameValid = () =>
      bedrock.checked ? BEDROCK_NAME.test(typedName()) : JAVA_NAME.test(typedName());
    const referralValid = () => referralCode() === '' || REFERRAL_CODE.test(referralCode());

    const setError = (message) => {
      inlineError.textContent = message;
      inlineError.hidden = !message;
      field.classList.toggle('is-error', Boolean(message));
    };

    /* Continue stays disabled until the form could actually succeed. A button that is enabled and
     * then rejects the click is a worse answer than one that says up front it is not ready. */
    /* Whether this deployment challenges sign-ins, and the answer if it does. Both start empty and
     * are filled in below once the server has been asked; the form stays usable either way. */
    let challengeRequired = false;
    let challengeToken = '';
    let challengeWidget;

    const sync = () => {
      prefix.hidden = !bedrock.checked;
      input.maxLength = bedrock.checked ? 15 : 16;
      go.disabled = !(
        nameValid() &&
        terms.checked &&
        referralValid() &&
        (!challengeRequired || challengeToken)
      );
    };

    /* Asked for after the card is already on screen. Blocking the modal on a third-party script
     * would make a Cloudflare hiccup look like a broken sign-in button. */
    void (async () => {
      let settings;
      try {
        settings = await turnstileConfig();
      } catch {
        return; // The server decides; if it cannot be asked, submitting will say so.
      }
      if (!settings?.enabled || !settings.siteKey || !slot.isConnected) return;
      challengeRequired = true;
      sync();
      try {
        const turnstile = await loadTurnstile();
        slot.hidden = false;
        challengeWidget = turnstile.render(slot, {
          sitekey: settings.siteKey,
          theme: 'dark',
          callback: (token) => {
            challengeToken = token;
            setError('');
            sync();
          },
          // A token is single-use and expires. Dropping it is what stops a stale one being sent.
          'expired-callback': () => {
            challengeToken = '';
            sync();
          },
          'error-callback': () => {
            challengeToken = '';
            sync();
          },
        });
      } catch {
        slot.hidden = false;
        slot.textContent = 'The sign-in challenge could not load. Disable your blocker and reopen.';
      }
    })();

    input.addEventListener('input', () => {
      // Somebody who knows the convention will type the dot themselves. Take that as the answer to
      // the question the checkbox asks, rather than failing them on it.
      if (input.value.startsWith('.')) {
        input.value = input.value.slice(1);
        bedrock.checked = true;
      }
      setError('');
      sync();
    });
    input.addEventListener('blur', () => {
      if (!typedName() || nameValid()) {
        setError('');
        return;
      }
      setError(
        bedrock.checked
          ? 'After the dot, Bedrock names are 2–15 letters, numbers or underscores.'
          : 'Minecraft names are 3–16 letters, numbers or underscores.',
      );
    });
    bedrock.addEventListener('change', () => {
      if (bedrock.checked) input.value = input.value.slice(0, 15);
      setError('');
      sync();
    });
    terms.addEventListener('change', sync);
    referral.addEventListener('input', sync);
    sync();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (go.disabled) return;
      const username = (bedrock.checked ? '.' : '') + typedName();
      const code = referralCode();
      go.disabled = true;
      go.dataset.state = 'loading';
      go.textContent = 'Checking…';
      try {
        const challenge = await startLogin(username, challengeToken);
        // Held, not sent: attaching a referrer needs a session, and there is none until the
        // payment lands. The referral panel spends it on the first mount after login.
        if (code) setPendingReferralCode(code);
        go.dataset.state = 'success';
        form.hidden = true;
        $('#linkProgress', body).innerHTML = `<p>Run this exact command in game:</p>
          <p class="mono" style="font-size:1.25rem;font-weight:700">${escapeText(challenge.instruction)}</p>
          <p class="card__p">Pay exactly $${escapeText(String(challenge.payAmount))} — the amount is what identifies you, so a different amount will not sign you in.</p>
          <div class="kv"><span>status</span><span id="linkState">waiting for your payment</span></div>
          <div id="linkFinish" hidden>
            <button class="btn btn--go" type="button" id="linkComplete">Finish login</button>
            <p class="card__p" id="linkCompleteError" role="alert" hidden></p>
          </div>`;
        pollLink(challenge.challengeId, body);
      } catch (error) {
        go.dataset.state = '';
        go.textContent = 'Continue';
        /* The token was spent on the attempt that failed, so a retry needs a new one. Resetting
         * the widget is what asks for it; without this the second attempt sends a used token and
         * fails for a reason that has nothing to do with the first. */
        challengeToken = '';
        if (challengeWidget !== undefined) {
          try {
            window.turnstile?.reset(challengeWidget);
          } catch {
            /* A widget that will not reset still leaves the button correctly disabled. */
          }
        }
        go.disabled = false;
        sync();
        setError(error?.message || 'Could not start the login.');
      }
    });

    input.focus();
  }, { variant: 'auth' });
}

const CASH_STATE_TEXT = {
  pending_approval: 'waiting for an operator to approve it',
  queued: 'queued for the bot',
  processing: 'the bot is paying you now',
  paid: 'paid in game',
  rejected: 'rejected, your balance was returned',
  failed: 'could not be sent, your balance was returned',
  manual_review: 'held for review — contact support, do not retry',
};

async function openDepositModal() {
  if (!state.authenticated) {
    openLoginModal();
    return;
  }
  let host;
  openModal('Deposit', (body) => {
    host = body;
    body.innerHTML = '<p class="auth__lede">Finding the payment bot…</p>';
  }, { variant: 'auth' });

  let info;
  try {
    info = await cashDepositInfo();
  } catch (error) {
    closeModal();
    showApiError(error);
    return;
  }
  if (!host?.isConnected || !$('#modal').open) return;

  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Deposit</h3>
    <p class="auth__lede">Pay the bot from your linked Minecraft account. It is credited
      automatically when the bot sees the payment in chat — there is nothing to confirm here.</p>
    <hr class="auth__rule">
    <span class="auth__label">Bot IGN</span>
    <div class="auth__field auth__field--static">
      <span class="auth__value mono">${escapeText(info.botUsername)}</span>
    </div>
    <span class="auth__label">Run this in game</span>
    <div class="auth__field auth__field--static">
      <span class="auth__value auth__value--lg mono">${escapeText(info.command)}</span>
    </div>
    <p class="auth__note">Round amounts only &mdash; 1M, 250M, 1B. DonutSMP shortens large figures
      in chat, so a payment of 1,234,567,890 arrives as &ldquo;1.2B&rdquo; and is credited as
      1,200,000,000. The bot can only credit what the receipt shows.</p>
    <button class="btn btn--go auth__go" type="button" id="depositCopy">Copy command</button>`;

  $('#depositCopy', host).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(info.example || info.command);
      button.textContent = 'Copied';
      button.dataset.state = 'success';
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The command is on screen.
      button.textContent = 'Select it above';
    }
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = 'Copy command';
      button.dataset.state = '';
    }, 1800);
  });
}

/**
 * Cash out: the bot pays the player with DonutSMP's own /pay.
 *
 * Two steps on purpose. The money leaves the platform and cannot be pulled back from in here, so
 * the amount is typed on one screen and confirmed against the exact figure and payee on the next.
 * A single click that both sets and sends an amount is how people send 10M instead of 1M.
 */
async function openWithdrawModal() {
  if (!state.authenticated) {
    openLoginModal();
    return;
  }
  let host;
  openModal('Withdraw', (body) => {
    host = body;
    body.innerHTML = '<p class="auth__lede">Checking your account…</p>';
  }, { variant: 'auth' });

  let info;
  try {
    info = await cashWithdrawalInfo();
  } catch (error) {
    closeModal();
    showApiError(error);
    return;
  }
  if (!host?.isConnected || !$('#modal').open) return;

  if (info.pending) {
    paintWithdrawStatus(host, info.pending);
    pollWithdrawal(info.pending.id, host);
    return;
  }

  const minimum = Number(info.minimumMinor);
  const threshold = Number(info.approvalThresholdMinor);

  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Withdraw</h3>
    <p class="auth__lede">The bot pays you in game with <span class="mono">/pay</span>. Your site
      balance is taken now and sent to your linked account.</p>
    <hr class="auth__rule">
    <form id="wdForm" novalidate>
      <label class="auth__label" for="wdAmount">Amount</label>
      <div class="auth__field" id="wdField">
        <span class="auth__prefix">$</span>
        <input id="wdAmount" class="auth__input" type="text" inputmode="decimal"
               autocomplete="off" spellcheck="false" placeholder="1m">
        <button class="auth__max" type="button" id="wdMax">Max</button>
      </div>
      <p class="auth__err" id="wdError" role="alert" hidden></p>
      <p class="auth__note" id="wdHint">Balance ${escapeText(money(state.balance))} ·
        minimum ${escapeText(money(minimum))}. Over ${escapeText(money(threshold))} an operator
        approves it first.</p>

      <span class="auth__label">Paying</span>
      <div class="auth__field auth__field--static">
        <span class="auth__value mono">${escapeText(info.payeeUsername || state.user?.minecraftUsername || '—')}</span>
      </div>

      <button class="btn btn--go auth__go" type="submit" id="wdGo" disabled>Continue</button>
    </form>`;

  const form = $('#wdForm', host);
  const field = $('#wdField', host);
  const input = $('#wdAmount', host);
  const go = $('#wdGo', host);
  const inlineError = $('#wdError', host);

  const amountOf = () => parseAmount(input.value);
  const setError = (message) => {
    inlineError.textContent = message;
    inlineError.hidden = !message;
    field.classList.toggle('is-error', Boolean(message));
  };
  const sync = () => {
    const amount = amountOf();
    go.disabled = !(amount !== null && amount >= minimum && amount <= state.balance);
  };

  input.addEventListener('input', () => {
    setError('');
    sync();
  });
  input.addEventListener('blur', () => {
    const amount = amountOf();
    if (input.value.trim() === '') return setError('');
    if (amount === null) return setError('Enter an amount, for example 1m or 500k.');
    if (amount < minimum) return setError(`The smallest withdrawal is ${money(minimum)}.`);
    if (amount > state.balance) return setError(`That is more than your ${money(state.balance)} balance.`);
    setError('');
  });
  $('#wdMax', host).addEventListener('click', () => {
    input.value = String(state.balance);
    setError('');
    sync();
    input.focus();
  });
  sync();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (go.disabled) return;
    confirmWithdraw(host, amountOf(), info, threshold);
  });
  input.focus();
}

/** Step two: the exact figure and the exact name, with nothing else competing for attention. */
function confirmWithdraw(host, amount, info, threshold) {
  const payee = info.payeeUsername || state.user?.minecraftUsername || '—';
  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Confirm</h3>
    <p class="auth__lede">This cannot be undone from the site once the bot has sent it.</p>
    <hr class="auth__rule">
    <div class="auth__confirm">
      <div class="auth__crow"><span>Sending</span><b class="mono">${escapeText(money(amount))}</b></div>
      <div class="auth__crow"><span>To</span><b class="mono">${escapeText(payee)}</b></div>
      <div class="auth__crow"><span>Balance after</span><b class="mono">${escapeText(money(state.balance - amount))}</b></div>
    </div>
    ${amount > threshold
      ? `<p class="auth__note">Over ${escapeText(money(threshold))}, so an operator approves it
         before the bot sends anything. Your balance is held until then.</p>`
      : ''}
    <p class="auth__err" id="wdcError" role="alert" hidden></p>
    <button class="btn btn--go auth__go" type="button" id="wdcSend">Send ${escapeText(money(amount))}</button>
    <button class="btn auth__back" type="button" id="wdcBack">Back</button>`;

  $('#wdcBack', host).addEventListener('click', () => openWithdrawModal());
  $('#wdcSend', host).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const error = $('#wdcError', host);
    button.disabled = true;
    button.dataset.state = 'loading';
    button.textContent = 'Sending…';
    try {
      const result = await requestCashWithdrawal(String(amount));
      await refreshBalance();
      paintWithdrawStatus(host, result.withdrawal);
      pollWithdrawal(result.withdrawal.id, host);
    } catch (failure) {
      button.dataset.state = '';
      button.textContent = `Send ${money(amount)}`;
      button.disabled = false;
      error.textContent = failure?.message || 'The server refused the withdrawal.';
      error.hidden = false;
    }
  });
}

function paintWithdrawStatus(host, withdrawal) {
  const done = ['paid', 'rejected', 'failed', 'manual_review'].includes(withdrawal.status);
  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Withdrawal</h3>
    <p class="auth__lede">${withdrawal.status === 'paid'
      ? 'Sent. Check your in-game balance.'
      : 'You can close this — it carries on without the page open.'}</p>
    <hr class="auth__rule">
    <div class="auth__confirm">
      <div class="auth__crow"><span>Amount</span><b class="mono">${escapeText(money(Number(withdrawal.amountMinor)))}</b></div>
      <div class="auth__crow"><span>To</span><b class="mono">${escapeText(withdrawal.payeeUsername)}</b></div>
      <div class="auth__crow"><span>Status</span><b id="wdState">${escapeText(CASH_STATE_TEXT[withdrawal.status] || withdrawal.status)}</b></div>
    </div>
    ${done ? '<button class="btn btn--go auth__go" type="button" id="wdDone">Close</button>' : ''}`;
  const close = $('#wdDone', host);
  if (close) close.addEventListener('click', () => closeModal());
}

async function pollWithdrawal(id, host) {
  if (!host.isConnected || !$('#modal').open) return;
  let withdrawal;
  try {
    withdrawal = (await cashWithdrawalStatus(id)).withdrawal;
  } catch {
    setTimeout(() => pollWithdrawal(id, host), 4000);
    return;
  }
  const label = $('#wdState', host);
  if (label) label.textContent = CASH_STATE_TEXT[withdrawal.status] || withdrawal.status;
  if (['paid', 'rejected', 'failed', 'manual_review'].includes(withdrawal.status)) {
    paintWithdrawStatus(host, withdrawal);
    await refreshBalance().catch(() => undefined);
    if (withdrawal.status === 'paid') {
      toast({ kind: 'win', title: 'Withdrawal sent', body: money(Number(withdrawal.amountMinor)) });
      playSound('coin');
    }
    return;
  }
  setTimeout(() => pollWithdrawal(id, host), 3000);
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
      let completionPending = false;
      $('#linkComplete', body).addEventListener('click', async () => {
        if (completionPending) return;
        completionPending = true;
        const button = $('#linkComplete', body);
        const inlineError = $('#linkCompleteError', body);
        button.disabled = true;
        inlineError.hidden = true;
        inlineError.textContent = '';
        try {
          const user = await completeLogin(challengeId);
          closeModal();
          toast({ kind: 'win', title: 'Account linked', body: user.minecraftUsername });
        } catch (error) {
          inlineError.textContent = error?.message || 'The server rejected the request.';
          inlineError.hidden = false;
          showApiError(error);
          completionPending = false;
          button.disabled = false;
        }
      });
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
$('#withdrawBtn').addEventListener('click', openWithdrawModal);
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
  if (document.hidden) return;
  const refreshes = [refreshActivity()];
  if (state.authenticated) refreshes.push(refreshBalance());
  Promise.allSettled(refreshes).catch(() => undefined);
}, 15_000);

/* Deposits land while the player is staring at the page waiting for them, so they get their own
 * beat rather than sharing the slow one above. Six seconds is the same cadence the chat rail
 * already polls at, and the two together stay well inside the gateway's 120-a-minute budget. */
const DEPOSIT_POLL_MS = 6000;
/* A backlog is announced, not dumped: if a run of deposits landed while the tab was hidden, the
 * first few are named and the rest are counted. Twenty toasts is not twenty times the information. */
const MAX_DEPOSIT_TOASTS = 3;

setInterval(async () => {
  if (document.hidden || !state.authenticated) return;
  let credited;
  try {
    credited = await pollDeposits();
  } catch (error) {
    /* A missed tick costs six seconds and the watermark is untouched, so the next one recovers.
     * It is still logged: a poll that fails every time looks exactly like a poll that is not
     * running at all, and silence here cost a debugging round trip once already. */
    console.warn('[donutdrop] deposit poll failed', error?.code || error);
    return;
  }
  if (!credited.length) return;

  for (const deposit of credited.slice(0, MAX_DEPOSIT_TOASTS)) {
    toast({
      kind: 'win',
      title: deposit.kind === 'pay_login_deposit' ? 'Sign-in payment credited' : 'Deposit credited',
      body: money(Number(deposit.amountMinor ?? deposit.amount_minor ?? 0)),
    });
  }
  const hidden = credited.length - MAX_DEPOSIT_TOASTS;
  if (hidden > 0) {
    toast({ kind: 'win', title: 'More deposits credited', body: `and ${hidden} more` });
  }
  playSound('coin');
}, DEPOSIT_POLL_MS);

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
