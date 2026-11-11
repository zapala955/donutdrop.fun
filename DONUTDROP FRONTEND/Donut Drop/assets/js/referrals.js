/* referrals.js — the Invite & Earn page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHY THE PAGE IS ALLOWED TO SHOW MONEY NOW
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This page used to end in a box admitting that referral tracking did not exist, because it did
 * not: nothing on the backend recorded who invited whom, and rendering a lifetime-earnings figure
 * from mock data would have put invented money on a real logged-in page, two inches under a real
 * wallet balance, with no way for a player to tell them apart.
 *
 * There is now a referral ledger. Every figure below comes off /v1/referrals, which computes them
 * from the same `referrals` row the payout gate consults — so a bar that reaches the end of its
 * track and a bonus that actually paid are reading the same number. Nothing here is derived in
 * the browser, and nothing here is a projection.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS ALMOST NO PROSE ON IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The old page explained the programme in four bullet points before it showed the link. The
 * programme is one condition and one rate now, and both are rendered as state — a ruled list of
 * terms, and a progress bar per invite — rather than described.
 *
 * The bar is doing the real work. A referrer has one question about any given invite, "how far
 * along are they", and a progress row answers it faster than a sentence ever could.
 */
import { state, bus, refreshReferrals, setReferralCode } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

let root = null;
/* The invite code carried in on the URL, held until the sign-in card can send it.
 *
 * Somebody following a referral link is almost never logged in at the moment they arrive, and by
 * the time they are they have been through a payment round trip that replaces the URL. Holding it
 * here, and in session storage behind it, is what stops the code being lost between the two. */
let pendingCode = null;

export function mountReferrals(node) {
  root = $('#referRoot', node);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (!['login', 'logout', 'ready', 'referrals', 'private', 'promotions'].includes(event.detail)) return;
      paint();
    });
  }
  consumeDiscordReturn();
  paint();
}

/* ─────────── the invite link, arriving ───────────
 *
 * Read from the ordinary query string (`/?ref=ABC123`). Called on boot, so a code survives the
 * login round trip that almost always follows it.
 */
const REF_KEY = 'donutdrop:ref';
const REF_SHAPE = /^[A-Z0-9]{6,16}$/;
/* A code picked up from a link is kept this long in this browser, so signing up a few days after
 * following the link still counts. Longer than a session, shorter than forever. */
const REF_KEEP_MS = 30 * 86_400_000;
const cleanCode = (raw) => String(raw ?? '').trim().toUpperCase();

