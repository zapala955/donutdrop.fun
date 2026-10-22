/* app.js — entry point: shell wiring, clean-path router, home + crates + inventory. */
import {
  RARITY, IMG, SPOTLIGHT_GAMES, isNewGame,
} from './data.js';
import {
  state, bus, bootstrap, canAfford, openCase as requestCaseOpen,
  startLogin, loginStatus, completeLogin, logout,
  discordLoginAvailable, startDiscordLogin, completeDiscordLogin, discordLoginAccounts,
  cashDepositInfo, refreshActivity, refreshBalance, pollDeposits,
  cashWithdrawalInfo, requestCashWithdrawal, cashWithdrawalStatus, turnstileConfig,
  refreshUpgradeConfig, refreshPromotions,
} from './store.js';
import {
  $, $$, el, money, itemTile, reduceMotion, safeImage, parseAmount,
} from './util.js';
import {
  toast, initModal, initWallet, initHints, initHeaderFit, broadcast,
  openModal, closeModal,
} from './ui.js';
import { API_BASE_URL } from './api.js';
import { mountUpgrader } from './upgrader.js';
import { mountRoulette } from './roulette.js';
import { mountBlackjack } from './blackjack.js';
import { mountCrash } from './crash.js';
import { mountMines } from './mines.js';
import { mountPlinko } from './plinko.js';
import { mountDice } from './dice.js';
import { mountMonument, mountSlots } from './slots.js';
import { mountTower } from './tower.js';
import { mountChicken } from './chicken.js';
import { mountCoinflip } from './coinflip.js';
import { mountMinesDuel } from './mines-duel.js';
import { mountCrates } from './crates.js';
import { mountBattles } from './battles.js';
import { mountDuel } from './duel.js';
import {
  mountReferrals,
  captureReferralCode,
  pendingReferralCode,
  settlePendingReferral,
} from './referrals.js';
import { mountVip, initVipWidget } from './vip.js';
import { mountRewards } from './rakeback.js';
import { mountDaily } from './daily.js';
import { mountDiscord } from './discord.js';
import { applyRouteMeta } from './seo.js';
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
import { playCutscene, warmCutscene, isJackpot } from './cutscene.js';
import { playReel, warmReel } from './reel.js';
import { initDevMenu } from './devmenu.js';
import { initLiveEvents } from './live.js';
import { initNudge } from './nudge.js';
import { initPopups } from './popups.js';
import { initDailyCode } from './daily-code.js';
import { initTestMode } from './testmode.js';
import { initNotices } from './notices.js';
import { initWinFx } from './winfx.js';
import { initBlockArt } from './blockart.js';
import {
  appPath, currentRouteName, migrateLegacyHashRoute, navigate, onNavigate,
} from './routing.js';

