/* quests.js — daily quests and the login streak.
 *
 * Progress is server-side. Nothing here increments a counter locally, because a bar that advances
 * on the client and then snaps back on the next refresh is worse than a bar that waits.
 */
import { state, bus, refreshQuests, claimQuest, claimStreak } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

let root = null;
let countdownTimer = 0;

export function mountQuests(view) {
  root = $('#questRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', () => {
      if (root.isConnected) paint();
    });
    if (state.authenticated) refreshQuests().catch(() => undefined);
  }
  paint();
  startCountdown();
}

/* The reset clock is the only thing on this page allowed to tick locally: it counts down to a
 * fixed UTC boundary, so it cannot drift away from what the server believes. */
function startCountdown() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    const label = $('#questReset', root ?? document);
    if (!label || !label.isConnected) {
      window.clearInterval(countdownTimer);
      countdownTimer = 0;
      return;
    }
    label.textContent = timeToUtcMidnight();
  }, 1000);
}

function timeToUtcMidnight() {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  );
  const remaining = Math.max(0, midnight - now.getTime());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function paint() {
  if (!root?.isConnected) return;

  if (!state.authenticated) {
    root.innerHTML = `<section class="card"><h2 class="card__h">Log in to track quests</h2>
      <p class="card__p">Daily goals and your login streak are tied to your account.</p></section>`;
    return;
  }

  const streak = state.streak;
  const quests = state.quests || [];
  const claimable = quests.filter((quest) => quest.claimable).length;

  root.innerHTML = `
    <section class="streak glass">
      <div class="streak__main">
        <span class="streak__label">Daily streak</span>
        <b class="streak__figure mono">${streak?.currentStreak ?? 0}<em>days</em></b>
        <span class="streak__sub">
          Longest ${streak?.longestStreak ?? 0} · resets in <b class="mono" id="questReset">${timeToUtcMidnight()}</b>
        </span>
      </div>
      <div class="streak__pips" id="streakPips" role="img"
           aria-label="Streak progress toward the maximum multiplier"></div>
      <button class="btn btn--go streak__claim" id="streakClaim"
              ${streak?.claimable ? '' : 'disabled'}>
        ${streak?.claimable
          ? `Claim ${money(Number(streak.nextRewardMinor))}`
          : 'Claimed today'}
      </button>
    </section>

    <section class="card">
      <h2 class="card__h">
        Today's quests
        <span>${claimable ? `${claimable} ready to claim` : `${quests.length} active`}</span>
      </h2>
      <p class="card__p">Progress is counted by the server as you play. Rewards are paid straight to your balance.</p>
      <div class="questlist" id="questList"></div>
    </section>`;

  paintPips($('#streakPips', root), streak);
  paintQuests($('#questList', root), quests);

  const claimButton = $('#streakClaim', root);
  if (streak?.claimable) {
    claimButton.addEventListener('click', async () => {
      claimButton.disabled = true;
      try {
        const result = await claimStreak();
        playSound('reward');
        toast({
          kind: 'win',
          title: `Day ${result.streakLength} claimed`,
          body: `+${money(Number(result.rewardMinor))}`,
        });
      } catch (error) {
        claimButton.disabled = false;
        showError(error);
      }
    });
  }
}

/* One pip per day up to the multiplier cap, so the ladder's end is visible from day one rather
 * than being an unbounded climb the player cannot plan around. */
function paintPips(mount, streak) {
  if (!mount) return;
  const max = Number(streak?.maxMultiplier ?? 7);
  const current = Number(streak?.currentStreak ?? 0);
  mount.innerHTML = '';
  for (let day = 1; day <= max; day += 1) {
    const pip = el('span', 'pip');
    pip.dataset.on = day <= current ? '1' : '0';
    if (day === max) pip.dataset.cap = '1';
    pip.title = `Day ${day}`;
    mount.appendChild(pip);
  }
}

function paintQuests(mount, quests) {
  if (!mount) return;
  if (!quests.length) {
    mount.innerHTML = '<p class="empty">No quests are active right now. Check back tomorrow.</p>';
    return;
  }
  mount.innerHTML = '';

  quests.forEach((quest) => {
    const ratio = Math.max(0, Math.min(1, Number(quest.progressRatio) || 0));
    const card = el('article', 'quest');
    card.dataset.state = quest.claimed ? 'claimed' : quest.claimable ? 'ready' : 'active';

    card.innerHTML = `
      <div class="quest__body">
        <h3 class="quest__name">${escapeText(quest.name)}</h3>
        <p class="quest__desc">${escapeText(quest.description)}</p>
        <div class="quest__bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>
        <span class="quest__progress mono">
          ${formatMetric(quest.metric, quest.progressValue)} / ${formatMetric(quest.metric, quest.targetValue)}
        </span>
      </div>
      <div class="quest__side">
        <b class="quest__reward mono">${money(Number(quest.rewardMinor))}</b>
        <button class="btn btn--tiny quest__claim" type="button"
                ${quest.claimable ? '' : 'disabled'}>
          ${quest.claimed ? 'Claimed' : quest.claimable ? 'Claim' : 'In progress'}
        </button>
      </div>`;

    const button = card.querySelector('.quest__claim');
    if (quest.claimable) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await claimQuest(quest.code);
          playSound('reward');
          toast({
            kind: 'win',
            title: quest.name,
            body: `+${money(Number(result.rewardMinor))}`,
          });
        } catch (error) {
          button.disabled = false;
          showError(error);
        }
      });
    }
    mount.appendChild(card);
  });
}

/* A wager target of 1000000 should read as $1M, but a target of 3 rolls is just 3. The metric name
 * carries the unit, so the formatter reads it rather than guessing from magnitude. */
function formatMetric(metric, value) {
  const number = Number(value) || 0;
  return String(metric).endsWith('_minor') ? money(number) : number.toLocaleString('en-US');
}

function showError(error) {
  toast({
    kind: 'lose',
    title: error?.code ? String(error.code).replaceAll('_', ' ') : 'Could not claim',
    body: error?.message || 'The server rejected the request.',
  });
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