function rememberCode(code) {
  try { sessionStorage.setItem(REF_KEY, code); } catch { /* private browsing */ }
  try { localStorage.setItem(REF_KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* blocked */ }
}

function recallCode() {
  try {
    const session = cleanCode(sessionStorage.getItem(REF_KEY));
    if (REF_SHAPE.test(session)) return session;
  } catch { /* fall through to the longer-lived copy */ }
  try {
    const kept = JSON.parse(localStorage.getItem(REF_KEY) || 'null');
    if (kept && Date.now() - Number(kept.at) < REF_KEEP_MS && REF_SHAPE.test(cleanCode(kept.code))) {
      return cleanCode(kept.code);
    }
  } catch { /* nothing readable */ }
  return null;
}

/** The code is spent or can never be: stop carrying it. */
export function forgetReferralCode() {
  pendingCode = null;
  try { sessionStorage.removeItem(REF_KEY); } catch { /* nothing to clear */ }
  try { localStorage.removeItem(REF_KEY); } catch { /* nothing to clear */ }
}

export function captureReferralCode() {
  /* Any case: a link shared as `?ref=abc123` is the same invitation as `?ref=ABC123`. It used to
   * be dropped because the alphabet check ran on the raw value. */
  const fromLink = cleanCode(new URLSearchParams(location.search).get('ref'));
  if (REF_SHAPE.test(fromLink)) {
    pendingCode = fromLink;
    rememberCode(fromLink);
  } else if (!pendingCode) {
    pendingCode = recallCode();
  }
}

/**
 * A link's code, once somebody is signed in.
 *
 * An invite link only counts for a brand-new account, and for one it is already spent: the sign-up
 * took the code off the login challenge. So by the time anybody is signed in there is nothing left
 * to do with it, and it is dropped here instead of being carried about. A player who was ALREADY
 * registered and opened a link is told where their one entry lives, rather than being quietly
 * credited, which is what an invite link used to do for them.
 */
export async function settlePendingReferral() {
  if (!pendingCode || !state.authenticated) return;
  forgetReferralCode();
  const data = await refreshReferrals(false).catch(() => null);
  // Programme off, no answer, or a sign-up that used the code (it has an inviter now): nothing to say.
  if (!data || data.self?.referredBy) return;
  toast({
    kind: 'gold',
    title: 'Invite links are for new accounts',
    body: data.self?.codeEntry?.available
      ? 'You are already registered. You can enter one code in Settings.'
      : 'You are already registered, so this code was not applied.',
  });
}

/**
 * The code waiting to be spent, if any.
 *
 * Read by the sign-in card, which puts it in its own field and sends it with the login. Nothing
 * clears it here: the code is spent server-side inside the transaction that creates the account,
 * and this module never learns whether that happened. It is left in session storage and goes when
 * the tab does — harmless, because a code can only ever be redeemed by a signup, so a stale one
 * has nothing to attach itself to.
 */
export function pendingReferralCode() {
  return pendingCode;
}

/* setPendingReferralCode stood here.
 *
 * It stashed a code typed into the sign-in card so it could be attached after login. Nothing needs
 * that now: the card sends the code with the login itself, and the server keeps it on the challenge
 * row for the whole payment round trip — which survives a reload, where session storage did not.
 */


/* ─────────── coming back from Discord ───────────
 *
 * The API redirects to `/referrals?discord=<outcome>` and the outcome is announced once, then
 * stripped from the URL so a reload does not replay it.
 */
function consumeDiscordReturn() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('discord');
  if (!outcome) return;

  /* `unlocked` used to be one of these. Verifying Discord could complete the bonus gate, so the
     redirect could come back announcing a payment. The gate is the wager alone now, so that
     outcome can no longer be produced and an announcement for it would be unreachable code
     promising money. */
  const announcements = {
    verified: { kind: 'win', title: 'Discord verified' },
    taken: { kind: 'lose', title: 'Already linked', body: 'This account is on a different Discord' },
    // One Discord carries a main account and a few alts; this one was already full.
    limit: { kind: 'lose', title: 'Discord is full', body: 'Unlink an account with /accounts unlink first' },
    expired: { kind: 'lose', title: 'Link expired', body: 'Start the verification again' },
    failed: { kind: 'lose', title: 'Discord declined' },
  };
  const announcement = announcements[outcome];
  if (announcement) {
    toast(announcement);
    if (outcome === 'verified') playSound('coin');
  }

  params.delete('discord');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  // The verification landed on the server; the cached snapshot predates it.
  refreshReferrals().catch(() => undefined);
}

/* ─────────── render ─────────── */
function paint() {
  if (!root?.isConnected) return;
  root.replaceChildren();

  const data = state.referrals;

  if (!state.authenticated) {
    /* Signed out: the offer itself, from GET /v1/promotions, and the one button that takes it. The
     * line below stays for the moment before the terms arrive, or if they never do. */
    const terms = state.promotions?.referral;
    root.appendChild(terms ? publicOffer(terms) : gate('Log in to get your invite link.'));
    return;
  }
  if (!data) {
    root.appendChild(gate('Invites are not switched on yet.'));
    return;
  }
  /* Blocked from the programme: the link would recruit nobody and nothing could be claimed, so
   * the page says why and where to go rather than offering either. */
  if (data.self?.referralBlocked) {
    root.appendChild(blockedNotice());
    return;
  }

  /* Rebuilt 2026-11-11 (the owner: "https://donutluxe.com/referrals now", after the VIP and
   * statistics pages): the offer and the link side by side, the terms as a strip, what the player
   * has earned, then every invite with its progress. */
  const wrap = el('div', 'refer rf');
  const hero = el('section', 'rf__hero');
  hero.appendChild(pitch(data.terms));
  hero.appendChild(sharePanel(data));
  wrap.appendChild(hero);
  wrap.appendChild(termsStrip(data.terms));
  wrap.appendChild(statGrid(data));
  wrap.appendChild(inviteList(data));
  root.appendChild(wrap);
}

/** ", after the $100M that clears their own signup bonus": the invite bonus's wagering does not count. */
function notCounted() {
  const invite = state.promotions?.referralSignupBonus;
  return invite ? `, after the ${money(Number(invite.wagerMinor))} that clears their own signup bonus` : '';
}

const sharePercentOf = (terms) => (terms.revshareWagerBps / 100).toFixed(1);