/* ═════════ home ═════════ */
function mountHome(view) {
  if (view.dataset.built) return;
  view.dataset.built = '1';

  /* The lobby. Every card is in the markup; this filters the rows, names the first after the tab,
   * drives the arrows and sets the "New" tags. A card shows when it is in the chosen category and
   * its name or its keywords contain every word typed. The Originals come first; the slot machines
   * have a row of their own under them, which goes when nothing in it matches. */
  const search = $('#lobbySearch', view);
  const none = $('#lobbyNone', view);
  const tabs = $$('.lobby__tab', view);
  const cards = $$('.gcard', view);
  const track = $('#lobbyTrack', view);
  const title = $('#lobbyTitle', view);
  const prev = $('#lobbyPrev', view);
  const next = $('#lobbyNext', view);
  const mainHead = $('#lobbyH', view).closest('.lxrow__head');
  const more = $('.lxmore', view);
  const slotsRow = $('#slotsRow', view);
  const slotsTrack = $('#slotsTrack', view);
  let category = 'all';

  for (const card of cards) {
    const game = SPOTLIGHT_GAMES.find((entry) => entry.route === card.getAttribute('href'));
    $('.gcard__badge', card).hidden = !(game && isNewGame(game));
  }

  // Each arrow is live only while there is more of its row to see on its side.
  const wireRow = (row, back, forward) => {
    const paint = () => {
      const end = row.scrollWidth - row.clientWidth;
      back.disabled = row.scrollLeft <= 2;
      forward.disabled = row.scrollLeft >= end - 2;
    };
    const scrollRow = (direction) => {
      row.scrollBy({
        left: direction * row.clientWidth * 0.85,
        behavior: reduceMotion() ? 'auto' : 'smooth',
      });
    };
    back.addEventListener('click', () => scrollRow(-1));
    forward.addEventListener('click', () => scrollRow(1));
    row.addEventListener('scroll', paint, { passive: true });
    new ResizeObserver(paint).observe(row);
    return paint;
  };
  const paintMainArrows = wireRow(track, prev, next);
  const paintSlotArrows = wireRow(slotsTrack, $('#slotsPrev', view), $('#slotsNext', view));
  const paintArrows = () => {
    paintMainArrows();
    paintSlotArrows();
  };

  const filterLobby = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    let slots = 0;
    for (const card of cards) {
      const inCategory = category === 'all' || card.dataset.cat.split(' ').includes(category);
      const text = `${$('.gcard__name', card).textContent} ${card.dataset.q}`.toLowerCase();
      const match = inCategory && words.every((word) => text.includes(word));
      card.parentElement.hidden = !match;
      if (match) shown += 1;
      if (match && slotsTrack.contains(card)) slots += 1;
    }
    const originals = shown - slots;
    none.hidden = shown > 0;
    track.hidden = originals === 0;
    // With only slots left, the Originals heading goes too; with nothing left it stays over the note.
    mainHead.hidden = originals === 0 && slots > 0;
    more.hidden = originals === 0;
    slotsRow.hidden = slots === 0;
    track.scrollLeft = 0;
    slotsTrack.scrollLeft = 0;
    paintArrows();
  };
  const pickCategory = (code) => {
    category = code;
    for (const tab of tabs) {
      const on = tab.dataset.cat === code;
      tab.setAttribute('aria-pressed', String(on));
      if (on) title.textContent = tab.dataset.title;
    }
    filterLobby();
  };

  for (const tab of tabs) tab.addEventListener('click', () => pickCategory(tab.dataset.cat));
  search.addEventListener('input', filterLobby);
  $('#lobbyReset', view).addEventListener('click', () => {
    search.value = '';
    pickCategory('all');
    search.focus();
  });
  paintArrows();

  /* The three offers at the top. Every figure is the server's: before /v1/promotions answers, and
   * with an offer switched off, each one says what it can say without a number. */

  // "Get $2M free" with the amount in gold: built from nodes, never from an HTML string.
  const amountLine = (target, before, minor, after) => {
    const amount = el('b');
    amount.textContent = money(minor);
    target.replaceChildren(before, amount, after);
  };

  /* The lead banner. Signed out it is the signup bonus, with a Log in button beside "Explore
   * games", because logging in is the step between a visitor and every game below it. Signed in
   * it is an invitation to the whole lobby, and "Explore games" is its one button. It used to name
   * a single game (Coinflip, Mines Duel...) to try; the operator wanted the lobby, not one game,
   * put forward there (2026-10-09). The count is the cards actually on the page.
   *
   * Behind the text sits a cover link, so the rest of the card does what the main button does:
   * log in when signed out, explore when signed in. */
  const lead = $('#pbanLead', view);
  const leadGo = $('#pbanLeadGo', lead);
  const leadCover = $('#pbanLeadCover', lead);
  const leadExplore = $('#pbanExplore', lead);
  const paintLead = () => {
    const bonus = Number(state.promotions?.signupBonus?.amountMinor ?? 0);
    const signedOut = !state.authenticated;
    lead.dataset.kind = signedOut ? 'login' : 'explore';
    leadGo.hidden = !signedOut;
    // The gold one is the main action: Log in when it is there, otherwise Explore games.
    leadExplore.classList.toggle('btn--go', !signedOut);
    leadExplore.classList.toggle('pban__more', signedOut);
    $('#pbanLeadEyebrow', lead).textContent = signedOut ? 'New players' : 'DonutLuxe Originals';
    const heading = $('#pbanLeadH', lead);
    if (signedOut && bonus > 0) amountLine(heading, 'Get ', bonus, ' free');
    else heading.textContent = signedOut ? 'Log in to play' : `Explore ${cards.length} games`;
    $('#pbanLeadP', lead).textContent = signedOut
      ? bonus > 0
        ? 'Added the moment your account is created. Log in with your Minecraft name.'
        : 'Log in with your Minecraft name, deposit in game and play.'
      : 'Crash, Mines, Coinflip, Plinko, Blackjack and more.';
    $('#pbanLeadArt', lead).src = `${IMG}${signedOut ? 'gold_block.png' : 'ender_chest.png'}`;
  };

  /* "Explore games": down to the games row, with every game showing. The scroll stops under the
   * sticky header, and under the jackpot bar when that is up, rather than behind them. Focus moves
   * to the lobby so a keyboard carries on from there; the search box is left alone, because
   * focusing it would throw a phone's keyboard over the row. */
  const lobby = $('#lobby', view);
  const exploreGames = () => {
    search.value = '';
    pickCategory('all');
    const covered = ['.top', '.lxtop', '#vaultJackpot']
      .map((selector) => document.querySelector(selector))
      .filter((node) => node && !node.hidden)
      .reduce((bottom, node) => Math.max(bottom, node.getBoundingClientRect().bottom), 0);
    window.scrollTo({
      top: window.scrollY + lobby.getBoundingClientRect().top - covered - 12,
      behavior: reduceMotion() ? 'auto' : 'smooth',
    });
    lobby.focus({ preventScroll: true });
  };
  leadExplore.addEventListener('click', exploreGames);

  const leadAction = (event) => {
    event.preventDefault();
    if (lead.dataset.kind === 'login') openLoginModal();
    else exploreGames();
  };
  leadGo.addEventListener('click', leadAction);
  leadCover.addEventListener('click', leadAction);

  /* The invite offer. With the bonus switched off it still invites, because the revenue share on
   * invited players is paid either way; the referrals page states both terms.
   *
   * Signed out, the referrals page is a dead end (it can only say "sign in"), so the banner opens
   * the signup form instead and says so on its button. */
  const invite = $('#pbanInvite', view);
  const paintInvite = () => {
    const referral = state.promotions?.referral;
    const bonus = Number(referral?.bonusMinor ?? 0);
    const heading = $('#pbanInviteH', invite);
    // The wager condition is left to the referrals page, which states it as "Unlocks at".
    if (bonus > 0) amountLine(heading, '', bonus, ' per invite');
    else heading.textContent = 'Invite your friends';
    $('#pbanInviteGo', invite).textContent = state.authenticated ? 'Get your link' : 'Sign up';
  };
  invite.addEventListener('click', (event) => {
    if (state.authenticated) return;
    event.preventDefault();
    openLoginModal();
  });

  paintLead();
  paintInvite();

  /* The upgrader page reads its limits from state.upgradeConfig and never asks for them itself:
   * signed in they come with the session, signed out only from here. The stat cards that also
   * quoted them are gone; the request stays for the upgrader's sake. */
  void refreshUpgradeConfig();

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
  /* The table games' names and the sprites their lobby cards wear (retro.css), for the wins card. */
  const WIN_GAMES = {
    crash: { name: 'Crash', art: 'assets/img/items/game-crash.svg' },
    mines: { name: 'Mines', art: 'assets/img/items/game-mines.svg' },
    tower: { name: 'Tower', art: 'assets/img/items/game-tower.svg' },
    chicken: { name: 'Chicken', art: 'assets/img/items/chicken.svg' },
    plinko: { name: 'Plinko', art: 'assets/img/items/game-plinko.svg' },
    dice: { name: 'Dice', art: 'assets/img/items/dice.svg' },
    slots: { name: 'Ore Rush', art: 'assets/img/items/game-ore-rush.svg' },
    monument: { name: 'Ocean Monument', art: 'assets/img/items/game-monument.svg' },
    blackjack: { name: 'Blackjack', art: 'assets/img/items/game-blackjack.svg' },
    roulette: { name: 'Roulette', art: 'assets/img/items/game-roulette.svg' },
    coinflip: { name: 'Coinflip', art: 'assets/img/items/game-coinflip.svg' },
    minesduel: { name: 'Mines Duel', art: 'assets/img/items/game-mines-duel.svg' },
  };
  const paintActivity = () => {
    const drops = $('#bigDrops', view);
    if (!drops) return;
    drops.innerHTML = '';

    /* "Biggest wins today": every game's winning rounds since midnight UTC, biggest profit first
     * (/v1/activity/top-today). A win returned more than it cost; the live feed at the foot of the
     * page shows every round, losses included.
     *
     * A crate or upgrader win shows the item it paid; a table game shows its own lobby sprite, so
     * the row reads as the game at a glance. The figure is the PROFIT, what the player came away
     * up, which is also the order: a large stake cashed out at 1.01x is not a big win. */
    const rounds = state.topPulls ?? [];

    if (!rounds.length) {
      const empty = el('li', 'drops__empty');
      empty.textContent = 'No wins yet today.';
      drops.appendChild(empty);
      return;
    }

    for (const entry of rounds.slice(0, 7)) {
      const { item, player, sourceName } = entry;
      const wager = BigInt(entry.wagerMinor ?? '0');
      const payout = BigInt(entry.payoutMinor ?? '0');
      // Both slot machines come in as slots; the Monument's rows carry its own name.
      const game = entry.kind === 'slots' && sourceName === 'Ocean Monument' ? WIN_GAMES.monument : WIN_GAMES[entry.kind];
      if (!item && !game) continue;
      const row = el('li');
      /* An item's rarity drives the edge, so a Netherite pull still stands out from a Diamond one;
       * a table game wears the house gold. rarityFor() can return a tier this table does not
       * carry; fall back rather than throw. */
      row.style.setProperty('--rar', item ? RARITY[item.rarity]?.color ?? '#ffaa00' : '#ffaa00');
      row.dataset.rarity = item?.rarity ?? 'game';
      row.dataset.kind = entry.kind;

      const art = document.createElement('img');
      art.src = item ? safeImage(item.img) : game.art;
      art.alt = '';
      art.loading = 'lazy';

      const stack = el('span', 'drops__stack');
      const what = el('span', 'what');
      what.textContent = item ? item.name : game.name;
      const who = el('span', 'who');
      // Whole numbers past 1,000x, so the line keeps its room: "17,714×", not "17714.70×".
      const times = wager > 0n ? Number((payout * 100n) / wager) / 100 : 0;
      const multiple = !times ? '' : times >= 1000
        ? `${Math.floor(times).toLocaleString('en-US')}×`
        : `${times.toFixed(2)}×`;
      const detail = item ? sourceName : multiple;
      who.textContent = detail ? `${player ?? '???'} · ${detail}` : (player ?? '???');
      stack.append(what, who);

      const amount = el('span', 'amt mono');
      amount.textContent = `+${money(Number(payout - wager))}`;
      amount.title = `Won ${money(Number(payout))} on ${money(Number(wager))}`;

      row.append(art, stack, amount);
      drops.appendChild(row);
    }
  };

  paintActivity();
  bus.addEventListener('change', () => {
    if (!view.isConnected) return;
    paintLead();
    paintInvite();
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

const DISCORD_ICON =
  '<svg class="auth__dcicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.2 5.3A16.3 16.3 0 0 0 15.1 4l-.5 1.1a15 15 0 0 0-5.2 0L8.9 4a16.3 16.3 0 0 0-4.1 1.3C2.2 9.2 1.5 13 1.9 16.7A16.6 16.6 0 0 0 7 19.3l1.2-1.7c-.7-.3-1.4-.7-2-1.2l.5-.4c3.8 1.8 7.9 1.8 11.6 0l.5.4c-.6.5-1.3.9-2 1.2l1.2 1.7a16.6 16.6 0 0 0 5.1-2.6c.5-4.3-.8-8.1-2.9-11.4ZM8.5 14.5c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.9 2-1.9 2Zm7 0c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.8 2-1.9 2Z"/></svg>';

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
      <div class="auth__bonus" id="linkBonus" hidden>
        <p class="auth__bonushead"><b class="auth__bonusamt" id="linkBonusAmt"></b> free for new players</p>
        <p class="auth__bonusfine" id="linkBonusFine"></p>
      </div>
      <div class="auth__discord" id="linkDiscord" hidden>
        <button class="btn auth__dcgo" type="button" id="linkDiscordGo">${DISCORD_ICON}<span>Log in with Discord</span></button>
        <p class="auth__note" id="linkDiscordNote">Already linked your Discord? Sign in with one click, no payment. Alts on the same Discord too.</p>
        <p class="auth__err" id="linkDiscordError" role="alert" hidden></p>
      </div>
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
            <span class="auth__txt">I agree to all <a href="/terms">Terms &amp; Conditions</a>.</span>
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

    /* The signup offer, from the server's own settings. Hidden until they answer and hidden if the
     * bonus is switched off: a figure this screen cannot confirm is not one it should promise. The
     * wager lock is deliberately not repeated here (operator's call, 2026-09-24); the withdraw
     * screen states it, with the amount still owed, whenever it applies. */
    const paintBonus = () => {
      const box = $('#linkBonus', body);
      if (!box?.isConnected) return;
      const offer = state.promotions?.signupBonus;
      const amount = Number(offer?.amountMinor ?? 0);
      box.hidden = !(amount > 0);
      if (box.hidden) return;
      $('#linkBonusAmt', box).textContent = money(amount);
      $('#linkBonusFine', box).textContent =
        'Added when your account is created. Play with it straight away.';
    };
    paintBonus();
    if (!state.promotions) void refreshPromotions(false).then(paintBonus);

    /* Log in with Discord, for accounts that already linked one. Hidden until the server says it is
     * set up; it leaves the page for Discord, and the return is handled by finishDiscordReturn. */
    const discordBox = $('#linkDiscord', body);
    const discordGo = $('#linkDiscordGo', body);
    const discordError = $('#linkDiscordError', body);
    void discordLoginAvailable().then((available) => {
      if (available && discordBox.isConnected && !$('#linkForm', body).hidden) discordBox.hidden = false;
    });
    /* Whoever signed in with Discord on this device last time, so a returning player sees whose
     * session the button is about to bring back. A convenience only: Discord decides who it is. */
    const last = readDiscordLast();
    if (last) {
      $('#linkDiscordNote', body).textContent =
        `Last time: ${last}. Alts on the same Discord can be picked after Discord confirms.`;
    }
    discordGo.addEventListener('click', async () => {
      discordGo.disabled = true;
      discordGo.dataset.state = 'loading';
      discordError.hidden = true;
      try {
        await goToDiscord();
      } catch (error) {
        discordGo.disabled = false;
        discordGo.dataset.state = '';
        discordError.textContent = error?.message || 'Could not start the Discord sign-in.';
        discordError.hidden = false;
      }
    });

    /* An invite link fills the field and opens the disclosure it lives in.
     *
     * Arriving with a code and being shown a collapsed "Have a referral code?" summary asks the
     * recipient to go and find the thing the sender already did for them — and a code they cannot
     * see is a code they cannot check before they commit. It stays editable: it is their signup,
     * and somebody who wants to change or clear it may. */
    const arriving = pendingReferralCode();
    if (arriving) {
      referral.value = arriving;
      const disclosure = referral.closest('details');
      if (disclosure) disclosure.open = true;
    }

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
        /* The code goes WITH the login, not after it.
         *
         * It used to be held in sessionStorage and attached once a session existed, which meant
         * any logged-in account could spend one — including accounts that had been playing for
         * months. It is now recorded on the challenge and redeemed inside the transaction that
         * creates the account, so a code can only ever be spent by somebody signing up. There is
         * no endpoint left that could attach one afterwards. */
        const challenge = await startLogin(username, challengeToken, code || undefined);
        go.dataset.state = 'success';
        form.hidden = true;
        discordBox.hidden = true;
        /* The command, the amount, and one button that copies it.
         *
         * Retyping `/pay DonutBot 4127` by hand is the step this flow loses people at: the amount
         * is what identifies the payment, so one wrong digit is a login that never completes and a
         * payment somebody then has to ask about. It is on the clipboard now.
         *
         * There is no Finish button. The poll signs the player in the moment the payment confirms
         * — see pollLink. The block below stays hidden until something actually fails. */
        $('#linkProgress', body).innerHTML = `<p class="auth__lede">Run this exact command in game:</p>
          <div class="auth__field auth__field--static">
            <span class="auth__value auth__value--lg mono">${escapeText(challenge.instruction)}</span>
          </div>
          <button class="btn btn--go auth__go" type="button" id="linkCopy">Copy command</button>
          <p class="auth__note">Pay exactly $${escapeText(String(challenge.payAmount))} — the amount is what identifies you, so a different amount will not sign you in.</p>
          <div class="kv"><span>status</span><span id="linkState">waiting for your payment</span></div>
          <div id="linkFinish" hidden>
            <p class="card__p" id="linkCompleteError" role="alert"></p>
            <button class="btn btn--go" type="button" id="linkComplete">Try again</button>
          </div>`;

        $('#linkCopy', body).addEventListener('click', async (event) => {
          const button = event.currentTarget;
          try {
            await navigator.clipboard.writeText(challenge.instruction);
            button.textContent = 'Copied';
            button.dataset.state = 'success';
          } catch {
            // Refused in plenty of ordinary situations. The command is on screen right above it.
            button.textContent = 'Select it above';
          }
          setTimeout(() => {
            if (!button.isConnected) return;
            button.textContent = 'Copy command';
            button.dataset.state = '';
          }, 1800);
        });
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
  awaiting_vault: 'queued for the bot',
  processing: 'the bot is paying you now',
  paid: 'paid in game',
  rejected: 'rejected, your balance was returned',
  failed: 'could not be sent, your balance was returned',
  manual_review: 'held for review — contact support, do not retry',
};

/* The state in words, and why it is taking longer when the server has said why: the bot was asked
 * to pay more than it held, nothing left it, and it tries again by itself every few minutes. */
function cashStateText(withdrawal) {
  const place = withdrawal.queuePosition ? ` — #${withdrawal.queuePosition} in the queue` : '';
  if (withdrawal.errorCode === 'PAYOUT_INSUFFICIENT_FUNDS'
    && ['queued', 'awaiting_vault', 'processing'].includes(withdrawal.status)) {
    return `waiting in the payout queue${place}. The payout bot is being topped up; yours goes out by itself`;
  }
  if (['queued', 'awaiting_vault'].includes(withdrawal.status) && withdrawal.queuePosition > 1) {
    return `in the payout queue${place}`;
  }
  return CASH_STATE_TEXT[withdrawal.status] || withdrawal.status;
}

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
    <button class="btn btn--go auth__go" type="button" id="depositCopy">Copy command</button>`;

  $('#depositCopy', host).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      /* `copy` is the command with no amount on it, so the paste lands with the cursor where
         the figure goes. It used to copy `example`, which pasted a literal 1000000 that had to be
         deleted first — and the failure mode when somebody forgot was depositing exactly one
         million by accident. */
      await navigator.clipboard.writeText(info.copy || info.command);
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

/** "once", "2×": how a wager multiplier reads in a sentence. */
function timesWord(multiplier) {
  return multiplier === 1 ? 'once' : `${multiplier}×`;
}

/**
 * What still has to be wagered before money can leave the account.
 *
 * A screen of its own, like the cooldown below, rather than a form whose Continue never enables:
 * the amount field would invite typing a figure the server is certain to refuse. The number is the
 * server's, and so is the reason: deposits and the signup bonus, at whatever the admin panel says.
 */
function paintWithdrawLocked(host, owedMinor) {
  const deposit = Number(state.promotions?.depositWagerMultiplier ?? 0);
  const bonus = Number(state.promotions?.signupBonus?.wagerMultiplier ?? 0);
  let why = 'Every bet you place counts towards it.';
  if (deposit > 0 && bonus > 0) {
    why = `Deposits are wagered ${timesWord(deposit)} and the signup bonus ${timesWord(bonus)} before they can be withdrawn. ${why}`;
  } else if (deposit > 0) {
    why = `Deposits are wagered ${timesWord(deposit)} before they can be withdrawn. ${why}`;
  } else if (bonus > 0) {
    why = `The signup bonus is wagered ${timesWord(bonus)} before it can be withdrawn. ${why}`;
  }
  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Withdraw</h3>
    <p class="auth__lede">Wager <b class="mono" id="wdLockAmt"></b> more to unlock withdrawals.</p>
    <p class="auth__note" id="wdLockWhy"></p>
    <hr class="auth__rule">
    <button class="btn btn--go auth__go" type="button" id="wdLockClose">Keep playing</button>`;
  $('#wdLockAmt', host).textContent = money(Number(owedMinor));
  $('#wdLockWhy', host).textContent = why;
  $('#wdLockClose', host).addEventListener('click', () => closeModal());
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

  const cooldownRemaining = Number(info.cooldownRemainingSeconds ?? 0);
  if (cooldownRemaining > 0) {
    paintWithdrawCooldown(host, cooldownRemaining);
    return;
  }

  const owed = Number(info.wagerRequirementRemainingMinor ?? 0);
  if (owed > 0) {
    paintWithdrawLocked(host, owed);
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

/** Keep the server-enforced minute visible instead of letting the next submit fail mysteriously. */
function paintWithdrawCooldown(host, remainingSeconds) {
  const readyAt = Date.now() + Math.max(1, remainingSeconds) * 1000;
  host.innerHTML = `<h3 class="auth__title" aria-hidden="true">Withdraw</h3>
    <p class="auth__lede">Please wait <b class="mono" id="wdCooldown"></b> before starting
      another withdrawal.</p>
    <hr class="auth__rule">
    <button class="btn btn--go auth__go" type="button" id="wdCooldownClose">Close</button>`;

  $('#wdCooldownClose', host).addEventListener('click', () => closeModal());
  const label = $('#wdCooldown', host);
  const tick = () => {
    if (!host.isConnected || !$('#modal').open) return;
    const seconds = Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
    if (seconds === 0) {
      void openWithdrawModal();
      return;
    }
    label.textContent = `${seconds} second${seconds === 1 ? '' : 's'}`;
    window.setTimeout(tick, 250);
  };
  tick();
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
      <div class="auth__crow"><span>Status</span><b id="wdState">${escapeText(cashStateText(withdrawal))}</b></div>
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
  if (label) label.textContent = cashStateText(withdrawal);
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
      /* Confirmed means the bot has seen the payment, so there is nothing left to decide and
       * nothing left to press. The button that stood here asked a player to agree to something
       * that had already happened, and every second it waited was a second somebody looked at a
       * screen that had taken their money and had not signed them in. */
      await finishLogin(challengeId, body);
      return;
    }
    if (['expired', 'locked', 'completed'].includes(state)) return;
  } catch (error) {
    /* A dropped connection, a 429 or a 502 says nothing about the payment. One used to end the
     * poll for good, and a player who paid a second later sat in front of "waiting for your
     * payment" with nothing left watching for it. Only an answer about the challenge itself — not
     * found, not yours — is worth stopping on. */
    if (isTransient(error)) {
      const status = $('#linkState', body);
      if (status) status.textContent = 'connection hiccup, still checking';
      setTimeout(() => pollLink(challengeId, body), 4000);
      return;
    }
    showApiError(error);
    return;
  }
  setTimeout(() => pollLink(challengeId, body), 2000);
}

