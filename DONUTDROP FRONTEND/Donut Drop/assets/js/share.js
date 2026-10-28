/* share.js — win cards: one of your wins, shared as a link that previews as a picture of it.
 *
 * The card is drawn by the server from the round as the database holds it (routes/shares.ts), and
 * whoever follows the link arrives on your invite code. This only asks for the link and shows what
 * comes back, so nothing here can make a card say something the round did not.
 *
 * Any win can be shared (lib/win-shares.ts decides); the site offers it unasked only for a win worth
 * showing off, 5x or better or $10M or more of profit, so an ordinary win is not interrupted.
 *
 * Three ways in: the history page (a Share button on every win), a bar that appears after a big win
 * (winfx.js finds it on the live feed), and the note a visitor arriving on somebody's link is shown
 * (initShareLanding). */
import { api } from './api.js';
import { state } from './store.js';
import { openModal, toast } from './ui.js';
import { el, money } from './util.js';

const MIN_MULTIPLIER = 5;
const MIN_PROFIT = 10_000_000;
const OFFER_MS = 12_000;
const SHARE_ID = /^[A-HJ-NP-Z2-9]{8}$/;

/** Whether a round of yours can be shared: any win. Never in test mode: play money is not a win to show. */
export function isShareable(wager, payout) {
  if (state.user?.testMode?.active) return false;
  return wager > 0 && payout > wager;
}

/** Whether a win is worth offering a card for unasked, the moment it lands. */
export function isWorthOffering(wager, payout) {
  return isShareable(wager, payout) && (payout >= wager * MIN_MULTIPLIER || payout - wager >= MIN_PROFIT);
}

/** The multiplier as the history writes it: rounded down to the hundredth, trailing zeros dropped. */
function multiplierText(wager, payout) {
  return `${(Math.floor((payout / wager) * 100) / 100).toString()}×`;
}

/** Makes the link for one of your rounds (or fetches the one already made) and opens the card. */
export async function shareRound(game, id) {
  let share;
  try {
    share = await api.post('/v1/shares', { game, id });
  } catch (error) {
    toast({ title: 'That win could not be shared', body: error?.message || '', kind: 'lose' });
    return;
  }
  openShareCard(share);
}

/**
 * After a big win: a slim bar at the foot of the screen, above the phone's dock, for a few seconds.
 * One line of what was won, a Share button, a close button; it waits while the pointer or the focus
 * is on it. It used to be a toast with a full-size button stuffed inside it, top right on a desktop
 * and wedged over the page on a phone.
 *
 * The live feed and the history name a round differently, so Share finds it in the history by its
 * bet and payout, newest first, which is the round that was just celebrated.
 */
export function offerShare({ wager, payout, sourceName }) {
  document.querySelector('.sharebar')?.remove();
  const bar = el('div', 'sharebar');
  bar.setAttribute('role', 'status');

  const copy = el('div', 'sharebar__copy');
  const won = el('b');
  won.textContent = `You won ${money(payout)}`;
  const detail = el('span');
  detail.textContent = sourceName ? `${multiplierText(wager, payout)} on ${sourceName}` : multiplierText(wager, payout);
  copy.append(won, detail);

  const go = el('button', 'sharebar__go');
  go.type = 'button';
  go.textContent = 'Share';
  const close = el('button', 'sharebar__x');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  let timer = 0;
  const leave = () => {
    clearTimeout(timer);
    bar.classList.add('is-leaving');
    setTimeout(() => bar.remove(), 180);
  };
  const wait = () => { clearTimeout(timer); timer = setTimeout(leave, OFFER_MS); };
  bar.addEventListener('pointerenter', () => clearTimeout(timer));
  bar.addEventListener('pointerleave', wait);
  bar.addEventListener('focusin', () => clearTimeout(timer));
  bar.addEventListener('focusout', wait);
  close.addEventListener('click', leave);

  go.addEventListener('click', async () => {
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.textContent = 'Opening';
    try {
      const page = await api.get('/v1/history?limit=20');
      const round = (page.rounds || []).find(
        (row) => Number(row.wagerMinor) === wager && Number(row.payoutMinor) === payout,
      );
      leave();
      if (!round) {
        toast({ title: 'That round is not in your history yet', body: 'Share it from your history in a moment.', kind: 'lose' });
        return;
      }
      await shareRound(round.game, round.id);
    } catch (error) {
      leave();
      toast({ title: 'That win could not be shared', body: error?.message || '', kind: 'lose' });
    }
  });

  bar.append(copy, go, close);
  document.body.appendChild(bar);
  wait();
}