/** The offer: the figure, then how it works in three steps. Every amount is the server's. */
function pitch(terms) {
  const box = el('div', 'rf__pitch');
  const eyebrow = el('span', 'rf__eyebrow');
  eyebrow.textContent = 'Invite & earn';
  const figure = el('div', 'rf__offer');
  const big = el('span', 'rf__figure');
  big.textContent = money(Number(terms.bonusMinor));
  const per = el('span', 'rf__per');
  per.textContent = 'per friend you invite';
  figure.append(big, per);
  box.append(eyebrow, figure);

  const invite = state.promotions?.referralSignupBonus;
  const steps = el('ol', 'rf__steps');
  for (const [title, text] of [
    ['Share your link', 'Send it to someone who has not played on DonutLuxe yet.'],
    [
      'They join and play',
      invite
        ? `They sign up on your link and get a ${money(Number(invite.amountMinor))} signup bonus.`
        : 'They sign up on your link and start playing.',
    ],
    [
      'You get paid',
      `${money(Number(terms.bonusMinor))} once they have wagered ${money(Number(terms.bonusWagerMinor))}${notCounted()}, plus ${sharePercentOf(terms)}% of everything they wager, for life.`,
    ],
  ]) {
    const step = el('li', 'rf__step');
    const h = el('b', 'rf__steptitle');
    h.textContent = title;
    const p = el('span', 'rf__steptext');
    p.textContent = text;
    step.append(h, p);
    steps.appendChild(step);
  }
  box.appendChild(steps);
  return box;
}

/** The link to copy, and the code behind it, in their own panel beside the offer. */
function sharePanel(data) {
  // The fields' own labels head the panel: 'Your invite link', then 'Your code'.
  const panel = el('div', 'rf__share');
  panel.appendChild(linkField(data));
  panel.appendChild(el('hr', 'refer__rule'));
  panel.appendChild(codeField(data));
  return panel;
}

/** The deal as four figures, signed in or not. */
function termsStrip(terms) {
  const strip = el('dl', 'rf__terms');
  const invite = state.promotions?.referralSignupBonus;
  for (const [label, value] of [
    ['Bonus', `${money(Number(terms.bonusMinor))} per invite`],
    ['Unlocks at', `${money(Number(terms.bonusWagerMinor))} wagered`],
    ['Revenue share', `${sharePercentOf(terms)}% of wagers, for life`],
    ...(invite ? [['Your friend gets', `${money(Number(invite.amountMinor))} signup bonus`]] : []),
  ]) {
    const cell = el('div', 'rf__term');
    const k = el('dt', 'rf__k');
    k.textContent = label;
    const v = el('dd', 'rf__v');
    v.textContent = value;
    cell.append(k, v);
    strip.appendChild(cell);
  }
  return strip;
}

/**
 * The same page for somebody not signed in: the deal, then the button that gets them a link.
 * Every figure is the server's: `terms` is GET /v1/promotions' referral block.
 */
function publicOffer(terms) {
  const wrap = el('div', 'refer rf');
  const hero = el('section', 'rf__hero');
  hero.appendChild(pitch(terms));
  const panel = el('div', 'rf__share rf__share--out');
  const title = el('h2', 'rf__sharetitle');
  title.textContent = 'Get your link';
  const line = el('p', 'rf__shareline');
  line.textContent = 'Log in with your Minecraft name and your personal invite link is ready straight away.';
  /* The luxe shell's gate button (luxe.js armGates), named for what it gets you. `lxgate` also
   * tells that function this card already has its button. */
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'lxbtn lxbtn--gold lxgate';
  go.textContent = 'Log in to get your link';
  go.addEventListener('click', () => $('#loginBtn')?.click());
  panel.append(title, line, go);
  hero.appendChild(panel);
  wrap.appendChild(hero);
  wrap.appendChild(termsStrip(terms));
  return wrap;
}

/** One icon from path data. SVG needs createElementNS; createElement puts it in the wrong namespace. */
function icon(...paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'refer__icon');
  for (const data of paths) {
    const node = document.createElementNS(NS, 'path');
    node.setAttribute('d', data);
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    svg.append(node);
  }
  return svg;
}

/**
 * The code, as something a player can choose.
 *
 * It is the same field as the link below it, one rung quieter: a code is set once and then ignored,
 * while the link is used every time somebody opens this page. Giving them identical weight would
 * have made the page look like two things to do rather than one thing to copy.
 *
 * The input is uppercased as it is typed rather than on submit, because the alphabet is uppercase
 * and a player who types `niklas` and sees `niklas` has been told nothing about the code they will
 * actually get. The save button stays disabled until the value is both valid and different, so the
 * one control on screen answers "is this claimable" without a round trip.
 */