const isTransient = (error) => !error?.status || error.status === 429 || error.status >= 500;

/* The sign-in window, as opposed to deposit and withdraw, which share its variant. */
const signInOpen = () => $('#modal').open && Boolean($('#linkForm', $('#modalBody')));

/**
 * Signs in a confirmed login, and offers a retry only if that fails.
 *
 * The retry is not decoration. Completion is a separate request from the confirmation, so it can
 * fail on its own — a dropped connection, a 500 — after the payment has already been made. With no
 * way back the player would be holding a receipt for a session they never got, which is the one
 * outcome this flow must not produce. The block stays hidden until that happens.
 */
async function finishLogin(challengeId, body) {
  const finish = $('#linkFinish', body);
  const inlineError = $('#linkCompleteError', body);
  const button = $('#linkComplete', body);
  const status = $('#linkState', body);
  if (status) status.textContent = 'signing you in';

  try {
    const user = await completeLogin(challengeId);
    if (signInOpen()) closeModal();
    toast({ kind: 'win', title: 'Account linked', body: user.minecraftUsername });
  } catch (error) {
    if (!body.isConnected) return;
    if (status) status.textContent = 'payment received, sign-in failed';
    if (inlineError) inlineError.textContent = error?.message || 'The server rejected the request.';
    if (finish) finish.hidden = false;
    showApiError(error);
    if (button && !button.dataset.wired) {
      /* Wired once. A listener added per failure would fire N completions on the Nth press, and
       * the payment behind them has already been spent. */
      button.dataset.wired = '1';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await finishLogin(challengeId, body);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    }
  }
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
  referrals: mountReferrals,
  studio: mountStudio,
  upgrader: mountUpgrader,
  roulette: mountRoulette,
  blackjack: mountBlackjack,
  crash: mountCrash,
  mines: mountMines,
  tower: mountTower,
  chicken: mountChicken,
  plinko: mountPlinko,
  dice: mountDice,
  'ore-rush': mountSlots,
  monument: mountMonument,
  coinflip: mountCoinflip,
  'mines-duel': mountMinesDuel,
  quests: mountQuests,
  war: mountWar,
  fairness: mountFair,
  vip: mountVip,
  rewards: mountRewards,
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
/* Every open nav menu's close(), so opening one shuts the other. Two menus open at once would each
 * be anchored to their own button and overlap in the middle of the bar. */
const openTabDrops = new Set();

function initTabDrop(wrapId, buttonId, menuId) {
  const wrap = $(`#${wrapId}`);
  const button = $(`#${buttonId}`);
  const menu = $(`#${menuId}`);
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

  /* Keyboard reach. Portalled to the end of <body>, the menu sits after everything else in tab
   * order, so Tab from the button never arrives in it. The menu pattern's answer: the button's
   * arrows and Enter move focus in, arrows move between rows, Escape or Tab hands it back.
   * Coming-soon rows are included on purpose -- they are aria-disabled, which keeps them readable
   * ("Blackjack, coming soon") while nothing can activate them. */
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  items().forEach((item) => item.setAttribute('tabindex', '-1'));
  const focusItem = (index) => {
    const list = items();
    if (list.length) list[(index + list.length) % list.length].focus();
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    openTabDrops.delete(close);
  };
  const open = () => {
    for (const other of [...openTabDrops]) other();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    /* Capture phase, so the menu follows the button when any scrolling ancestor moves — including
     * the nav bar itself scrolling sideways on a phone. */
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    openTabDrops.add(close);
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      close();
      return;
    }
    open();
    // detail is 0 for a click synthesised by Enter or Space: a keyboard user lands on the first row.
    if (event.detail === 0) focusItem(0);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (menu.hidden) open();
    focusItem(event.key === 'ArrowDown' ? 0 : -1);
  });
  menu.addEventListener('keydown', (event) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(at + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(at - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusItem(0); }
    else if (event.key === 'End') { event.preventDefault(); focusItem(-1); }
    else if (event.key === 'Tab') { event.preventDefault(); close(); button.focus(); }
    else if ((event.key === 'Enter' || event.key === ' ')
      && document.activeElement?.getAttribute('aria-disabled') === 'true') {
      // A game that is not live yet does nothing, and says so by doing nothing.
      event.preventDefault();
    }
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

/* Pages that moved, so old bookmarks and links keep working: the account menu's Rakeback page became
 * Rewards, and the first slot machine, at /slots, became Ore Rush when slots got a category of
 * their own (2026-10-19). nginx sends a full load of the old address on too (308). */
const RENAMED = { rakeback: 'rewards', slots: 'ore-rush' };

function route() {
  const requested = currentRouteName();
  if (RENAMED[requested]) {
    navigate(`/${RENAMED[requested]}${location.search}`, { replace: true });
    return;
  }
  const seg = requested;
  if (!VIEWS[seg]) {
    navigate('/', { replace: true });
    return;
  }
  const name = seg;

  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  // Title, description, canonical and robots for this route: what a search result shows.
  applyRouteMeta(name);
  /* Each disclosure reads as current whenever any route it owns is the live one. Casino owns only
   * Roulette today; a game that ships adds its route here and becomes a link in the menu. */
  const DROP_ROUTES = [
    ['casesBtn', ['crates', 'battles', 'studio']],
    ['casinoBtn', ['roulette', 'blackjack', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'dice', 'ore-rush', 'monument', 'mines-duel', 'coinflip']],
  ];
  for (const [id, routes] of DROP_ROUTES) {
    const btn = $(`#${id}`);
    if (!btn) continue;
    const on = routes.includes(name);
    btn.dataset.on = on ? '1' : '0';
    // the bar scrolls on phones, so keep the live tab in view
    if (on) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  $$('.tabs a').forEach((a) => {
    const on = a.dataset.route === name;
    a.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  /* The menus are portalled out of .tabs to <body>, so their rows need marking separately -- and
   * never scrolled to, since a closed menu is laid out but invisible. */
  $$('.tabdrop__menu a[data-route]').forEach((a) => {
    a.setAttribute('aria-current', a.dataset.route === name ? 'page' : 'false');
  });

  const mount = VIEWS[name];
  if (typeof mount !== 'function') {
    navigate('/', { replace: true });
    return;
  }
  mount($(`.view[data-view="${name}"]`));

  setChatOpen(false);
  window.scrollTo({ top: 0 });
}

/* ═════════ boot ═════════ */
initModal();
initHints();
initTabDrop('casesDrop', 'casesBtn', 'casesMenu');
initTabDrop('casinoDrop', 'casinoBtn', 'casinoMenu');
initWallet();
initWinFx();
initBlockArt();
$('#skipToMain')?.addEventListener('click', () => {
  const main = $('#main');
  main?.focus();
  main?.scrollIntoView({ block: 'start' });
});
/* The level pill. Owns its own bus subscription, so it repaints on every snapshot without the
 * router having to remember it. */
initVipWidget();
/* After everything that fills the header, so its first fit measures the real labels. */
initHeaderFit();
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
      const label = off ? 'Unmute sound' : 'Mute sound';
      muteButton.dataset.muted = off ? '1' : '0';
      muteButton.setAttribute('aria-pressed', String(off));
      muteButton.setAttribute('aria-label', label);
      muteButton.title = label;
    };
    muteButton.addEventListener('click', () => { setMuted(!isMuted()); paintMute(); });
    // The settings page has the same switch.
    window.addEventListener('lx:mute', paintMute);
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
    navigate('/');
    toast({ kind: 'win', title: 'Signed out' });
  } catch (error) {
    showApiError(error);
  }
});

const paintAuthChrome = () => {
  const button = $('#loginBtn');
  const label = $('#loginLabel');
  const head = $('#loginHead');
  if (label) label.textContent = state.authenticated ? state.user.minecraftUsername : 'Log in';
  button.dataset.authenticated = state.authenticated ? '1' : '0';
  // The phone header swaps the money controls for Log in once the session is known -- not
  // before, or every signed-in player would watch it flash "Log in" on each load.
  document.body.dataset.auth = !state.ready ? 'pending' : state.authenticated ? 'in' : 'out';
  if (!head) return;
  if (state.authenticated && state.user?.id) {
    const next = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(state.user.id)}?s=40`;
    if (head.dataset.failedFor === next) {
      button.dataset.avatar = 'fallback';
      head.hidden = true;
      return;
    }
    if (head.getAttribute('src') !== next) {
      delete head.dataset.failedFor;
      head.src = next;
    }
    button.dataset.avatar = 'head';
    head.hidden = false;
  } else {
    button.dataset.avatar = 'guest';
    head.hidden = true;
    head.removeAttribute('src');
    delete head.dataset.failedFor;
  }
};
$('#loginHead')?.addEventListener('error', (event) => {
  event.currentTarget.dataset.failedFor = event.currentTarget.getAttribute('src') || '';
  event.currentTarget.hidden = true;
  $('#loginBtn').dataset.avatar = 'fallback';
});
bus.addEventListener('change', paintAuthChrome);
paintAuthChrome();

/* ─────────── coming back from "Log in with Discord" ───────────
 *
 * The API's callback lands on `/?discord-login=<outcome>`. The outcome is read once and stripped so
 * a reload does not replay it. The session is collected BEFORE bootstrap -- on `ok` at once, on
 * `choose` once the player has picked one of the accounts on their Discord -- so bootstrap finds
 * the player signed in as the right account instead of racing the completion with a 401 (or, when
 * switching accounts, loading the old one first). Never rejects: the page loads either way. Anything
 * else says why and reopens the sign-in card, since signing in is what the player was doing. */
const DISCORD_LOGIN_NOTICES = {
  'not-linked': {
    kind: 'lose',
    title: 'Discord not linked',
    body: 'Sign in with Minecraft once, then link your Discord with /link in our server.',
  },
  admin: { kind: 'lose', title: 'Admins sign in with Minecraft', body: 'Your account needs its MFA code.' },
  expired: { kind: 'lose', title: 'Sign-in expired', body: 'Press Log in with Discord again.' },
  cancelled: { kind: 'lose', title: 'Discord sign-in cancelled' },
  failed: { kind: 'lose', title: 'Discord declined', body: 'Try again in a moment.' },
};

/* The last account signed in with Discord on this device, for the sign-in card's "Last time". */
const DISCORD_LAST_KEY = 'dd.discord.last';
/* Set while the one automatic retry with Discord's Authorize screen is under way (see `retry`). */
const DISCORD_RETRY_KEY = 'dd.discord.retry';

function readDiscordLast() {
  try {
    const name = localStorage.getItem(DISCORD_LAST_KEY);
    return name && /^\.?[A-Za-z0-9_]{2,16}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function signedInWithDiscord(user) {
  try {
    localStorage.setItem(DISCORD_LAST_KEY, user.minecraftUsername);
    sessionStorage.removeItem(DISCORD_RETRY_KEY);
  } catch {
    /* a convenience, not a requirement */
  }
  toast({ kind: 'win', title: 'Signed in with Discord', body: user.minecraftUsername });
}

/* Off to Discord. Normally without its Authorize screen for a player who approved the app before;
 * `consent` asks for the screen (the retry after Discord said it needs one). */
async function goToDiscord(consent = false) {
  const { authorizeUrl } = await startDiscordLogin(consent);
  location.assign(authorizeUrl);
}

/* "1d", "3h", "now": how long ago an account was last played, for the picker. */
function agoLabel(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Which of the accounts on this Discord to sign in to. Resolves once the player has picked one (and
 * the session is in) or has closed the window without picking; it never rejects.
 */
async function pickDiscordAccount() {
  let choice;
  try {
    choice = await discordLoginAccounts();
  } catch (error) {
    showApiError(error);
    return;
  }
  const accounts = choice?.accounts || [];
  if (!accounts.length) {
    toast(DISCORD_LOGIN_NOTICES['not-linked']);
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    openModal('Choose an account', (body) => {
      const title = el('h3', 'auth__title');
      title.setAttribute('aria-hidden', 'true');
      title.textContent = 'Choose an account';
      const lede = el('p', 'auth__lede');
      lede.textContent = `${choice.discordUsername ? `@${choice.discordUsername}` : 'Your Discord'} is linked to ${accounts.length} accounts. Which one?`;
      const list = el('ul', 'auth__accts');
      const error = el('p', 'auth__err');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const buttons = [];
      for (const account of accounts) {
        const item = el('li');
        const pick = el('button', 'auth__acct');
        pick.type = 'button';
        const head = el('img', 'auth__accthead');
        head.alt = '';
        head.width = 36;
        head.height = 36;
        head.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(account.id)}?s=40`;
        head.addEventListener('error', () => { head.style.visibility = 'hidden'; });
        const name = el('span', 'auth__acctname');
        name.textContent = account.minecraftUsername;
        const meta = el('span', 'auth__acctmeta');
        meta.textContent = [
          account.main ? 'Main' : 'Alt',
          account.lastLoginAt ? `played ${agoLabel(account.lastLoginAt)}` : null,
        ].filter(Boolean).join(' · ');
        if (account.main) pick.dataset.main = '1';
        pick.append(head, name, meta);
        pick.addEventListener('click', async () => {
          for (const other of buttons) other.disabled = true;
          pick.dataset.state = 'loading';
          error.hidden = true;
          try {
            const user = await completeDiscordLogin(account.id);
            done = true; // closing below is the success path, not a dismissal
            closeModal();
            signedInWithDiscord(user);
            resolve();
          } catch (failure) {
            delete pick.dataset.state;
            for (const other of buttons) other.disabled = false;
            error.textContent = failure?.message || 'Could not sign in to that account.';
            error.hidden = false;
          }
        });
        buttons.push(pick);
        item.appendChild(pick);
        list.appendChild(item);
      }
      const note = el('p', 'auth__note');
      note.textContent = 'Main is the account /tag pays in the Discord server. /accounts there changes it.';
      body.replaceChildren(title, lede, list, error, note);
    }, { variant: 'auth' });
    // After showModal(), which puts focus on the close button: the most recent account is the
    // likely pick, so Enter alone signs in to it.
    $('#modalBody .auth__acct')?.focus();
    $('#modal').addEventListener('close', finish, { once: true });
  });
}

