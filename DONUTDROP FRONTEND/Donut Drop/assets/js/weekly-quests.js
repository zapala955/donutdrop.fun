/* weekly-quests.js — the week's two quests on the Quests page: the deposit race and the recruit
 * quest (lib/weekly-quests.ts), each with its own prize pot.
 *
 * Everything shown is the server's: the pots, the prizes, the board, the player's counted deposit
 * and place, and how far each invited friend has got. Nothing here counts anything locally; it asks
 * again every minute while the page is open, and when the player signs in or out. Readable signed
 * out, because a prize nobody can see before signing up is not one that brings anybody in.
 */
import { api } from './api.js';
import { bus } from './store.js';
import { $, money } from './util.js';

const REFRESH_MS = 60_000;

let root = null;
let board = null;
let timer = 0;
let loading = false;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cash = (minor) => money(Number(minor ?? 0));
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function placeName(rank) {
  const n = Number(rank);
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "3d 4h", "5h 12m", "12m": what is left until an instant. */
export function timeLeft(iso, now = Date.now()) {
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function mountWeeklyQuests(mount) {
  root = mount;
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (['ready', 'login', 'logout'].includes(event.detail)) void load();
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-wq="login"]')) $('#loginBtn')?.click();
      if (event.target.closest('[data-wq="deposit"]')) $('#depositBtn')?.click();
    });
  }
  void load();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!root?.isConnected) { clearInterval(timer); return; }
    if (!document.hidden && root.offsetParent !== null) void load();
  }, REFRESH_MS);
}

/** The week's board, or null when the quests are off or the server did not answer. */
export async function readWeeklyQuests() {
  try {
    return await api.get('/v1/quests/weekly');
  } catch {
    return null;
  }
}

async function load() {
  if (loading || !root) return;
  loading = true;
  try {
    board = await readWeeklyQuests();
  } finally {
    loading = false;
  }
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  if (!board?.enabled || !board.depositRace || !board.recruit) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  // In the player's own time, in the site's language: "Tuesday 01:00".
  const paidOn = new Date(board.settlesAt).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  root.innerHTML = `
    <header class="wq__head">
      <h2 class="wq__h">This week's quests</h2>
      <span class="wq__clock mono" title="The week ends on Monday 00:00 UTC">Ends in <b>${esc(timeLeft(board.endsAt))}</b></span>
    </header>
    <div class="wq__grid">
      ${raceCard(board.depositRace)}
      ${recruitCard(board.recruit)}
    </div>
    <p class="wq__fine">Prizes are paid ${esc(paidOn)}${board.wagerMultiplier > 0
      ? `, and are wagered ${board.wagerMultiplier}× before they can be withdrawn` : ''}. Staff accounts do not take part.</p>`;
}

function raceCard(race) {
  const prizes = race.prizes.map((prize, index) => `<li><span>${placeName(index + 1)}</span><b>${cash(prize)}</b></li>`).join('');
  const you = race.you;
  let standing = `<button class="wq__go lxbtn lxbtn--gold" type="button" data-wq="login">Log in to race</button>`;
  if (you) {
    const counted = BigInt(you.scoreMinor);
    const need = BigInt(race.minDepositMinor);
    const line = you.rank
      ? `You are <b>${placeName(you.rank)}</b> with <b>${cash(you.scoreMinor)}</b> counted`
      : counted > 0n
        ? `<b>${cash(you.scoreMinor)}</b> counted. Reach ${cash(race.minDepositMinor)} to place`
        : `Deposit and play at least ${cash(race.minDepositMinor)} this week to place`;
    standing = `<p class="wq__you">${line}${need > 0n && BigInt(you.netMinor) > BigInt(you.wageredMinor)
      ? `<span class="wq__hint">Deposited ${cash(you.netMinor)}, played ${cash(you.wageredMinor)}: only what you play counts</span>` : ''}</p>
      <button class="wq__go lxbtn lxbtn--gold" type="button" data-wq="deposit">Deposit</button>`;
  }
  const rows = race.board.length
    ? race.board.map((entry) => `<li class="wq__row${you?.rank === entry.rank ? ' is-you' : ''}">
        <span class="wq__rank mono">${entry.rank}</span>
        <span class="wq__who">${esc(entry.player)}</span>
        <span class="wq__amt mono">${cash(entry.scoreMinor)}</span>
        <span class="wq__prize mono">${BigInt(entry.prizeMinor) > 0n ? cash(entry.prizeMinor) : ''}</span>
      </li>`).join('')
    : `<li class="wq__empty">Nobody has placed yet. ${cash(race.minDepositMinor)} deposited and played takes 1st.</li>`;
  return `
    <article class="wq__card" data-quest="deposit_race">
      <div class="wq__top">
        <span class="wq__tag">Deposit race</span>
        <h3 class="wq__title"><b>${cash(race.potMinor)}</b> pot</h3>
        <p class="wq__rule">The biggest deposits of the week win. A deposit counts as far as you also play it, and withdrawals come off.</p>
      </div>
      <ol class="wq__prizes">${prizes}</ol>
      ${standing}
      <ol class="wq__board">${rows}</ol>
      ${lastLine(race.lastWinners.map((w) => `${placeName(w.rank)} ${esc(w.player)} ${cash(w.amountMinor)}`))}
    </article>`;
}