function codeField(data) {
  const wrap = document.createDocumentFragment();

  const label = el('label', 'refer__label');
  label.textContent = 'Your code';
  label.htmlFor = 'referCode';

  const field = el('div', 'refer__field');
  field.appendChild(icon('M15 7h2a5 5 0 0 1 0 10h-2', 'M9 17H7A5 5 0 0 1 7 7h2', 'M8 12h8'));

  const input = document.createElement('input');
  input.className = 'refer__input';
  input.id = 'referCode';
  input.value = data.code;
  input.maxLength = 16;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-describedby', 'referCodeNote');

  const save = el('button', 'refer__copy');
  save.type = 'button';
  save.textContent = 'Save';
  save.disabled = true;

  const note = el('p', 'refer__note');
  note.id = 'referCodeNote';
  note.textContent = '6–16 letters and numbers. Old links keep working.';

  const valid = (value) => /^[A-Z0-9]{6,16}$/.test(value);
  const sync = () => {
    const value = input.value.toUpperCase();
    if (input.value !== value) input.value = value;
    save.disabled = !valid(value) || value === data.code;
  };
  input.addEventListener('input', sync);

  save.addEventListener('click', async () => {
    const value = input.value.toUpperCase();
    if (!valid(value)) return;
    save.disabled = true;
    save.textContent = 'Saving';
    try {
      await setReferralCode(value);
      playSound('coin');
      /* No toast and no success state to reset: the page repaints off the store the moment the
       * refresh lands, and the new code is already in the field and in the link below it. The
       * change IS the confirmation. */
    } catch (error) {
      save.textContent = 'Save';
      save.dataset.state = 'error';
      note.textContent = error?.message || 'That code could not be saved.';
      note.dataset.bad = '1';
      sync();
    }
  });

  field.append(input, save);
  wrap.append(label, field, note);
  return wrap;
}

/** The link, in the sign-in field, with the copy button inside the box it copies. */
function linkField(data) {
  const wrap = document.createDocumentFragment();

  const label = el('label', 'refer__label');
  label.textContent = 'Your invite link';
  label.htmlFor = 'referLink';

  const field = el('div', 'refer__field');
  field.appendChild(icon('M9 15l6-6', 'M11 6.5l1.5-1.5a3.5 3.5 0 0 1 5 5L16 11.5', 'M13 17.5L11.5 19a3.5 3.5 0 0 1-5-5L8 12.5'));

  const input = document.createElement('input');
  input.className = 'refer__input';
  input.id = 'referLink';
  input.readOnly = true;
  input.value = data.link;
  /* Selecting on focus means a player who cannot use the clipboard \u2014 an insecure origin, a
   * locked-down browser \u2014 still gets the link in one gesture plus Ctrl-C. */
  input.addEventListener('focus', () => input.select());

  const copy = el('button', 'refer__copy');
  copy.type = 'button';
  copy.textContent = 'Copy';

  let revert = null;
  const settle = (text, state_) => {
    copy.textContent = text;
    if (state_) copy.dataset.state = state_;
    else delete copy.dataset.state;
    clearTimeout(revert);
    revert = setTimeout(() => {
      copy.textContent = 'Copy';
      delete copy.dataset.state;
    }, 1800);
  };

  copy.addEventListener('click', async () => {
    /* The confirmation is the button itself, not a toast.
     *
     * The guidance is that a successful action must confirm rather than succeed silently, and a
     * copy is the case where WHERE the confirmation appears matters more than that it appears: the
     * player is already looking at the button they pressed, so a notification in the corner asks
     * them to look somewhere else to learn about something in front of them. */
    try {
      await navigator.clipboard.writeText(data.link);
      playSound('coin');
      settle('Copied', 'done');
    } catch {
      /* No clipboard \u2014 almost always an insecure origin or a permissions policy. Selecting the
       * text turns a dead end into one keystroke, and the button says which one. */
      input.focus();
      input.select();
      settle('Press Ctrl+C', 'error');
    }
  });

  field.append(input, copy);
  wrap.append(label, field);
  return wrap;
}

/** What a player an administrator blocked from invite rewards sees here, and how to dispute it.
 * The same-network check no longer blocks anybody: it voids the one invite, so it never lands here. */
