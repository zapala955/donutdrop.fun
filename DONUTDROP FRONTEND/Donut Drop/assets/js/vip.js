/* vip.js — the VIP page, the navbar level widget, and the level-up reveal.
 *
 * Three surfaces, one module, because all three read the same snapshot off /v1/vip and splitting
 * them would mean three copies of the tier palette and the rate formatter.
 *
 * Nothing here computes a level. The server derives the level, the rate and every locked/active/
 * complete badge from the lifetime wager total and sends them down already decided — so the badge
 * in the navbar and the rate the last wager was actually paid at cannot disagree. The client's
 * only arithmetic is turning a ratio into a bar width.
 */
import { api } from './api.js';
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

// ─────────── /vip page ───────────

/* The VIP page (rebuilt 2026-11-11, the owner: "remake the vip page"). Three parts, top to bottom:
 * where you stand (your level, its rate, the bar to the next one and what is ready to claim), how
 * the club works in three lines, and the ladder as six tier tiles; a tile opens its five levels.
 *
 * Signed out it is the same page without the standing: the ladder is public (/v1/vip/ladder), so
 * somebody deciding whether to play here sees what volume buys what rate before signing up.
 *
 * state.vip can be half there: the balance refresh merges in the standing without `levels` or
 * `rakeback`, which only the page's own /v1/vip fetch carries. The ladder then comes from the
 * public copy, and a rakeback figure not yet known shows as a dash, never a zero. */

const TIER_ICON = {
  bronze: 'gold_nugget',
  silver: 'iron_ingot',
  gold: 'gold_ingot',
  platinum: 'prismarine_crystals',
  diamond: 'diamond',
  high_roller: 'netherite_ingot',
};
const icon = (tier) => `assets/img/items/${TIER_ICON[tier] ?? 'gold_nugget'}.png`;

let ladder = null; // the public ladder: { maxRatePercent, levels }, or false when VIP is off
let picked = null; // the tier whose levels are open; null = the player's own (or the first)

export function mountVip(view) {
  root = $('#vipRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      /* Opened straight from an address, the page mounts before the session is known, so the
       * standing is fetched again once it is: otherwise a signed-in player sees the invitation. */
      if (['login', 'ready'].includes(event.detail) && state.authenticated) {
        refreshVip(false).then(paint).catch(() => undefined);
      }
      if (['vip', 'login', 'logout', 'ready', 'private'].includes(event.detail)) paint();
    });
  }
  if (state.authenticated) refreshVip(false).then(paint).catch(() => undefined);
  if (ladder === null) {
    api.get('/v1/vip/ladder')
      .then((result) => { ladder = result; })
      .catch(() => { ladder = false; })
      .finally(paint);
  }
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';
  root.classList.add('vp');

  const data = state.authenticated ? state.vip : null;
  const levels = data?.levels ?? (ladder ? ladder.levels : null);
  if (!data && ladder === false) {
    root.appendChild(notice('VIP is switched off right now.'));
    return;
  }
  if (!data && !levels) return; // the ladder is on its way

  root.appendChild(data ? standing(data) : invitation(levels));
  root.appendChild(howItWorks());
  if (levels) root.appendChild(tiers(levels, data));
}

function notice(message) {
  const card = el('div', 'vp__notice');
  card.textContent = message;
  return card;
}

function slot(tier, size) {
  const box = el('span', 'vp__slot');
  box.dataset.tier = tier;
  box.innerHTML = `<img src="${icon(tier)}" alt="" width="${size}" height="${size}">`;
  return box;
}