async function finishDiscordReturn() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('discord-login');
  if (!outcome) return;
  params.delete('discord-login');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  if (outcome === 'ok') {
    try {
      signedInWithDiscord(await completeDiscordLogin());
      return;
    } catch (error) {
      showApiError(error);
    }
  } else if (outcome === 'choose') {
    await pickDiscordAccount();
    return;
  } else if (outcome === 'retry') {
    /* Discord would not skip its Authorize screen this time. Ask once more, with it; a second
     * refusal in the same tab is reported rather than looped on. */
    let retried = true;
    try {
      retried = sessionStorage.getItem(DISCORD_RETRY_KEY) === '1';
      sessionStorage.setItem(DISCORD_RETRY_KEY, '1');
    } catch {
      /* no storage: one try, then report */
    }
    if (!retried) {
      try {
        await goToDiscord(true);
        return;
      } catch (error) {
        showApiError(error);
      }
    } else {
      toast(DISCORD_LOGIN_NOTICES.failed);
    }
  } else if (DISCORD_LOGIN_NOTICES[outcome]) {
    toast(DISCORD_LOGIN_NOTICES[outcome]);
  }
  bus.addEventListener('change', function reopenSignIn(event) {
    if (event.detail !== 'ready') return;
    bus.removeEventListener('change', reopenSignIn);
    if (!state.authenticated && !$('#modal').open) openLoginModal();
  });
}

