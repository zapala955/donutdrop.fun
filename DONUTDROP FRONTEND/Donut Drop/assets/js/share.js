/* share.js — win cards: one of your wins, shared as a link that previews as a picture of it.
 *
 * The card is drawn by the server from the round as the database holds it (routes/shares.ts), and
 * whoever follows the link arrives on your invite code. This only asks for the link and shows what
 * comes back, so nothing here can make a card say something the round did not.
 *
 * Offered for a win of 5x or better, or $10M or more of profit. The server applies the same rule
 * (lib/win-shares.ts) and is what decides; this only keeps the button off rounds it would refuse.
 *
 * Three ways in: the history page (every qualifying win has a Share button), a prompt that appears
 * after a qualifying win (winfx.js finds it on the live feed), and the banner a visitor arriving on
 * somebody's link is shown (initShareLanding). */
import { api } from './api.js';
import { state } from './store.js';
import { openModal, toast } from './ui.js';
import { el, money } from './util.js';

const MIN_MULTIPLIER = 5;
const MIN_PROFIT = 10_000_000;
const PROMPT_MS = 12_000;
const SHARE_ID = /^[A-HJ-NP-Z2-9]{8}$/;

/** Whether a round of yours can be shared. Never in test mode: play money is not a win to show. */
export function isShareable(wager, payout) {
  if (state.user?.testMode?.active) return false;
  return wager > 0 && payout > wager && (payout >= wager * MIN_MULTIPLIER || payout - wager >= MIN_PROFIT);
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
 * After a qualifying win: a prompt in the corner for a few seconds. The live feed and the history
 * name a round differently, so the click finds it in the history by its bet and payout, newest
 * first, which is the round that was just celebrated.
 */
export function offerShare(wager, payout) {
  const wrap = document.querySelector('#toasts');
  if (!wrap) return;
  wrap.querySelector('.share-prompt')?.remove();
  const prompt = el('div', 'toast toast--gold share-prompt');
  prompt.setAttribute('role', 'status');
  const copy = el('div');
  const heading = el('b');
  heading.textContent = `You won ${money(payout)}`;
  const button = el('button', 'btn btn--go share-prompt__go');
  button.type = 'button';
  button.textContent = 'Share this win';
  button.addEventListener('click', async () => {
    button.disabled = true;
    prompt.remove();
    try {
      const page = await api.get('/v1/history?limit=20');
      const round = (page.rounds || []).find(
        (row) => Number(row.wagerMinor) === wager && Number(row.payoutMinor) === payout,
      );
      if (!round) {
        toast({ title: 'That round is not in your history yet', body: 'Share it from your history in a moment.', kind: 'lose' });
        return;
      }
      await shareRound(round.game, round.id);
    } catch (error) {
      toast({ title: 'That win could not be shared', body: error?.message || '', kind: 'lose' });
    }
  });
  copy.append(heading, button);
  prompt.appendChild(copy);
  wrap.appendChild(prompt);
  setTimeout(() => prompt.remove(), PROMPT_MS);
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
 * joining on an invite. Never whose: a share carries no name. The code itself is kept by
 * referrals.js, as for any invite link.
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
      body: share.invite ? `${round} You are joining with this player's invite.` : round,
      kind: 'gold',
      ttl: 9000,
    });
  } catch {
    // A link to a share that is gone still lands on the site; there is just nothing to say about it.
  }
}
