/* race.js — the live wagering race leaderboard.
 *
 * A table, a pool, and a clock. Every wager the player makes anywhere on the site already counts
 * toward every live race, so there is nothing to opt into and nothing to explain — which is why
 * this page has no copy on it beyond column headings.
 *
 * The projected prize beside each rank comes from the server, computed by the same function that
 * settles the race. It is deliberately NOT recomputed here from the payout curve: two
 * implementations of one payout formula is exactly how a player ends up racing for a figure they
 * are not paid.
 */
import { state, bus, refreshRaces, settleRaces } from './store.js';
import { tableAvatar } from './table-avatar.js';
import { $, el, money } from './util.js';

let root = null;
let ticker = 0;
let poll = 0;
let activeSlug = '';
/* Guards the settlement nudge, which fires once when a clock runs out rather than on every tick
 * of the second that follows it. */
let settling = false;

export function mountRace(view) {
  root = $('#raceRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['races', 'login', 'logout', 'ready'].includes(event.detail)) paint();
    });
  }
  refreshRaces(false).then(paint).catch(() => undefined);
  paint();
  startTimers();
}

/* Two clocks. The countdown is local and ticks every second because a race clock that jumps in
 * thirty-second steps looks broken; the data refresh is every thirty seconds because a
 * leaderboard is not worth a request per second and the server is the only thing that can move a
 * rank anyway. */
function startTimers() {
  if (ticker) window.clearInterval(ticker);
  if (poll) window.clearInterval(poll);

  ticker = window.setInterval(() => {
    const node = root?.isConnected ? $('#raceClock', root) : null;
    if (!root?.isConnected) {
      window.clearInterval(ticker);
      window.clearInterval(poll);
      ticker = 0;
      poll = 0;
      return;
    }
    if (!node) return;
    const endsAt = new Date(node.dataset.endsAt).getTime();
    const remaining = endsAt - Date.now();
    node.textContent = remaining > 0 ? formatRemaining(remaining) : 'SETTLING';
    if (remaining <= 0) nudgeSettlement();
  }, 1000);

  poll = window.setInterval(() => {
    if (!root?.isConnected) return;
    refreshRaces().catch(() => undefined);
  }, 30_000);
}

/* When the clock runs out somebody has to ask the server to pay the pool. The settle route is
 * idempotent and only ever acts on races the clock has already ended, so whichever client gets
 * there first does the work and the rest find nothing to do. */
async function nudgeSettlement() {
  if (settling || !state.authenticated) return;
  settling = true;
  try {
    await settleRaces();
  } catch {
    // A refusal here is not worth surfacing: a scheduled job or the next visitor will settle it.
  } finally {
    window.setTimeout(() => {
      settling = false;
    }, 15_000);
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds].map((p) => String(p).padStart(2, '0')).join(':');
  return days > 0 ? `${days}d ${clock}` : clock;
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  const data = state.races;
  if (!data || !data.races.length) {
    root.appendChild(notice(data ? 'No race is running right now.' : 'Races are not switched on yet.'));
    return;
  }

  const race = data.races.find((entry) => entry.slug === activeSlug) ?? data.races[0];
  activeSlug = race.slug;

  if (data.races.length > 1) root.appendChild(tabs(data.races, race));
  root.appendChild(headline(race));
  root.appendChild(table(race));
}

function notice(message) {
  const card = el('div', 'race__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function tabs(races, active) {
  const bar = el('div', 'race__tabs');
  for (const race of races) {
    const tab = el('button', 'race__tab');
    tab.type = 'button';
    tab.dataset.on = race.slug === active.slug ? '1' : '0';
    tab.textContent = race.name;
    tab.addEventListener('click', () => {
      activeSlug = race.slug;
      paint();
    });
    bar.appendChild(tab);
  }
  return bar;
}

function headline(race) {
  const wrap = el('div', 'race__head');

  const pool = el('div', 'race__stat');
  const poolKey = el('span', 'race__statk');
  poolKey.textContent = 'Prize pool';
  const poolValue = el('b', 'race__statv race__statv--gold mono');
  poolValue.textContent = money(Number(race.prizePoolMinor));
  pool.append(poolKey, poolValue);

  const clock = el('div', 'race__stat');
  const clockKey = el('span', 'race__statk');
  clockKey.textContent = 'Ends in';
  const clockValue = el('b', 'race__statv mono');
  clockValue.id = 'raceClock';
  clockValue.dataset.endsAt = race.endsAt;
  const remaining = new Date(race.endsAt).getTime() - Date.now();
  clockValue.textContent = remaining > 0 ? formatRemaining(remaining) : 'SETTLING';
  clock.append(clockKey, clockValue);

  const places = el('div', 'race__stat');
  const placesKey = el('span', 'race__statk');
  placesKey.textContent = 'Paid places';
  const placesValue = el('b', 'race__statv mono');
  placesValue.textContent = String(race.paidPlaces);
  places.append(placesKey, placesValue);

  const you = el('div', 'race__stat');
  const youKey = el('span', 'race__statk');
  youKey.textContent = 'Your rank';
  const youValue = el('b', 'race__statv mono');
  youValue.textContent = race.viewerRank ? `#${race.viewerRank}` : '—';
  you.append(youKey, youValue);

  wrap.append(pool, clock, places, you);
  return wrap;
}

function table(race) {
  const wrap = el('div', 'race__tablewrap');
  const table = el('table', 'dtable');

  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['#', ''],
    ['Player', ''],
    ['Wagered', 'dtable__num'],
    ['Prize', 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  if (!race.leaderboard.length) {
    const row = el('tr');
    const cell = el('td');
    cell.colSpan = 4;
    cell.className = 'dtable__empty';
    cell.textContent = 'No entrants yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  for (const entry of race.leaderboard) {
    const row = el('tr');
    row.dataset.you = entry.isViewer ? '1' : '0';
    // The podium is the only place rank gets its own colour; below it the number carries itself.
    if (entry.rank <= 3) row.dataset.podium = String(entry.rank);

    const rank = el('td', 'dtable__rank mono');
    rank.textContent = `#${entry.rank}`;

    const player = el('td', 'dtable__player');
    const avatar = tableAvatar(entry.playerId);
    const name = el('span', 'dtable__name');
    name.textContent = entry.username;
    player.append(avatar, name);

    const wagered = el('td', 'dtable__num mono');
    wagered.textContent = money(Number(entry.wageredMinor));

    const prize = el('td', 'dtable__num mono dtable__prize');
    const projected = Number(entry.projectedPrizeMinor);
    prize.textContent = projected > 0 ? money(projected) : '—';

    row.append(rank, player, wagered, prize);
    body.appendChild(row);
  }

  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}
