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
 * programme has two conditions and one rate; all three are now rendered as state — a pill, a bar,
 * a figure — and the single sentence that survives sits behind the info icon in the heading.
 *
 * The bar is doing the real work. A referrer's only two questions are "has this person verified"
 * and "how far along are they", and both are answers a progress row gives faster than a sentence
 * ever could.
 */
import { state, bus, refreshReferrals, attachReferralCode, startDiscordVerification } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

let root = null;
/* The invite code carried in on the URL, held until there is a session to attach it to. Somebody
 * following a referral link is almost never logged in at the moment they arrive, so binding it
 * eagerly would drop it for exactly the people it exists for. */
let pendingCode = null;
let attaching = false;

export function mountReferrals(node) {
  root = $('#referRoot', node);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (!['login', 'logout', 'ready', 'referrals', 'private'].includes(event.detail)) return;
      /* A held code is spent the moment a session and a snapshot both exist, which is normally
       * the 'private' tick after login rather than anything this page did. */
      flushPendingCode();
      paint();
    });
  }
  consumeDiscordReturn();
  flushPendingCode();
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

async function flushPendingCode() {
  if (!pendingCode || attaching || !state.authenticated || !state.referrals) return;
  // Already attached to somebody. The backend refuses a second referrer anyway; not asking keeps
  // a pointless 409 out of the console every time this page is opened.
  if (state.referrals.self?.referredBy) { clearPendingCode(); return; }
  if (pendingCode === state.referrals.code) { clearPendingCode(); return; }

  attaching = true;
  try {
    await attachReferralCode(pendingCode);
    playSound('coin');
    toast({ kind: 'win', title: 'Invite accepted', body: `Code ${pendingCode}` });
    clearPendingCode();
  } catch (error) {
    // A code that is already spent or unknown is not worth retrying on every mount.
    if (['REFERRAL_ALREADY_SET', 'REFERRAL_CODE_UNKNOWN', 'REFERRAL_SELF'].includes(error?.code)) {
      clearPendingCode();
    }
  } finally {
    attaching = false;
    paint();
  }
}

function clearPendingCode() {
  pendingCode = null;
  try { sessionStorage.removeItem('donutdrop:ref'); } catch { /* nothing held */ }
}

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

  const announcements = {
    verified: { kind: 'win', title: 'Discord verified' },
    unlocked: { kind: 'gold', title: 'Bonus unlocked', body: 'Paid to your balance' },
    taken: { kind: 'lose', title: 'Already linked', body: 'That Discord is on another account' },
    expired: { kind: 'lose', title: 'Link expired', body: 'Start the verification again' },
    failed: { kind: 'lose', title: 'Discord declined' },
  };
  const announcement = announcements[outcome];
  if (announcement) {
    toast(announcement);
    if (outcome === 'verified' || outcome === 'unlocked') playSound('coin');
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
  root.innerHTML = '';

  const data = state.referrals;

  /* No headline when there is no figure to put in it. The badge is a large filled pill; rendering
   * it around a dash reads as a component that failed to load rather than as a page waiting for a
   * session, which is exactly the wrong impression on the one page that asks for trust. */
  if (!state.authenticated) {
    root.appendChild(gate('Log in to get your invite link.'));
    return;
  }
  if (!data) {
    root.appendChild(gate('Invites are not switched on yet.'));
    return;
  }

  root.appendChild(hero(data.terms));
  root.appendChild(statGrid(data));
  root.appendChild(linkCard(data));

  const verify = discordCard(data);
  if (verify) root.appendChild(verify);

  root.appendChild(inviteList(data));
}

/* The headline figure. It is the direct bonus and nothing else: the lifetime revenue share has no
 * ceiling to quote, so putting a number on the badge for it would mean inventing one.
 *
 * Only ever called with real terms — the empty states render a plain card instead. */
function hero(terms) {
  const wrap = el('div', 'refer__hero');
  const badge = el('span', 'refer__badge');
  badge.textContent = `${money(Number(terms.bonusMinor))} per invite`;

  const sentence =
    `Paid once per invite, when they verify Discord and wager ${money(Number(terms.bonusWagerMinor))}.`
    + ` The ${(terms.revshareBps / 100).toFixed(1)}% revenue share runs for life alongside it.`;
  const tip = el('button', 'ihint');
  tip.type = 'button';
  tip.dataset.tip = sentence;
  // The bubble is CSS-generated content, so the accessible name carries the same sentence.
  tip.setAttribute('aria-label', sentence);
  badge.appendChild(tip);

  wrap.appendChild(badge);
  return wrap;
}

