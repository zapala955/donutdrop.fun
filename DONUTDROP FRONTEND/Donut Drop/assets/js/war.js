/* war.js — the faction war room.
 *
 * Three sides, one pool, seven days. Every bar and every leaderboard row is server-computed from
 * the contribution ledger; the browser does no arithmetic on shares beyond turning a ratio into a
 * width, because a leaderboard the client can compute is a leaderboard the client can be wrong
 * about.
 */
import { state, bus, refreshWar, joinFaction } from './store.js';
import { $, el, money } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';

let root = null;
let clockTimer = 0;

export function mountWar(view) {
  root = $('#warRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', () => {
      if (root.isConnected) paint();
    });
    if (state.authenticated) refreshWar().catch(() => undefined);
  }
  paint();
  startClock();
}

function startClock() {
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = window.setInterval(() => {
    const label = $('#warClock', root ?? document);
    if (!label || !label.isConnected) {
      window.clearInterval(clockTimer);
      clockTimer = 0;
      return;
    }
    const endsAt = state.war?.event?.endsAt;
    label.textContent = endsAt ? remaining(new Date(endsAt)) : '—';
  }, 1000);
}

function remaining(endsAt) {
  const left = Math.max(0, endsAt.getTime() - Date.now());
  if (left === 0) return 'ended';
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function paint() {
  if (!root?.isConnected) return;

  if (!state.authenticated) {
    root.innerHTML = `<section class="card"><h2 class="card__h">Log in to enter the war</h2>
      <p class="card__p">Pick a side and every wager you place counts toward its total.</p></section>`;
    return;
  }

  const war = state.war;
  if (!war?.event) {
    root.innerHTML = `<section class="card"><h2 class="card__h">No war is running</h2>
      <p class="card__p">The next season has not started yet. Check back soon.</p></section>`;
    return;
  }

  const { event, factions, membership, leaderboard } = war;
  const joined = membership ? factions.find((f) => f.id === membership.factionId) : null;

  root.innerHTML = `
    <section class="warhead glass">
      <div class="warhead__main">
        <span class="warhead__label">${escapeText(event.name)}</span>
        <b class="warhead__pool mono">${money(Number(event.prizePoolMinor))}</b>
        <span class="warhead__sub">${escapeText(event.description)}</span>
      </div>
      <div class="warhead__clock">
        <span class="warhead__clocklabel">Ends in</span>
        <b class="mono" id="warClock">${remaining(new Date(event.endsAt))}</b>
        <span class="warhead__total mono">${money(Number(event.totalContributedMinor))} contributed</span>
      </div>
    </section>

    <section class="card">
      <h2 class="card__h">The three sides ${joined ? `<span>You fight for ${escapeText(joined.name)}</span>` : '<span>Pick one — it is permanent</span>'}</h2>
      <div class="factions" id="factionGrid"></div>
    </section>

    <section class="card">
      <h2 class="card__h">Top contributors <span>${leaderboard.length} ranked</span></h2>
      <div class="board" id="warBoard"></div>
    </section>`;

  paintFactions($('#factionGrid', root), factions, membership);
  paintBoard($('#warBoard', root), leaderboard, factions);
}

function paintFactions(mount, factions, membership) {
  if (!mount) return;
  mount.innerHTML = '';

  factions.forEach((faction) => {
    const mine = membership?.factionId === faction.id;
    const card = el('article', 'faction');
    card.style.setProperty('--team', faction.color);
    card.dataset.mine = mine ? '1' : '0';

    card.innerHTML = `
      <header class="faction__head">
        <h3 class="faction__name">${escapeText(faction.name)}</h3>
        ${mine ? '<span class="faction__badge">YOUR SIDE</span>' : ''}
      </header>
      <p class="faction__blurb">${escapeText(faction.blurb)}</p>
      <div class="faction__bar"><i style="width:${(faction.share * 100).toFixed(2)}%"></i></div>
      <div class="faction__figs">
        <span class="faction__fig"><i>Share</i><b class="mono">${(faction.share * 100).toFixed(1)}%</b></span>
        <span class="faction__fig"><i>Total</i><b class="mono">${money(Number(faction.totalMinor))}</b></span>
        <span class="faction__fig"><i>Members</i><b class="mono">${faction.memberCount}</b></span>
      </div>
      <button class="btn ${mine ? '' : 'btn--go'} faction__join" type="button" ${membership ? 'disabled' : ''}>
        ${mine ? 'Fighting for this side' : membership ? 'Locked in elsewhere' : 'Join ' + escapeText(faction.name)}
      </button>`;

    const button = card.querySelector('.faction__join');
    if (!membership) {
      button.addEventListener('click', () => confirmJoin(faction));
    }
    mount.appendChild(card);
  });
}

/* Joining is irreversible for the whole event, so it asks once. A player who could switch to
 * whichever side is winning would make every leaderboard and every payout meaningless, and that
 * consequence belongs in front of them before they click, not in a support ticket afterwards. */
function confirmJoin(faction) {
  openModal(`Fight for ${faction.name}?`, (body) => {
    body.innerHTML = `
      <p>Every wager you place for the rest of this war counts toward
        <b style="color:${escapeAttr(faction.color)}">${escapeText(faction.name)}</b>.</p>
      <p class="modal__note">You cannot switch sides once the war has started. Choose deliberately.</p>
      <div class="modal__row">
        <button class="btn" id="joinNo" type="button">Not yet</button>
        <button class="btn btn--go" id="joinYes" type="button">Join ${escapeText(faction.name)}</button>
      </div>`;

    $('#joinNo', body).addEventListener('click', closeModal);
    $('#joinYes', body).addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        await joinFaction(faction.id);
        playSound('anvil');
        closeModal();
        toast({ kind: 'win', title: `You fight for ${faction.name}`, body: 'Every wager counts now.' });
      } catch (error) {
        event.target.disabled = false;
        toast({
          kind: 'lose',
          title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not join',
          body: error?.message || 'The server rejected the request.',
        });
      }
    });
  });
}

function paintBoard(mount, leaderboard, factions) {
  if (!mount) return;
  if (!leaderboard.length) {
    mount.innerHTML = '<p class="empty">Nobody has contributed yet. The first wager takes first place.</p>';
    return;
  }
  const colorById = new Map(factions.map((faction) => [faction.id, faction.color]));
  mount.innerHTML = '';

  leaderboard.forEach((entry, index) => {
    const row = el('div', 'boardrow');
    row.dataset.you = entry.isYou ? '1' : '0';
    row.style.setProperty('--team', colorById.get(entry.factionId) || '#ffaa00');
    row.innerHTML = `
      <span class="boardrow__rank mono">${index + 1}</span>
      <span class="boardrow__who">${escapeText(entry.player)}${entry.isYou ? ' <em>you</em>' : ''}</span>
      <span class="boardrow__amt mono">${money(Number(entry.totalMinor))}</span>`;
    mount.appendChild(row);
  });
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeText(value).replaceAll('`', '&#96;');
}