/* "Switch account" in the account menu: signed in, with Discord sign-in set up. It goes through
 * Discord again rather than hopping between accounts from this session, because a session proves
 * this account, not the Discord: a Minecraft account that changed hands must not open the alts of
 * the Discord it used to be linked to. */
{
  const switchButton = $('#switchAccountBtn');
  if (switchButton) {
    let available = false;
    const paint = () => { switchButton.hidden = !(available && state.authenticated); };
    void discordLoginAvailable().then((answer) => { available = answer; paint(); });
    bus.addEventListener('change', paint);
    switchButton.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await goToDiscord();
      } catch (error) {
        showApiError(error);
      }
    });
  }
}

/* Convert old #/ links before anything reads route state, then capture an invite code from the
 * ordinary query string so shared links and login round trips no longer depend on a fragment. */
migrateLegacyHashRoute();
captureReferralCode();

/* Somebody arriving on an invite link is here to sign up, so open the card that does it.
 *
 * Without this the link dropped them on the crates page with a code held silently in session
 * storage — the one thing the sender wanted to happen required the recipient to independently
 * decide to log in. A logged-in visitor is left alone: they cannot spend a code, and covering
 * their screen to tell them so would be worse than saying nothing.
 *
 * It waits for 'ready' because only then is it known who is signed in. It used to open at load,
 * when everybody still looks signed out, so the `?ref=` left in the address bar put the window back
 * over every player who had just signed up through a link, on every reload, and nothing closed it. */
