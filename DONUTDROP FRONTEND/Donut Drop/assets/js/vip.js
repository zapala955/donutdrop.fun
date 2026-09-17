/* vip.js — the VIP dashboard, the navbar level widget, and the level-up reveal.
 *
 * Three surfaces, one module, because all three read the same snapshot off /v1/vip and splitting
 * them would mean three copies of the tier palette and the rate formatter.
 *
 * Nothing here computes a level. The server derives the level, the rate and every locked/active/
 * complete badge from the lifetime wager total and sends them down already decided — so the badge
 * in the navbar and the rate the last wager was actually paid at cannot disagree. The client's
 * only arithmetic is turning a ratio into a bar width.
 */
import { state, bus, refreshVip } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

/* Tier accents. Held here rather than in CSS because the navbar pill, the dashboard matrix and
 * the level-up toast all need the same colour for the same tier, and a data attribute per tier is
 * one lookup where three stylesheets would be three chances to drift. */
const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'high_roller'];

let root = null;
/* The last level the navbar rendered, so a change can be detected and announced exactly once.
 * Null means nothing has been rendered yet — the first paint after login must NOT fire a
 * level-up toast, because arriving at your existing level is not an achievement. */
let lastLevel = null;

/* Rates render with at least two decimals and as many as four, because the ladder's increments
 * genuinely need them: Diamond II is 1.3375%, and a formatter fixed at two decimals would print
 * 1.34% — rounding away the exact fractional step the whole scale was built to represent. Two is
 * the floor so 2% reads as "2.00%" rather than "2%" beside its neighbours. */
function ratePct(value) {
  const exact = Number(Number(value).toFixed(4));
  const decimals = Math.max(2, (String(exact).split('.')[1] ?? '').length);
  return `${exact.toFixed(decimals)}%`;
}

// ─────────── /vip dashboard ───────────

export function mountVip(view) {
  root = $('#vipRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['vip', 'login', 'logout', 'ready', 'private'].includes(event.detail)) paint();
    });
  }
  if (state.authenticated) refreshVip(false).then(paint).catch(() => undefined);
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to see your VIP standing.'));
    return;
  }
  const data = state.vip;
  if (!data) {
    root.appendChild(notice('VIP levels are not switched on yet.'));
    return;
  }

  root.appendChild(headline(data));
  root.appendChild(statCards(data));
  root.appendChild(matrix(data));
}

