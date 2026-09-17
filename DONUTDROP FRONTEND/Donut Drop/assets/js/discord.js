/* discord.js — the verification portal.
 *
 * One card, one status, one button. The Discord link is not a feature in its own right: it is one
 * of the two conditions that unlock the referral bonus, so the page's job is to show which of the
 * two conditions are met and hand over the OAuth trigger.
 *
 * The verification state comes off /v1/referrals, not from a second endpoint. Verification is a
 * property of the account that only matters in the referral programme's terms, and giving the
 * page its own source for the same fact would let the two disagree by exactly one refresh.
 */
import { state, bus, refreshReferrals, startDiscordVerification } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';

let root = null;
let starting = false;

export function mountDiscord(view) {
  root = $('#discordRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'private', 'referrals'].includes(event.detail)) paint();
    });
  }
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to link a Discord account.'));
    return;
  }
  const data = state.referrals;
  if (!data) {
    root.appendChild(notice('Discord verification is not switched on yet.'));
    return;
  }

  const verified = !!data.self.discordVerified;
  root.appendChild(statusCard(data, verified));
  root.appendChild(unlockCard(data, verified));
}

function notice(message) {
  const card = el('div', 'dsync__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function statusCard(data, verified) {
  const card = el('section', 'dsync__card');
  card.dataset.on = verified ? '1' : '0';

  const row = el('div', 'dsync__row');
  const label = el('span', 'dsync__label');
  label.textContent = 'Discord linked';
  const badge = el('span', 'dsync__badge');
  badge.dataset.on = verified ? '1' : '0';
  badge.textContent = verified ? 'YES' : 'NO';
  row.append(label, badge);
  card.appendChild(row);

  if (verified) {
    const handle = el('b', 'dsync__handle mono');
    handle.textContent = data.self.discordUsername || 'linked';
    card.appendChild(handle);
  } else {
    const button = el('button', 'btn btn--go dsync__go');
    button.type = 'button';
    button.textContent = starting ? 'OPENING…' : '🎮 CONNECT DISCORD';
    button.disabled = starting;
    button.addEventListener('click', connect);
    card.appendChild(button);
  }
  return card;
}

/* The two conditions, as a checklist. This is the anchor the whole page exists for: a player who
 * has verified but not wagered, or wagered but not verified, needs to see which half is missing
 * without reading a paragraph about it. */
function unlockCard(data, verified) {
  const card = el('section', 'dsync__unlock');

  const head = el('div', 'dsync__row');
  const label = el('span', 'dsync__label');
  label.textContent = 'Referral bonus';
  const prize = el('b', 'dsync__prize mono');
  prize.textContent = money(Number(data.terms.bonusMinor));
  head.append(label, prize);
  card.appendChild(head);

  const list = el('div', 'dsync__conds');
  const milestone = Number(data.terms.bonusWagerMinor);
  const wagered = Number(data.self.ownWagerMinor ?? '0');

  list.appendChild(condition('Discord verified', verified, verified ? 'DONE' : 'PENDING'));
  list.appendChild(
    condition(
      'Wagered',
      wagered >= milestone,
      `${money(wagered)} / ${money(milestone)}`,
      milestone > 0 ? Math.min(1, wagered / milestone) : 0,
    ),
  );
  card.appendChild(list);

  /* Who this actually pays. A referee is the one doing the verifying, but the bonus goes to the
   * person who invited them, and a page that does not say so reads as a broken promise. */
  if (data.self.referredBy) {
    const payee = el('span', 'dsync__payee mono');
    payee.textContent = `→ ${data.self.referredBy}`;
    card.appendChild(payee);
  }
  return card;
}

function condition(label, met, value, ratio = null) {
  const row = el('div', 'dsync__cond');
  row.dataset.met = met ? '1' : '0';

  const tick = el('span', 'dsync__tick');
  tick.setAttribute('aria-hidden', 'true');
  tick.textContent = met ? '✓' : '·';

  const name = el('span', 'dsync__condname');
  name.textContent = label;

  const figure = el('span', 'dsync__condval mono');
  figure.textContent = value;

  row.append(tick, name, figure);

  if (ratio !== null) {
    const track = el('div', 'dsync__track');
    const fill = el('div', 'dsync__fill');
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
    track.appendChild(fill);
    row.appendChild(track);
  }
  return row;
}

async function connect() {
  if (starting) return;
  starting = true;
  paint();
  try {
    // A top-level navigation rather than a popup: a popup opened after an await is blocked by
    // default, and OAuth in a blocked window fails without saying anything.
    location.href = await startDiscordVerification();
  } catch (error) {
    starting = false;
    toast({
      kind: 'lose',
      title: 'Cannot start verification',
      body: error?.message || 'Try again shortly.',
    });
    await refreshReferrals(false).catch(() => undefined);
    paint();
  }
}