/* Signed in: the level, its rate, the bar and the three figures that matter. */
function standing(data) {
  const card = el('section', 'vp__hero');
  card.dataset.tier = data.current.tier;

  const head = el('div', 'vp__herohead');
  const text = el('div', 'vp__herotext');
  const eyebrow = el('span', 'vp__eyebrow');
  eyebrow.textContent = 'Your level';
  const title = el('h2', 'vp__level');
  title.textContent = data.current.label;
  const line = el('p', 'vp__line');
  line.textContent = `${ratePct(data.current.ratePercent)} back on every bet you place, win or lose.`;
  text.append(eyebrow, title, line);
  const rate = el('div', 'vp__rate');
  rate.innerHTML = `<b></b><span>rakeback</span>`;
  $('b', rate).textContent = ratePct(data.current.ratePercent);
  head.append(slot(data.current.tier, 48), text, rate);
  card.appendChild(head);

  const bar = el('div', 'vp__bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const ratio = Math.min(1, Math.max(0, Number(data.progress?.ratio ?? 1)));
  bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  const fill = el('div', 'vp__fill');
  fill.style.transform = `scaleX(${ratio})`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const foot = el('div', 'vp__barfoot');
  const left = el('span');
  left.textContent = `${money(Number(data.wageredMinor))} wagered`;
  const right = el('span', 'vp__next');
  if (data.next) {
    right.textContent = `${money(Number(data.progress.remainingMinor))} more to ${data.next.label} · ${ratePct(data.next.ratePercent)}`;
    bar.setAttribute('aria-label', `${data.current.label}: ${right.textContent}`);
  } else {
    right.textContent = `Top level · ${ratePct(data.maxRatePercent)}`;
    bar.setAttribute('aria-label', 'Top level reached');
  }
  foot.append(left, right);
  card.appendChild(foot);

  const stats = el('div', 'vp__stats');
  const stat = (label, value, extra) => {
    const cell = el('div', 'vp__stat');
    const k = el('span', 'vp__k');
    k.textContent = label;
    const v = el('b', 'vp__v');
    v.textContent = value;
    cell.append(k, v);
    if (extra) cell.appendChild(extra);
    stats.appendChild(cell);
  };
  stat('Lifetime wagered', money(Number(data.wageredMinor)));
  const claim = el('a', 'vp__claim');
  claim.href = '/rewards';
  claim.textContent = 'Claim on Rewards →';
  stat('Rakeback ready', data.rakeback ? money(Number(data.rakeback.claimableMinor)) : '—', claim);
  stat('Level', `${data.current.level} of ${data.levels?.length ?? ladder?.levels?.length ?? 30}`);
  card.appendChild(stats);
  return card;
}

/* Signed out: what the club is, and the way in. */
function invitation(levels) {
  const card = el('section', 'vp__hero vp__hero--out');
  card.dataset.tier = 'gold';
  const head = el('div', 'vp__herohead');
  const text = el('div', 'vp__herotext');
  const eyebrow = el('span', 'vp__eyebrow');
  eyebrow.textContent = 'VIP club';
  const title = el('h2', 'vp__level');
  const top = levels[levels.length - 1];
  title.textContent = `Up to ${ratePct(top.ratePercent)} back on every bet`;
  const line = el('p', 'vp__line');
  line.textContent = `${levels.length} levels across six tiers. Every bet you place moves you up, and you start earning rakeback from the first one.`;
  text.append(eyebrow, title, line);
  head.append(slot('high_roller', 48), text);
  card.appendChild(head);
  const go = el('button', 'btn btn--go vp__join');
  go.type = 'button';
  go.textContent = 'Log in to start climbing';
  go.addEventListener('click', () => $('#loginBtn')?.click());
  card.appendChild(go);
  return card;
}

function howItWorks() {
  const wrap = el('section', 'vp__how');
  for (const [sprite, title, body] of [
    ['xp_bottle', 'Every bet counts', 'Your level is everything you have ever wagered, in every game. It only goes up.'],
    ['gold_ingot', 'Rakeback on every bet', 'Each level pays back a share of every bet you place, win or lose. Higher levels pay more.'],
    ['chest', 'Claim it any time', 'Rakeback builds up as you play. Claim it on the Rewards page whenever you like.'],
  ]) {
    const card = el('div', 'vp__howcard');
    card.innerHTML = `<span class="vp__slot vp__slot--sm"><img src="assets/img/items/${sprite}.png" alt="" width="24" height="24"></span>`;
    const copy = el('div', 'vp__howcopy');
    const h = el('h3', 'vp__howtitle');
    h.textContent = title;
    const p = el('p', 'vp__howtext');
    p.textContent = body;
    copy.append(h, p);
    card.appendChild(copy);
    wrap.appendChild(card);
  }
  return wrap;
}

/* Six tier tiles; the open one lists its five levels underneath. */
function tiers(levels, data) {
  const wrap = el('section', 'vp__ladder');
  const heading = el('h2', 'vp__h');
  heading.textContent = 'The ladder';
  wrap.appendChild(heading);

  const mine = data?.current?.tier ?? null;
  const open = picked ?? mine ?? TIER_ORDER[0];
  const myLevel = data?.current?.level ?? 0;

  const grid = el('div', 'vp__tiers');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'VIP tiers');
  for (const tier of TIER_ORDER) {
    const rows = levels.filter((entry) => entry.tier === tier);
    if (!rows.length) continue;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const state = !data ? 'open' : last.level < myLevel ? 'done' : tier === mine ? 'here' : first.level > myLevel ? 'locked' : 'done';
    const tile = el('button', 'vp__tier');
    tile.type = 'button';
    tile.dataset.tier = tier;
    tile.dataset.state = state;
    tile.setAttribute('aria-pressed', String(tier === open));
    tile.appendChild(slot(tier, 28));
    const copy = el('span', 'vp__tiercopy');
    const name = el('span', 'vp__tiername');
    name.textContent = first.tierLabel;
    const from = el('span', 'vp__tierfrom');
    from.textContent = Number(first.thresholdMinor) === 0 ? 'From your first bet' : `From ${money(Number(first.thresholdMinor))}`;
    const rate = el('span', 'vp__tierrate');
    rate.textContent = `${ratePct(first.ratePercent)} – ${ratePct(last.ratePercent)}`;
    copy.append(name, from, rate);
    tile.appendChild(copy);
    if (state === 'here' || state === 'done') {
      const mark = el('span', 'vp__tiermark');
      mark.textContent = state === 'here' ? 'You are here' : 'Reached';
      tile.appendChild(mark);
    }
    tile.addEventListener('click', () => {
      picked = tier;
      paint();
      $(`.vp__tier[data-tier="${tier}"]`, root)?.focus();
    });
    grid.appendChild(tile);
  }
  wrap.appendChild(grid);

  const rows = levels.filter((entry) => entry.tier === open);
  const table = el('div', 'vp__levels');
  table.dataset.tier = open;
  const head = el('div', 'vp__lrow vp__lrow--head');
  head.innerHTML = '<span>Level</span><span>Wager to reach</span><span>Rakeback</span><span></span>';
  table.appendChild(head);
  for (const level of rows) {
    const row = el('div', 'vp__lrow');
    const state = !data ? '' : level.level < myLevel ? 'done' : level.level === myLevel ? 'here' : 'locked';
    if (state) row.dataset.state = state;
    const name = el('span', 'vp__lname');
    name.textContent = level.label;
    const need = el('span', 'vp__lneed');
    need.textContent = Number(level.thresholdMinor) === 0 ? 'Start' : money(Number(level.thresholdMinor));
    const rate = el('span', 'vp__lrate');
    rate.textContent = ratePct(level.ratePercent);
    const badge = el('span', 'vp__lstate');
    badge.textContent = state === 'here' ? 'You are here' : state === 'done' ? '✓' : '';
    row.append(name, need, rate, badge);
    table.appendChild(row);
  }
  wrap.appendChild(table);
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
