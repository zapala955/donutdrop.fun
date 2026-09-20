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
      if (!['login', 'logout', 'ready', 'referrals', 'private'].includes(event.detail)) return;
      paint();
    });
  }
  consumeDiscordReturn();
  paint();
}

/* ─────────── the invite link, arriving ───────────
 *
 * Read from the hash rather than from location.search, because the link is a hash route:
 * `#/?ref=ABC123`. Called on boot, so a code survives the login round trip that almost always
 * follows it.
 */
export function captureReferralCode() {
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
  const code = new URLSearchParams(query).get('ref');
  if (code && /^[A-Z0-9]{6,16}$/.test(code)) {
    pendingCode = code;
    try {
      // Survives a reload and the login redirect. Cleared the moment it is spent.
      sessionStorage.setItem('donutdrop:ref', code);
    } catch { /* private browsing; the in-memory copy still covers this session */ }
  } else if (!pendingCode) {
    try {
      const stored = sessionStorage.getItem('donutdrop:ref');
      if (stored && /^[A-Z0-9]{6,16}$/.test(stored)) pendingCode = stored;
    } catch { /* nothing to recover */ }
  }
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
 * The API redirects to `#/referrals?discord=<outcome>` and the outcome is announced once, then
 * stripped from the URL so a reload does not replay it.
 */
function consumeDiscordReturn() {
  const index = location.hash.indexOf('?');
  if (index < 0) return;
  const params = new URLSearchParams(location.hash.slice(index + 1));
  const outcome = params.get('discord');
  if (!outcome) return;

  /* `unlocked` used to be one of these. Verifying Discord could complete the bonus gate, so the
     redirect could come back announcing a payment. The gate is the wager alone now, so that
     outcome can no longer be produced and an announcement for it would be unreachable code
     promising money. */
  const announcements = {
    verified: { kind: 'win', title: 'Discord verified' },
    taken: { kind: 'lose', title: 'Already linked', body: 'That Discord is on another account' },
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
  history.replaceState(null, '', `${location.pathname}#/referrals${rest ? `?${rest}` : ''}`);
  // The verification landed on the server; the cached snapshot predates it.
  refreshReferrals().catch(() => undefined);
}

/* ─────────── render ─────────── */
function paint() {
  if (!root?.isConnected) return;
  root.replaceChildren();

  const data = state.referrals;

  /* Both empty states are the same card with one sentence in it, rather than a headline wrapped
   * around a dash. A large filled figure rendered around nothing reads as a component that failed
   * to load, which is the wrong impression on the one page that asks a player for their trust. */
  if (!state.authenticated) {
    root.appendChild(gate('Log in to get your invite link.'));
    return;
  }
  if (!data) {
    root.appendChild(gate('Invites are not switched on yet.'));
    return;
  }

  const wrap = el('div', 'refer');
  wrap.appendChild(offerCard(data));
  wrap.appendChild(statGrid(data));
  wrap.appendChild(inviteList(data));
  root.appendChild(wrap);
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
 * The card: the offer, the terms, and the link.
 *
 * In that order, deliberately. It is the order of a decision — what is on the table, what it
 * costs, how to take it, what is blocking it — and it is the same order the sign-in card walks:
 * say what this is, then show the one field, then the one button.
 */
function offerCard(data) {
  const card = el('div', 'refer__card');
  const terms = data.terms;
  const sharePercent = (terms.revshareWagerBps / 100).toFixed(1);

  const title = el('h2', 'refer__title');
  title.textContent = 'Invite \u0026 earn';
  const lede = el('p', 'refer__lede');
  lede.textContent =
    'Send your link to someone who has not played here yet. Once they have wagered the amount'
    + ` below, the bonus lands in your wallet \u2014 and ${sharePercent}% of everything they wager keeps building`
    + ' in Rewards for you to claim.';
  card.append(title, lede);

  /* The headline figure, and nothing beside it. */
  const offer = el('div', 'refer__offer');
  const figure = el('span', 'refer__figure');
  figure.textContent = money(Number(terms.bonusMinor));
  const caption = el('span', 'refer__caption');
  caption.textContent = 'per invite';
  offer.append(figure, caption);
  card.appendChild(offer);

  /* The deal as a ruled list. Every figure is the server\u0027s \u2014 there is no amount written into
   * this file, because the last invite figure that was hardcoded went stale and the site
   * advertised a bonus it had stopped paying. */
  const list = el('dl', 'refer__terms');
  for (const [label, value] of [
    ['Bonus', `${money(Number(terms.bonusMinor))}, once per invite`],
    ['Unlocks at', `${money(Number(terms.bonusWagerMinor))} wagered`],
    ['Revenue share', `${sharePercent}% of wagers for life`],
  ]) {
    const key = el('dt', 'refer__termk');
    key.textContent = label;
    const val = el('dd', 'refer__termv');
    val.textContent = value;
    list.append(key, val);
  }
  card.appendChild(list);

  card.appendChild(el('hr', 'refer__rule'));
  card.appendChild(codeField(data));
  card.appendChild(linkField(data));
  /* The Discord block stood here. It was on this page because verification was half the gate; the
   * gate is the wager alone now, so a verification card would be asking for a step that buys the
   * player nothing. Discord verification still exists on the account — it is simply not part of
   * this deal any more, and a page that kept advertising it would be selling a condition it does
   * not have. */
  return card;
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

function gate(message) {
  const wrap = el('div', 'refer');
  const card = el('div', 'refer__card');
  const title = el('h2', 'refer__title');
  title.textContent = 'Invite \u0026 earn';
  const line = el('p', 'refer__gate');
  line.textContent = message;
  card.append(title, line);
  wrap.appendChild(card);
  return wrap;
}

function statGrid(data) {
  const grid = el('div', 'refer__grid');
  const totals = data.totals;
  /* Earned is first and gold, because it is the only figure here somebody came to see. The two
   * counts after it are the pipeline that produced it, in the order an invite moves through.
   *
   * "Verified" used to sit between them, counting referees who had linked Discord. It was there
   * because verification gated the bonus; it does not any more, so the column was measuring
   * something that no longer decides anything — which on a page about getting paid is just a
   * number to misread. */
  const cells = [
    ['Earned', money(Number(totals.earnedMinor)), true],
    ['Invites', String(totals.invites), false],
    ['Unlocked', String(totals.unlocked), false],
  ];
  for (const [key, value, gold] of cells) {
    const cell = el('div', 'refer__stat');
    const label = el('span', 'refer__statk');
    label.textContent = key;
    const figure = el('span', `refer__statv${gold ? ' refer__statv--gold' : ''}`);
    figure.textContent = value;
    cell.append(label, figure);
    grid.appendChild(cell);
  }
  return grid;
}

function inviteList(data) {
  const wrap = el('div', 'refer__invites');
  if (!data.invites.length) {
    const empty = el('p', 'refer__empty');
    empty.textContent = 'No invites yet. Anyone who signs up on your link shows up here.';
    wrap.appendChild(empty);
    return wrap;
  }

  const milestone = Number(data.terms.bonusWagerMinor);
  for (const invite of data.invites) {
    wrap.appendChild(inviteRow(invite, milestone));
  }
  return wrap;
}

function inviteRow(invite, milestone) {
  const row = el('div', 'refer__invite');
  row.dataset.unlocked = invite.bonusUnlocked ? '1' : '0';

  const who = el('div', 'refer__who');
  const name = el('span', 'refer__name');
  name.textContent = invite.username;
  /* A Discord pill sat beside the name. With the gate down to one condition the row already says
   * everything there is to say about this invite: how far along the bar is, and whether the left
   * edge has gone gold. */
  who.append(name);

  /* One figure, and it is everything this invite has earned \u2014 claimed and waiting revenue share
   * plus the bonus if it landed. Splitting them into two columns made the row read as a
   * statement; a referrer wants the total. */
  const paid = Number(invite.revshareEarnedMinor) + Number(invite.bonusPaidMinor ?? 0);
  const pays = el('span', 'refer__pays');
  pays.textContent = money(paid);

  const bar = el('div', 'refer__bar');
  const track = el('div', 'refer__track');
  const fill = el('div', 'refer__fill');
  const ratio = Math.min(1, Math.max(0, invite.wagerRatio));
  /* scaleX rather than width, so the animation runs on the compositor and the row cannot reflow
   * the rest of the list while it moves. */
  fill.style.transform = `scaleX(${ratio})`;
  track.appendChild(fill);

  const fraction = el('span', 'refer__frac');
  fraction.textContent = invite.bonusUnlocked
    ? 'Bonus paid'
    : `${money(Number(invite.wageredMinor))} / ${money(milestone)}`;
  bar.append(track, fraction);

  row.append(who, pays, bar);
  return row;
}