function openShareCard(share) {
  openModal('Share your win', (body) => {
    const card = el('img', 'share__card');
    card.src = share.imageUrl;
    card.alt = share.title;
    card.width = 1200;
    card.height = 630;

    const link = el('input', 'share__link');
    link.type = 'text';
    link.readOnly = true;
    link.value = share.url;
    link.setAttribute('aria-label', 'Your link');
    link.addEventListener('focus', () => link.select());

    const actions = el('div', 'share__actions');
    if (typeof navigator.share === 'function') {
      const native = el('button', 'btn btn--go');
      native.type = 'button';
      native.textContent = 'Share';
      native.addEventListener('click', () => shareNatively(share));
      actions.appendChild(native);
    }
    const copy = el('button', `btn ${typeof navigator.share === 'function' ? 'btn--glass' : 'btn--go'}`);
    copy.type = 'button';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(share.url);
        copy.textContent = 'Copied';
      } catch {
        link.focus();
        copy.textContent = 'Press Ctrl+C';
      }
    });
    const save = el('button', 'btn btn--glass');
    save.type = 'button';
    save.textContent = 'Save image';
    save.addEventListener('click', () => saveImage(share));
    actions.append(copy, save);

    const note = el('p', 'share__note');
    note.textContent = 'Anyone who signs up from your link joins on your invite.';
    body.append(card, link, actions, note);
  }, { variant: 'share' });
}

async function cardFile(share) {
  const response = await fetch(share.imageUrl);
  if (!response.ok) throw new Error('the card could not be fetched');
  return new File([await response.blob()], `donutluxe-win-${share.id}.png`, { type: 'image/png' });
}

/** The phone's own share sheet: the picture and the link where the platform takes both. */
async function shareNatively(share) {
  try {
    const file = await cardFile(share).catch(() => null);
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: share.title, text: `${share.title} ${share.url}` });
    } else {
      await navigator.share({ title: share.title, text: share.title, url: share.url });
    }
  } catch (error) {
    // Closing the sheet is not a failure.
    if (error?.name !== 'AbortError') toast({ title: 'Sharing did not work', body: 'Copy the link instead.', kind: 'lose' });
  }
}

async function saveImage(share) {
  try {
    const file = await cardFile(share);
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast({ title: 'The image could not be saved', body: 'Open it and save it from there.', kind: 'lose' });
    window.open(share.imageUrl, '_blank', 'noopener');
  }
}

/**
 * Somebody arrived on a shared win (`/?ref=ABC123&win=K7P2QX`): show them the win, and that they are
 * joining on an invite. No name: the masked one is on the card, and in a sentence the stars read
 * badly. The code itself is kept by referrals.js, as for any invite link.
 */
export async function initShareLanding() {
  const params = new URLSearchParams(location.search);
  const id = params.get('win');
  if (!id) return;
  params.delete('win');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  if (!SHARE_ID.test(id)) return;
  try {
    const share = await api.get(`/v1/shares/${id}`);
    const round = `${share.multiplier} on a ${money(Number(share.wagerMinor))} bet.`;
    toast({
      title: share.title,
      body: share.invite ? `${round} You are joining with an invite.` : round,
      kind: 'gold',
      ttl: 9000,
    });
  } catch {
    // A link to a share that is gone still lands on the site; there is just nothing to say about it.
  }
}