bus.addEventListener('change', function openForInvite(event) {
  if (event.detail !== 'ready') return;
  bus.removeEventListener('change', openForInvite);
  if (pendingReferralCode() && !state.authenticated && !$('#modal').open) openLoginModal();
});
/* A link's code is only ever spent by a sign-up. Anybody signed in who still has one in hand was
 * not signing up: it is dropped, and a registered player is told where their one entry is.
 *
 * And a sign-in window has no business staying open over a signed-in player, however it got
 * there: opened just before the session was found, or left behind by a poll that lost its way. */
bus.addEventListener('change', (event) => {
  if ((event.detail === 'login' || event.detail === 'ready') && state.authenticated) {
    if (signInOpen()) closeModal();
    void settlePendingReferral();
  }
});
initLiveEvents();
initNudge({ openLogin: openLoginModal });
initPopups({ openLogin: openLoginModal });
initDailyCode({ openLogin: openLoginModal });
initTestMode();
initNotices();
finishDiscordReturn().then(bootstrap).catch(showApiError);
setInterval(() => {
  if (document.hidden) return;
  const refreshes = [refreshActivity()];
  if (state.authenticated) refreshes.push(refreshBalance());
  Promise.allSettled(refreshes).catch(() => undefined);
}, 60_000);

/* Deposits land while the player is staring at the page waiting for them. The live stream says so
 * the moment one is credited -- a 'notice' (live.js) -- and the check runs at once, and once more
 * a moment later in case the notice beat the database. The poll is the net under that: every six
 * seconds while the stream is down, every thirty while it is up, in case a notice went missing. */