function gate(message) {
  const card = el('div', 'refer__link');
  const line = el('p', 'refer__gate');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function statGrid(data) {
  const grid = el('div', 'refer__grid');
  const totals = data.totals;
  /* Earned is first and gold, because it is the only figure here somebody came to see. The three
   * counts after it are the pipeline that produced it, in the order an invite moves through. */
  const cells = [
    ['Earned', money(Number(totals.earnedMinor)), true],
    ['Invites', String(totals.invites), false],
    ['Verified', String(totals.verified), false],
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

function linkCard(data) {
  const card = el('div', 'refer__link');
  const label = el('span', 'refer__label');
  label.textContent = 'Your invite link';
  card.appendChild(label);

  const row = el('div', 'refer__row');
  const field = document.createElement('input');
  field.className = 'refer__field mono';
  field.readOnly = true;
  field.value = data.link;
  field.addEventListener('focus', () => field.select());

  const copy = el('button', 'btn btn--go refer__copy');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.link);
      playSound('coin');
      toast({ kind: 'win', title: 'Link copied' });
    } catch {
      field.select();
      toast({ kind: 'lose', title: 'Copy it manually', body: 'Your browser blocked the clipboard.' });
    }
  });
  row.append(field, copy);
  card.appendChild(row);
  return card;
}

/* The caller's own half of the deal.
 *
 * Shown only when it is actionable — an unverified account, or one whose verification is holding
 * up somebody else's bonus. A player who has already verified does not need a card telling them
 * so; the pill on their own row says it if they look.
 */
function discordCard(data) {
  const self = data.self;
  if (self.discordVerified && !self.referredBy) return null;

  const card = el('div', 'refer__link');
  const label = el('span', 'refer__label');
  label.textContent = 'Discord';
  card.appendChild(label);

  const row = el('div', 'refer__row');
  const pill = el('span', 'refer__pill');
  pill.dataset.on = self.discordVerified ? '1' : '0';
  pill.textContent = self.discordVerified ? 'Verified' : 'Unverified';
  row.appendChild(pill);

  if (self.discordVerified) {
    const name = el('span', 'refer__frac');
    name.textContent = self.discordUsername || '';
    row.appendChild(name);
  } else {
    const button = el('button', 'btn btn--go');
    button.type = 'button';
    button.textContent = 'Verify';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        // A top-level navigation rather than a popup: popups are blocked by default on a click
        // that went through an await, and OAuth in a blocked window fails silently.
        location.href = await startDiscordVerification();
      } catch (error) {
        button.disabled = false;
        toast({
          kind: 'lose',
          title: 'Cannot start verification',
          body: error?.message || 'Try again shortly.',
        });
      }
    });
    row.appendChild(button);
  }
  card.appendChild(row);
  return card;
}

function inviteList(data) {
  const wrap = el('div', 'refer__invites');
  if (!data.invites.length) {
    const empty = el('p', 'refer__empty');
    empty.textContent = 'No invites yet.';
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
  const discord = el('span', 'refer__pill');
  discord.dataset.on = invite.discordVerified ? '1' : '0';
  discord.textContent = invite.discordVerified ? 'Verified' : 'Pending';
  who.append(name, discord);

  /* One figure, and it is everything this invite has actually paid — the running revenue share
   * plus the bonus if it landed. Splitting them into two columns made the row read as a
   * statement; a referrer wants the total. */
  const paid = Number(invite.revshareEarnedMinor) + Number(invite.bonusPaidMinor ?? 0);
  const pays = el('span', 'refer__pays');
  pays.textContent = money(paid);

  const bar = el('div', 'refer__bar');
  const track = el('div', 'refer__track');
  const fill = el('div', 'refer__fill');
  // scaleX rather than width, so the animation runs on the compositor and the row cannot reflow
  // the rest of the list while it moves.
  fill.style.transform = `scaleX(${Math.min(1, Math.max(0, invite.wagerRatio))})`;
  track.appendChild(fill);

  const fraction = el('span', 'refer__frac');
  fraction.textContent = `${money(Number(invite.wageredMinor))} / ${money(milestone)}`;
  bar.append(track, fraction);

  row.append(who, pays, bar);
  return row;
}