function notice(message) {
  const card = el('div', 'vip__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

/* The badge, the bar, and the one number the bar is moving toward. No prose: the pill says the
 * rank, the chip says the rate, the fraction under the bar says what is left. */
function headline(data) {
  const wrap = el('section', 'vip__hero');
  wrap.dataset.tier = data.current.tier;

  const top = el('div', 'vip__herotop');
  const badge = el('span', 'vip__badge');
  badge.dataset.tier = data.current.tier;
  badge.textContent = data.current.label.toUpperCase();

  const rate = el('span', 'vip__rate mono');
  rate.textContent = `${ratePct(data.current.ratePercent)} RAKEBACK`;
  top.append(badge, rate);
  wrap.appendChild(top);

  const track = el('div', 'vip__track');
  const fill = el('div', 'vip__fill');
  fill.style.transform = `scaleX(${Math.min(1, Math.max(0, data.progress.ratio))})`;
  track.appendChild(fill);
  wrap.appendChild(track);

  const foot = el('div', 'vip__herofoot');
  const progress = el('span', 'vip__frac mono');
  if (data.next) {
    progress.textContent = `${money(Number(data.wageredMinor))} / ${money(Number(data.next.thresholdMinor))}`;
    const target = el('span', 'vip__target mono');
    target.textContent = `→ ${data.next.label.toUpperCase()} · ${ratePct(data.next.ratePercent)}`;
    foot.append(progress, target);
  } else {
    // Top of the ladder. There is no next threshold, so the bar is full and says why.
    progress.textContent = money(Number(data.wageredMinor));
    const target = el('span', 'vip__target mono');
    target.textContent = `MAX ${ratePct(data.maxRatePercent)}`;
    foot.append(progress, target);
  }
  wrap.appendChild(foot);
  return wrap;
}

function statCards(data) {
  const grid = el('div', 'vip__grid');
  const cells = [
    ['Lifetime wagered', money(Number(data.wageredMinor)), null],
    ['Active rakeback', ratePct(data.current.ratePercent), 'gold'],
    [
      'To next unlock',
      data.next ? money(Number(data.progress.remainingMinor)) : '—',
      null,
    ],
    ['VIP rakeback ready', money(Number(data.rakeback.claimableMinor)), 'gold'],
  ];
  for (const [label, value, tone] of cells) {
    const cell = el('div', 'vip__stat');
    if (tone) cell.dataset.tone = tone;
    const key = el('span', 'vip__k');
    key.textContent = label;
    const figure = el('b', 'vip__v');
    figure.textContent = value;
    cell.append(key, figure);
    grid.appendChild(cell);
  }
  return grid;
}

/* All thirty levels, grouped by tier. Each row is a rank, a threshold and a rate — three figures
 * and a state badge, no descriptions. */
function matrix(data) {
  const wrap = el('section', 'vip__matrix');

  for (const tier of TIER_ORDER) {
    const levels = data.levels.filter((entry) => entry.tier === tier);
    if (!levels.length) continue;

    const group = el('div', 'vip__tier');
    group.dataset.tier = tier;

    const head = el('div', 'vip__tierhead');
    const name = el('span', 'vip__tiername');
    name.textContent = levels[0].tierLabel;
    const span = el('span', 'vip__tierspan mono');
    span.textContent = `${ratePct(levels[0].ratePercent)} – ${ratePct(levels[levels.length - 1].ratePercent)}`;
    head.append(name, span);
    group.appendChild(head);

    const rows = el('div', 'vip__rows');
    for (const level of levels) {
      const row = el('div', 'vip__row');
      row.dataset.state = level.state;

      const sub = el('span', 'vip__sub mono');
      sub.textContent = level.sub;

      const threshold = el('span', 'vip__threshold mono');
      threshold.textContent = money(Number(level.thresholdMinor));

      const chip = el('span', 'vip__chip mono');
      chip.textContent = ratePct(level.ratePercent);

      const badge = el('span', 'vip__state');
      badge.textContent =
        level.state === 'complete' ? '✓' : level.state === 'active' ? 'ACTIVE' : 'LOCKED';

      row.append(sub, threshold, chip, badge);
      rows.appendChild(row);
    }
    group.appendChild(rows);
    wrap.appendChild(group);
  }
  return wrap;
}

// ─────────── navbar widget ───────────

/**
 * Drives the level pill that already exists in the header markup.
 *
 * Reuses `#lvlPill` / `#lvlNum` / `#lvlFill` rather than adding a second widget beside them: the
 * pill was built for exactly this and was showing a placeholder 'LIVE'. The hidden attribute
 * comes off only once there is a real standing to show.
 */
export function initVipWidget() {
  const pill = $('#lvlPill');
  if (!pill) return;
  const paintPill = () => {
    const data = state.vip;
    const number = $('#lvlNum');
    const fill = $('#lvlFill');
    const tip = $('#lvlTip');

    if (!state.authenticated || !data) {
      pill.hidden = true;
      lastLevel = null;
      return;
    }

    pill.hidden = false;
    pill.dataset.tier = data.current.tier;
    if (number) number.textContent = data.current.label.toUpperCase();
    if (fill) fill.style.transform = `scaleX(${Math.min(1, Math.max(0, data.progress.ratio))})`;

    /* The tooltip carries the one sentence this widget is allowed: how much further, and to what.
     * It is also the pill's accessible name, because the bar itself is decorative to a reader. */
    const sentence = data.next
      ? `${money(Number(data.wageredMinor))} / ${money(Number(data.next.thresholdMinor))} to ${data.next.label.toUpperCase()}`
      : `Top level · ${ratePct(data.maxRatePercent)} rakeback`;
    if (tip) {
      tip.dataset.tip = sentence;
      tip.setAttribute('aria-label', sentence);
    }
    pill.setAttribute('aria-label', `${data.current.label}. ${sentence}`);

    announce(data);
  };

  bus.addEventListener('change', paintPill);
  paintPill();
}

/**
 * Announces a sub-level increase, once.
 *
 * Compares against the last level this widget rendered rather than against anything the server
 * sends, because the server has no idea what the browser has already shown. The first paint of a
 * session records the level silently — arriving at the level you already had is not an unlock.
 */
function announce(data) {
  const level = data.current.level;
  if (lastLevel === null) {
    lastLevel = level;
    return;
  }
  if (level <= lastLevel) {
    // Levels do not go down, but a stale snapshot arriving late must not re-announce.
    lastLevel = Math.max(lastLevel, level);
    return;
  }
  lastLevel = level;

  /* Two cues, deliberately: the portal marks the transition and the coin marks what it bought.
   * Both are existing sounds in the audio engine rather than new assets. */
  playSound('portal');
  window.setTimeout(() => playSound('coin'), 180);

  toast({
    kind: 'gold',
    title: data.current.label.toUpperCase(),
    body: `UNLOCKED ${ratePct(data.current.ratePercent)} RAKEBACK`,
  });
}