const DEPOSIT_POLL_MS = 6000;
const DEPOSIT_POLL_LIVE_MS = 30_000;
const DEPOSIT_NOTICE_RETRY_MS = 1500;
/* The stream counts as up while it has spoken this recently; it beats every 2.5 seconds. */
const LIVE_FRESH_MS = 10_000;
/* A backlog is announced, not dumped: if a run of deposits landed while the tab was hidden, the
 * first few are named and the rest are counted. Twenty toasts is not twenty times the information. */
const MAX_DEPOSIT_TOASTS = 3;

let liveAt = 0;
let lastDepositCheck = 0;
let depositCheck = null;
let depositCheckAgain = false;
let depositRetry = 0;
window.addEventListener('donut:live-status', (event) => {
  liveAt = event.detail?.connected ? Date.now() : 0;
});

/* One check at a time. Two at once would both read the same new row before either moved the
 * watermark, and the deposit would be announced twice; a check asked for mid-flight runs after. */
async function checkDeposits() {
  if (document.hidden || !state.authenticated) return;
  if (depositCheck) {
    depositCheckAgain = true;
    return;
  }
  lastDepositCheck = Date.now();
  depositCheck = announceDeposits();
  try {
    await depositCheck;
  } finally {
    depositCheck = null;
    if (depositCheckAgain) {
      depositCheckAgain = false;
      void checkDeposits();
    }
  }
}

