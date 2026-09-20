/* daily.js — the seven-day login streak, as a calendar.
 *
 * The backend already owns the streak: /v1/streak reports the current length, whether today has
 * been taken, and what the next claim pays. What it does not send is a ladder, because the ladder
 * is a pure function of two numbers it does send — the base reward and the multiplier cap — and
 * shipping a derived array would give the page a second source of truth for a figure the claim
 * route computes from the first.
 *
 * So the grid is built here from `baseRewardMinor` and `maxMultiplier` using the same shape the
 * server's streakRewardMinor uses: linear in the day, capped at the cap. If that formula ever
 * changes on the server it changes here, and the pairing is deliberate — the alternative is a
 * calendar that quietly promises a number the claim does not pay.
 */
import { state, bus, refreshQuests, claimStreak } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const LADDER_DAYS = 7;

let root = null;
let ticker = 0;
let claiming = false;
/* Distinguishes "the streak has not arrived yet" from "it failed to arrive". Without it a failed
 * load leaves the page saying "loading" forever, which is the one message that promises something
 * is still happening when nothing is. */
let loading = false;

export function mountDaily(view) {
  root = $('#dailyRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'private', 'quests'].includes(event.detail)) paint();
    });
    if (state.authenticated) load();
  }
  paint();
  startTicker();
}

function load() {
  loading = true;
  refreshQuests(false)
    .catch(() => undefined)
    .finally(() => {
      loading = false;
      paint();
    });
}

/* The reset clock counts down to a fixed UTC boundary, so it cannot drift away from the day
 * boundary the server uses to decide whether today has been claimed. */
function startTicker() {
  if (ticker) window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    const node = root?.isConnected ? $('#dailyReset', root) : null;
    if (!node) {
      window.clearInterval(ticker);
      ticker = 0;
      return;
    }
    node.textContent = timeToUtcMidnight();
  }, 1000);
}

function timeToUtcMidnight() {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  const total = Math.max(0, Math.floor((midnight - now.getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** The server's streakRewardMinor, mirrored: linear in the streak, capped at the cap. */
function rewardForDay(streak, day) {
  const capped = Math.max(1, Math.min(day, streak.maxMultiplier || LADDER_DAYS));
  return Number(streak.baseRewardMinor || '0') * capped;
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to start a streak.'));
    return;
  }
  const streak = state.streak;
  if (!streak) {
    root.appendChild(notice(loading ? 'Loading.' : 'Daily rewards are unavailable.'));
    return;
  }

  root.appendChild(header(streak));
  root.appendChild(grid(streak));
  root.appendChild(claimBar(streak));
}

function notice(message) {
  const card = el('div', 'daily__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function header(streak) {
  const wrap = el('div', 'daily__head');
  const cells = [
    ['Current streak', String(streak.currentStreak), true],
    ['Longest', String(streak.longestStreak), false],
    ['Total claims', String(streak.totalClaims), false],
    [
      'Wagered today',
      `${money(Number(streak.wageredTodayMinor))} / ${money(Number(streak.wagerRequirementMinor))}`,
      streak.wagerRequirementMet,
    ],
  ];
  for (const [label, value, gold] of cells) {
    const cell = el('div', 'daily__stat');
    const key = el('span', 'daily__statk');
    key.textContent = label;
    const figure = el('b', `daily__statv${gold ? ' daily__statv--gold' : ''}`);
    figure.textContent = value;
    cell.append(key, figure);
    wrap.appendChild(cell);
  }

  const reset = el('div', 'daily__stat');
  const resetKey = el('span', 'daily__statk');
  resetKey.textContent = 'Resets in';
  const resetValue = el('b', 'daily__statv mono');
  resetValue.id = 'dailyReset';
  resetValue.textContent = timeToUtcMidnight();
  reset.append(resetKey, resetValue);
  wrap.appendChild(reset);
  return wrap;
}

function grid(streak) {
  const wrap = el('div', 'daily__grid');

  /* Which day of the ladder each cell represents. A claimed-today streak of 3 means days 1-3 are
   * done and day 4 is next; an unclaimed streak of 3 means day 4 is today and claimable now. */
  const done = streak.claimedToday ? streak.currentStreak : streak.currentStreak;
  const todayDay = streak.claimedToday ? 0 : streak.nextStreakLength;

  for (let day = 1; day <= LADDER_DAYS; day += 1) {
    const cell = el('article', 'daily__day');
    const isMega = day === LADDER_DAYS;
    const claimed = day <= done && (streak.claimedToday || day < todayDay);
    const isToday = day === todayDay;

    cell.dataset.state = claimed ? 'claimed' : isToday ? 'today' : 'locked';
    if (isMega) cell.dataset.mega = '1';

    const number = el('span', 'daily__num mono');
    number.textContent = `DAY ${day}`;

    const art = el('span', 'daily__art');
    art.setAttribute('aria-hidden', 'true');
    art.textContent = isMega ? '🎁' : '💰';

    const reward = el('b', 'daily__reward mono');
    reward.textContent = money(rewardForDay(streak, day));

    const badge = el('span', 'daily__badge');
    badge.textContent = claimed ? 'CLAIMED' : isToday ? 'TODAY' : 'LOCKED';

    cell.append(number, art, reward, badge);
    if (isMega) {
      const mega = el('span', 'daily__mega');
      mega.textContent = 'MEGA CHEST';
      cell.appendChild(mega);
    }
    wrap.appendChild(cell);
  }
  return wrap;
}

function claimBar(streak) {
  const bar = el('div', 'daily__claim');
  const wagered = Number(streak.wageredTodayMinor || 0);
  const required = Number(streak.wagerRequirementMinor || 0);
  const remaining = Number(streak.wagerRemainingMinor || 0);

  const figure = el('div', 'daily__claimfig');
  const label = el('span', 'daily__statk');
  label.textContent = 'Today\'s reward';
  const value = el('b', 'daily__claimv mono');
  value.textContent = money(Number(streak.nextRewardMinor));
  figure.append(label, value);

  const requirement = el('div', 'daily__requirement');
  const progress = el('span', 'daily__progress mono');
  progress.textContent = streak.claimedToday
    ? 'Daily wager complete'
    : `${money(wagered)} / ${money(required)} wagered`;
  const track = el('div', 'daily__track');
  const fill = el('i', 'daily__fill');
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, Number(streak.wagerProgressRatio) || 0))})`;
  track.appendChild(fill);
  requirement.append(progress, track);

  const button = el('button', 'btn btn--go daily__go');
  button.type = 'button';
  const day = Math.min(streak.nextStreakLength || 1, LADDER_DAYS);
  button.textContent = claiming
    ? 'CLAIMING…'
    : streak.claimedToday
      ? 'COME BACK TOMORROW'
      : streak.wagerRequirementMet
        ? `CLAIM DAY ${day}`
        : `WAGER ${money(remaining)} MORE`;
  button.disabled = !streak.claimable || claiming;
  button.addEventListener('click', claim);

  bar.append(figure, requirement, button);
  return bar;
}

async function claim() {
  if (claiming) return;
  claiming = true;
  paint();
  try {
    const result = await claimStreak();
    playSound('coin');
    toast({
      kind: 'gold',
      title: `Day ${result.streakLength} claimed`,
      body: money(Number(result.rewardMinor)),
    });
  } catch (error) {
    toast({ kind: 'lose', title: 'Cannot claim', body: error?.message || 'Try again tomorrow.' });
  } finally {
    claiming = false;
    await refreshQuests(false).catch(() => undefined);
    paint();
  }
}