function blockedNotice() {
  const wrap = gate('This account can’t earn invite rewards.');
  const line = el('p', 'refer__gate');
  line.append('Our team has stopped this account earning from invites. If you think that’s a mistake, ');
  const support = document.createElement('a');
  support.href = '/support';
  support.textContent = 'contact support';
  line.append(support, ' and we will look at it.');
  wrap.querySelector('.rf__gate')?.append(line);
  return wrap;
}

function gate(message) {
  const wrap = el('div', 'refer rf');
  const card = el('div', 'rf__gate');
  const title = el('h2', 'rf__gatetitle');
  title.textContent = 'Invite & earn';
  const line = el('p', 'refer__gate');
  line.textContent = message;
  card.append(title, line);
  wrap.appendChild(card);
  return wrap;
}

function statGrid(data) {
  const grid = el('div', 'rf__stats');
  const totals = data.totals;
  /* Earned is first and gold, because it is the only figure here somebody came to see. The two
   * counts after it are the pipeline that produced it, in the order an invite moves through. */
  const cells = [
    ['Earned from invites', money(Number(totals.earnedMinor)), true],
    ['Friends invited', String(totals.invites), false],
    ['Bonuses unlocked', String(totals.unlocked), false],
  ];
  for (const [key, value, gold] of cells) {
    const cell = el('div', 'rf__stat');
    const label = el('span', 'rf__k');
    label.textContent = key;
    const figure = el('span', `rf__statv${gold ? ' rf__statv--gold' : ''}`);
    figure.textContent = value;
    cell.append(label, figure);
    grid.appendChild(cell);
  }
  return grid;
}

function inviteList(data) {
  const wrap = el('section', 'rf__list');
  const head = el('div', 'rf__listhead');
  const title = el('h2', 'rf__h');
  title.textContent = 'Your invites';
  const count = el('span', 'rf__count');
  count.textContent = data.invites.length ? `${data.invites.length}` : '';
  head.append(title, count);
  wrap.appendChild(head);

  if (!data.invites.length) {
    const empty = el('div', 'rf__empty');
    empty.innerHTML = '<span class="rf__slot"><img src="assets/img/items/name_tag.png" alt="" width="28" height="28"></span>';
    const text = el('p');
    text.textContent = 'No invites yet. Anyone who signs up on your link shows up here, with how close they are to unlocking your bonus.';
    empty.appendChild(text);
    wrap.appendChild(empty);
    return wrap;
  }

  const milestone = Number(data.terms.bonusWagerMinor);
  const rows = el('div', 'rf__rows');
  for (const invite of data.invites) rows.appendChild(inviteRow(invite, milestone));
  wrap.appendChild(rows);
  return wrap;
}

function inviteRow(invite, milestone) {
  const row = el('div', 'rf__invite');
  row.dataset.unlocked = invite.bonusUnlocked ? '1' : '0';

  const who = el('div', 'rf__who');
  const name = el('span', 'rf__name');
  name.textContent = invite.username;
  const status = el('span', 'rf__status');
  status.textContent = invite.bonusUnlocked ? 'Bonus paid' : 'In progress';
  who.append(name, status);

  /* One figure, and it is everything this invite has earned: revenue share plus the bonus if it
   * landed. A referrer wants the total. */
  const paid = Number(invite.revshareEarnedMinor) + Number(invite.bonusPaidMinor ?? 0);
  const pays = el('span', 'rf__pays');
  pays.textContent = money(paid);

  const bar = el('div', 'rf__bar');
  const track = el('div', 'rf__track');
  const fill = el('div', 'rf__fill');
  const ratio = Math.min(1, Math.max(0, invite.wagerRatio));
  /* scaleX rather than width, so the animation runs on the compositor and the row cannot reflow
   * the rest of the list while it moves. */
  fill.style.transform = `scaleX(${ratio})`;
  track.appendChild(fill);

  /* Until the invitee has wagered off their own signup bonus, none of it counts toward this
   * bonus (GET /v1/referrals bonusWagerLeftMinor), so the bar says what is left of that instead. */
  const clearing = !invite.bonusUnlocked && Number(invite.bonusWagerLeftMinor ?? 0) > 0;
  const fraction = el('span', 'rf__frac');
  fraction.textContent = invite.bonusUnlocked
    ? 'Bonus paid · now earning revenue share'
    : clearing
      ? `Clearing their bonus: ${money(Number(invite.bonusWagerLeftMinor))} left`
      : `${money(Number(invite.wageredMinor))} / ${money(milestone)} wagered`;
  bar.append(track, fraction);

  row.append(who, bar, pays);
  return row;
}