function recruitCard(recruit) {
  const need = recruit.friendsNeeded;
  const you = recruit.you;
  let standing = `<button class="wq__go lxbtn lxbtn--gold" type="button" data-wq="login">Log in to recruit</button>`;
  if (you) {
    const pips = Array.from({ length: need }, (_, index) =>
      `<i class="wq__pip${index < you.qualified ? ' is-on' : ''}" aria-hidden="true"></i>`).join('');
    const line = you.done
      ? `<b>Done!</b> You share the pot with everyone else who finishes`
      : `<b>${you.qualified}/${need}</b> friends ready`;
    const friends = you.friends.length
      ? `<ul class="wq__friends"><li class="wq__fhead" aria-hidden="true"><span>Friend</span><span>Deposited</span><span>Wagered</span><span></span></li>${you.friends.map((friend) => `<li class="${friend.qualified ? 'is-on' : ''}">
          <span class="wq__who">${esc(friend.player)}</span>
          <span class="wq__bar" title="Deposited ${cash(friend.netMinor)} of ${cash(recruit.friendDepositMinor)}"><i style="--p:${share(friend.netMinor, recruit.friendDepositMinor)}"></i></span>
          <span class="wq__bar" title="Wagered ${cash(friend.wageredMinor)} of ${cash(recruit.friendWagerMinor)}"><i style="--p:${share(friend.wageredMinor, recruit.friendWagerMinor)}"></i></span>
          <span class="wq__ok" aria-label="${friend.qualified ? 'counts' : 'not yet'}">${friend.qualified ? '✓' : ''}</span>
        </li>`).join('')}</ul>`
      : `<p class="wq__hint">Nobody has joined on your link this week yet.</p>`;
    standing = `<div class="wq__progress"><span class="wq__pips">${pips}</span><p class="wq__you">${line}</p></div>
      ${friends}
      <a class="wq__go lxbtn lxbtn--gold" href="/referrals">Get your invite link</a>`;
  }
  const shareLine = recruit.finishers > 0
    ? `${recruit.finishers} finished so far: <b>${cash(recruit.shareMinor)}</b> each if the week ended now`
    : `Nobody has finished yet: the first gets the whole <b>${cash(recruit.potMinor)}</b>`;
  return `
    <article class="wq__card" data-quest="recruit">
      <div class="wq__top">
        <span class="wq__tag">Recruit ${need} friends</span>
        <h3 class="wq__title"><b>${cash(recruit.potMinor)}</b> pot</h3>
        <p class="wq__rule">Bring ${need} new players with your invite link this week. Each needs to deposit ${cash(recruit.friendDepositMinor)} and wager ${cash(recruit.friendWagerMinor)}. Everyone who finishes shares the pot.</p>
      </div>
      <p class="wq__share">${shareLine}</p>
      ${standing}
      ${lastLine(recruit.lastFinishers.map((w) => `${esc(w.player)} ${cash(w.amountMinor)}`))}
    </article>`;
}

/** Progress of a figure against its target, 0 to 1, for a bar. */
function share(valueMinor, targetMinor) {
  const target = Number(targetMinor);
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(1, Number(valueMinor) / target)).toFixed(3);
}

function lastLine(items) {
  return items.length ? `<p class="wq__last">Last week: ${items.join(' · ')}</p>` : '';
}