async function announceDeposits() {
  let credited;
  try {
    credited = await pollDeposits();
  } catch (error) {
    /* A missed check costs one tick and the watermark is untouched, so the next one recovers.
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
}

setInterval(() => {
  const live = Date.now() - liveAt < LIVE_FRESH_MS;
  // Half a second of slack, so the thirty-second beat lands on the fifth tick, not the sixth.
  if (Date.now() - lastDepositCheck >= (live ? DEPOSIT_POLL_LIVE_MS : DEPOSIT_POLL_MS) - 500) {
    void checkDeposits();
  }
}, DEPOSIT_POLL_MS);
window.addEventListener('donut:notice', () => {
  void checkDeposits();
  clearTimeout(depositRetry);
  depositRetry = setTimeout(() => void checkDeposits(), DEPOSIT_NOTICE_RETRY_MS);
});

/* the animation test bench — hidden until Ctrl+Alt+D or ?dev=1 */
initDevMenu(document.getElementById('devRoot'));
/* The chat drawer below 1080px. Closed on arrival: it used to open over the page on a phone's
 * first visit and the header button could not close it. Every way out goes through here so the
 * button's state never disagrees with the drawer. */
function setChatOpen(open) {
  document.body.classList.toggle('chat-open', open);
  const button = $('#burger');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
}
$('#burger').addEventListener('click', () => {
  setChatOpen(!document.body.classList.contains('chat-open'));
});
$('#chatScrim')?.addEventListener('click', () => setChatOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('chat-open')) setChatOpen(false);
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
    menu.addEventListener('click', (e) => { if (e.target.closest('a, [data-closes-menu]')) close(); });

    const paintInvites = () => {
      const n = $('#menuInvites');
      /* The signed-in terms first, then the public promotions, so a visitor who has not signed in
       * sees the real figure on the pill too rather than the figure-free fallback. */
      const bonus = Number(
        state.referrals?.terms?.bonusMinor ?? state.promotions?.referral?.bonusMinor ?? 0,
      );
      if (n && bonus > 0) n.textContent = money(bonus);

      /* The nav pill's figure, from the server's terms rather than from the markup.
       *
       * It was literal text in index.html and it went stale the moment the bonus was retuned — the
       * bar advertised $20M per invite while the programme paid something else. A promotional
       * figure that can disagree with what is actually paid is worse than no figure, so the markup
       * now ships "INVITE & EARN" and this upgrades it once the real amount is known. Logged out,
       * or with the programme off, the honest version is the one that stays. */
      const pill = $('.navref__txt');
      if (pill && bonus > 0) {
        pill.replaceChildren(
          document.createTextNode(money(bonus) + ' '),
          Object.assign(document.createElement('b'), { textContent: 'PER INVITE' }),
        );
        const short = $('.navref__short');
        if (short) short.textContent = money(bonus);
      }
    };
    paintInvites();
    bus.addEventListener('change', paintInvites);
  }
}

/* All public links use real paths. Keep navigation instant inside the app while preserving normal
 * browser behaviour for external links, downloads, new tabs and the in-page skip link. */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0)) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (!link || link.target || link.hasAttribute('download')) return;

  const target = new URL(link.href, location.href);
  if (target.origin !== location.origin || target.hash) return;
  const segments = appPath(target.pathname).split('/').filter(Boolean);
  if (segments.length > 1) return;
  const requested = segments[0] || 'home';
  if (!VIEWS[requested] && !RENAMED[requested]) return;

  event.preventDefault();
  navigate(target.pathname + target.search);
});

onNavigate(route);
route();
