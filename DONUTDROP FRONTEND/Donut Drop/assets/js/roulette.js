/* roulette.js — one server-owned European wheel shared by every browser. */
import { api, idempotencyKey } from './api.js';
import { state, refreshBalance } from './store.js';
import { tableAvatar } from './table-avatar.js';
import { $, money, reduceMotion } from './util.js';
import { toast } from './ui.js';

const ORDER = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]);
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
// Live invalidations are the normal path. A slow poll repairs missed events; old browsers without
// EventSource use a faster fallback and are still subject to the freshness lock below.
const LIVE_SUPPORTED = 'EventSource' in window;
const POLL_MS = LIVE_SUPPORTED ? 15_000 : 2_500;
const LIVE_STALE_MS = 6_000;
/* The floor on how long a snapshot stays trustworthy without the event stream.
 *
 * It has to cover the longest gap the deadline chain can leave, which is a whole betting window:
 * the client refreshes when the round opens and again when it closes, and nothing happens in
 * between because nothing CAN happen in between. A fixed 4.5s here locked betting four seconds
 * into every ten-second round on any browser whose event stream was not delivering. The real
 * window is read from the round the server published. */
const POLL_STALE_FLOOR_MS = 4_500;
const CHIPS = Object.freeze([
  [100_000n, '$100K'],
  [500_000n, '$500K'],
  [1_000_000n, '$1M'],
  [5_000_000n, '$5M'],
  [10_000_000n, '$10M'],
  [50_000_000n, '$50M'],
  [100_000_000n, '$100M'],
  [500_000_000n, '$500M'],
  [1_000_000_000n, '$1B'],
]);
const OUTSIDE = Object.freeze([
  ['low', '1–18'],
  ['even', 'Even'],
  ['red', 'Red'],
  ['black', 'Black'],
  ['odd', 'Odd'],
  ['high', '19–36'],
  ['dozen:1', '1st 12'],
  ['dozen:2', '2nd 12'],
  ['dozen:3', '3rd 12'],
]);

let root;
let snapshot;
let selected = 'red';
let amountMinor = 1_000_000n;
let serverOffsetMs = 0;
let polling = false;
let placing = false;
let seenResultId = null;
let pendingResultId = null;
let wheelRotation = 0;
let lastSuccessfulSyncMs = 0;
let lastLivePulseMs = 0;
let deadlineTimer = null;

export function mountRoulette(view) {
  root = $('#rouletteRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    window.setInterval(() => {
      if (!view.hidden) void refresh();
    }, POLL_MS);
    window.setInterval(paintClock, 100);
    window.addEventListener('donut:roulette', () => {
      if (!view.hidden) void refresh();
    });
    window.addEventListener('donut:live-status', (event) => {
      if (event.detail?.connected) lastLivePulseMs = Number(event.detail.at) || Date.now();
      else if (event.detail?.supported !== false) lastLivePulseMs = 0;
      paintClock();
      if (event.detail?.connected && !view.hidden) void refresh();
    });
  }
  void refresh();
}

function build() {
  root.innerHTML = `
    <section class="roulette__stage" aria-label="Shared roulette wheel">
      <div class="roulette__roundline">
        <span class="roulette__live"><i></i> SHARED TABLE</span>
        <strong class="roulette__clock mono" id="rouletteClock">—</strong>
      </div>
      <div class="roulette__wheelwrap">
        <span class="roulette__pointer" aria-hidden="true"></span>
        <div class="roulette__wheel" id="rouletteWheel" aria-hidden="true"></div>
        <div class="roulette__hub"><b id="rouletteResult">—</b></div>
      </div>
      <div class="roulette__history" id="rouletteHistory" aria-label="Recent results"></div>
    </section>

    <section class="roulette__board">
      <div class="roulette__guide">
        <span><b>1</b> Pick a chip</span>
        <i aria-hidden="true">→</i>
        <span><b>2</b> Click a bet</span>
        <strong id="roulettePhase" role="status" aria-live="polite">Connecting to the table…</strong>
      </div>
      <div class="roulette__numbers" id="rouletteNumbers"></div>
      <div class="roulette__outside" id="rouletteOutside"></div>
      <div class="roulette__slip">
        <div class="roulette__choice">
          <span>ACTIVE CHIP</span><strong id="rouletteChipValue">$1M</strong>
          <i class="mono" id="rouletteChoice">Red · 1.85× return</i>
        </div>
        <div class="roulette__chips" id="rouletteChips" aria-label="Choose a chip"></div>
        <p class="roulette__limits mono" id="rouletteLimits">Loading table limits…</p>
      </div>
      <div class="roulette__mine">
        <div class="roulette__subhead"><strong>Your chips this round</strong><span id="rouletteMineTotal">$0</span></div>
        <div class="roulette__bets" id="rouletteBets"><span class="roulette__empty">No chips placed yet.</span></div>
      </div>
      <section class="roulette__livebets" aria-labelledby="rouletteLiveBetsTitle">
        <div class="roulette__subhead">
          <strong id="rouletteLiveBetsTitle">Live bets</strong>
          <span id="rouletteLiveBetCount">0 chips</span>
        </div>
        <div class="roulette__tablewrap">
          <table class="roulette__table">
            <thead><tr><th>Player</th><th>Bet</th><th>Chip</th></tr></thead>
            <tbody id="roulettePublicBets"></tbody>
          </table>
        </div>
      </section>
      <details class="roulette__fair">
        <summary>Round fairness</summary>
        <dl>
          <div><dt>Round</dt><dd class="mono" id="rouletteRound">—</dd></div>
          <div><dt>Commitment</dt><dd class="mono" id="rouletteCommit">—</dd></div>
          <div><dt>Edge</dt><dd class="mono" id="rouletteEdge">—</dd></div>
        </dl>
        <p>The seed is committed before betting, then revealed with the result. Verify it with HMAC-SHA256 using the round ID and nonce 0.</p>
      </details>
    </section>`;

  buildWheel();
  const numbers = $('#rouletteNumbers', root);
  for (let value = 0; value <= 36; value += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `roulette__number roulette__number--${color(value)}`;
    button.dataset.selection = `straight:${value}`;
    button.textContent = String(value);
    numbers.append(button);
  }
  const outside = $('#rouletteOutside', root);
  for (const [selection, label] of OUTSIDE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.selection = selection;
    button.textContent = label;
    if (selection === 'red' || selection === 'black') button.dataset.color = selection;
    outside.append(button);
  }
  const chips = $('#rouletteChips', root);
  for (const [value, label] of CHIPS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.chip = value.toString();
    button.textContent = label;
    button.setAttribute('aria-label', `${label} chip`);
    chips.append(button);
  }
  root.addEventListener('click', onClick);
  syncSelection();
}

function buildWheel() {
  const wheel = $('#rouletteWheel', root);
  const step = 360 / ORDER.length;
  const stops = ORDER.map((number, index) => {
    const start = (index * step).toFixed(5);
    const end = ((index + 1) * step).toFixed(5);
    const shade = number === 0 ? '#169b62' : RED.has(number) ? '#b52428' : '#17181d';
    return `${shade} ${start}deg ${end}deg`;
  });
  wheel.style.background = `conic-gradient(from -${step / 2}deg, ${stops.join(',')})`;
  ORDER.forEach((number, index) => {
    const label = document.createElement('span');
    label.textContent = String(number);
    label.style.setProperty('--pocket-angle', `${index * step}deg`);
    wheel.append(label);
  });
}

function onClick(event) {
  const choice = event.target.closest('[data-selection]');
  if (choice && root.contains(choice)) {
    selected = choice.dataset.selection;
    syncSelection();
    void place(selected);
    return;
  }
  const chip = event.target.closest('[data-chip]');
  if (chip && root.contains(chip)) {
    amountMinor = BigInt(chip.dataset.chip);
    syncSelection();
  }
}

function payoutBps() {
  if (!snapshot?.config?.payoutBps) return 0;
  if (selected.startsWith('straight:')) return snapshot.config.payoutBps.straight;
  if (selected.startsWith('dozen:')) return snapshot.config.payoutBps.dozen;
  return snapshot.config.payoutBps.evenMoney;
}

function labelFor(selection) {
  if (selection.startsWith('straight:')) return `Number ${selection.slice(9)}`;
  return OUTSIDE.find(([value]) => value === selection)?.[1] || selection;
}

function syncSelection() {
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.selection === selected);
    button.setAttribute('aria-pressed', button.dataset.selection === selected ? 'true' : 'false');
  });
  const choice = $('#rouletteChoice', root);
  const chipValue = $('#rouletteChipValue', root);
  const multiplier = (payoutBps() / 10_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (choice) choice.textContent = `${labelFor(selected)} · ${multiplier}× return`;
  if (chipValue) chipValue.textContent = money(Number(amountMinor));
  paintControls();
}

/** Everything this player already has riding on the open round. */
function roundStakedMinor() {
  return (snapshot?.yourBets || []).reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
}

/** What is left of the table limit, floored at zero. */
function roundAllowanceMinor() {
  const cap = BigInt(snapshot?.config?.maxRoundStakeMinor || '0');
  if (cap <= 0n) return null;
  const left = cap - roundStakedMinor();
  return left > 0n ? left : 0n;
}

function paintControls() {
  const min = BigInt(snapshot?.config?.minStakeMinor || '0');
  const max = BigInt(snapshot?.config?.maxStakeMinor || '0');
  const allowance = roundAllowanceMinor();
  /* At the table limit the whole board goes dead, not just the chips. A layout that leaves the
     numbers pressable and answers every one of them with the same refusal is a board that looks
     broken; the player has not done anything wrong, they have finished betting this spin. */
  const atLimit = allowance !== null && allowance < min;
  const tableLocked = placing || !isBettingOpen() || !state.authenticated || atLimit;
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.disabled = tableLocked;
  });
  root.querySelectorAll('[data-chip]').forEach((button) => {
    const value = BigInt(button.dataset.chip);
    /* A chip is offered only if it would still fit. The server decides, under a lock; this is
       here so the limit is visible before it is hit rather than arriving as a rejection. */
    const inLimits = value >= min && value <= max && (allowance === null || value <= allowance);
    button.disabled = placing || !snapshot || !inLimits;
    button.classList.toggle('is-selected', value === amountMinor);
    button.setAttribute('aria-pressed', value === amountMinor ? 'true' : 'false');
  });
}

function serverNowMs() {
  return Date.now() + serverOffsetMs;
}

function untilOpenMs() {
  const opens = Date.parse(snapshot?.round?.opensAt || '');
  return Number.isFinite(opens) ? opens - serverNowMs() : 0;
}

function remainingMs() {
  const close = Date.parse(snapshot?.round?.closesAt || '');
  return Number.isFinite(close) ? close - serverNowMs() : 0;
}

function isBettingOpen() {
  return Boolean(snapshot?.round) && connectionFresh() && untilOpenMs() <= 0 && remainingMs() > 0;
}

/**
 * Whether this page is current enough to bet from.
 *
 * EITHER source counts. This used to trust only the event stream whenever the browser HAD an
 * EventSource, which meant a stream that connected and then stopped delivering left
 * `lastLivePulseMs` stale forever — betting locked, permanently, on a page that was refreshing
 * perfectly well over HTTP. A transport nobody can see failing is not a reason to refuse a player
 * who is looking at a live snapshot.
 *
 * Leaning permissive is the safe direction here: the server re-checks the round under a lock and
 * answers a late chip with ROUND_CLOSED, so being too generous costs one rejected bet, while being
 * too strict costs the whole game.
 */
function connectionFresh() {
  if (!lastSuccessfulSyncMs) return false;
  const liveFresh = lastLivePulseMs > 0 && Date.now() - lastLivePulseMs <= LIVE_STALE_MS;
  const window = Math.max(
    POLL_STALE_FLOOR_MS,
    (Number(snapshot?.config?.roundSeconds || 0) + Number(snapshot?.config?.spinSeconds || 0)) *
      1000 +
      3_000,
  );
  const pollFresh = Date.now() - lastSuccessfulSyncMs <= window;
  return liveFresh || pollFresh;
}

/**
 * Refresh exactly when the table is next due to change, rather than hoping a poll lands on it.
 *
 * The round carries its own two deadlines, so the client already knows when the wheel starts and
 * when betting closes. Waiting for a blind interval to rediscover that is how a 15-second poll
 * ended up slower than a 13-second round: miss one live event and the page sits on SETTLING until
 * something else happens to fetch.
 *
 * Two timed requests per round replaces both the old 1.25s poll and the dependence on the event
 * stream — fewer requests than either, and correct on its own if the stream never delivers. Live
 * events still arrive first when they work; this is what makes them an optimisation rather than a
 * requirement.
 */
function scheduleDeadlineRefresh() {
  window.clearTimeout(deadlineTimer);
  if (!root?.isConnected) return;
  const untilOpen = untilOpenMs();
  const untilClose = remainingMs();
  /* +250ms so the request lands just AFTER the server's own boundary rather than racing it into
     an answer that still shows the old round. A rollover in progress retries once a second, which
     is self-limiting: it stops the moment the next round exists. */
  const delay = !snapshot?.round
    ? 5_000
    : untilOpen > 0
      ? untilOpen + 250
      : untilClose > 0
        ? untilClose + 250
        : 1_000;
  deadlineTimer = window.setTimeout(() => {
    void refresh();
  }, Math.max(250, Math.min(delay, 30_000)));
}

function paintPhase() {
  const phase = $('#roulettePhase', root);
  if (!phase) return;
  if (!snapshot) {
    phase.textContent = 'Connecting to the table…';
    return;
  }
  if (!connectionFresh()) {
    phase.textContent = 'Reconnecting… bets are locked';
    return;
  }
  if (!snapshot.round) {
    phase.textContent = snapshot.config?.paused
      ? 'Table paused after the last round'
      : 'Preparing the next round…';
    return;
  }
  if (untilOpenMs() > 0) {
    phase.textContent = 'Wheel spinning · bets are locked';
    return;
  }
  if (remainingMs() <= 0) {
    phase.textContent = 'Round closing · waiting for the result';
    return;
  }
  if (!state.authenticated) {
    phase.textContent = 'Log in to place a chip';
    return;
  }
  phase.textContent = placing
    ? `Placing ${money(Number(amountMinor))}…`
    : `Betting open · click a spot to place ${money(Number(amountMinor))}`;
}

function paintClock() {
  if (!root?.isConnected) return;
  const untilOpen = Math.max(0, untilOpenMs());
  const remaining = Math.max(0, remainingMs());
  const spinning = Boolean(snapshot) && untilOpen > 0;
  const stale = Boolean(snapshot) && !connectionFresh();
  const clock = $('#rouletteClock', root);
  if (clock) {
    clock.textContent = stale
      ? 'RECONNECTING'
      : !snapshot?.round && snapshot?.config?.paused
        ? 'PAUSED'
        : spinning
          ? 'SPINNING'
          : remaining > 0
            ? `${(remaining / 1000).toFixed(1)}s`
            : 'SETTLING';
  }
  root.dataset.phase = stale
    ? 'reconnecting'
    : !snapshot?.round
      ? 'paused'
      : spinning
        ? 'spinning'
        : remaining > 0
          ? 'betting'
          : 'settling';
  root.dataset.connection = stale ? 'stale' : 'live';
  root.classList.toggle('is-locked', !isBettingOpen());
  paintPhase();
  paintControls();
}

async function refresh() {
  if (polling || !root?.isConnected) return;
  polling = true;
  try {
    const next = await api.get('/v1/roulette');
    const receivedAt = Date.now();
    lastSuccessfulSyncMs = receivedAt;
    serverOffsetMs = Date.parse(next.serverTime) - receivedAt;
    const newest = next.history?.[0];
    const spinInProgress = Date.parse(next.round?.opensAt || '') > Date.now() + serverOffsetMs;
    const shouldSpin = Boolean(
      newest?.id &&
      ((seenResultId !== null && newest.id !== seenResultId) ||
        (seenResultId === null && spinInProgress)),
    );
    if (newest?.id) seenResultId = newest.id;
    if (shouldSpin) pendingResultId = newest.id;
    snapshot = next;
    paint();
    if (shouldSpin) {
      const spinEndsAt =
        next.round?.opensAt ||
        new Date(Date.parse(next.serverTime) + Number(next.config?.spinSeconds || 0) * 1000).toISOString();
      spinTo(newest.result, next.yourPreviousBets || [], spinEndsAt);
    }
    else if (newest?.result != null && wheelRotation === 0) setWheel(newest.result);
    scheduleDeadlineRefresh();
  } catch (error) {
    root.dataset.error = '1';
    lastLivePulseMs = 0;
    paintClock();
    /* A failed fetch still has to come back. Without this the deadline chain ends on the first
       blip and the table never recovers on its own. */
    scheduleDeadlineRefresh();
  } finally {
    polling = false;
  }
}

function paint() {
  root.dataset.error = '';
  const config = snapshot.config;
  $('#rouletteRound', root).textContent = snapshot.round?.id || 'Paused';
  $('#rouletteCommit', root).textContent = snapshot.round?.serverSeedHash || '—';
  $('#rouletteEdge', root).textContent = `${(config.houseEdgeBps / 100).toFixed(2)}%`;
  $('#rouletteLimits', root).textContent =
    `${money(Number(config.minStakeMinor))} min · ${money(Number(config.maxStakeMinor))} max per chip`
    + (config.maxRoundStakeMinor
      ? ` · ${money(Number(config.maxRoundStakeMinor))} table limit per spin`
      : '')
    + ` · ${config.spinSeconds}s spin then ${config.roundSeconds}s betting`;

  paintHistory();

  const visibleResult = visibleHistory()[0]?.result;
  if (visibleResult != null && !$('#rouletteWheel', root).classList.contains('is-spinning')) {
    $('#rouletteResult', root).textContent = String(visibleResult);
  }
  paintPools();
  paintBets();
  paintPublicBets();
  paintClock();
  syncSelection();
}

function visibleHistory() {
  return (snapshot?.history || []).filter((round) => round.id !== pendingResultId);
}

function paintHistory() {
  const history = $('#rouletteHistory', root);
  history.replaceChildren(
    ...visibleHistory()
      .slice(0, 10)
      .map((round) => {
        const node = document.createElement('span');
        node.className = `roulette__past roulette__past--${round.color}`;
        node.textContent = String(round.result);
        node.title = `Round ${round.id}`;
        return node;
      }),
  );
}

function paintPools() {
  root.querySelectorAll('[data-selection]').forEach((button) => {
    button.querySelector('.roulette__pool')?.remove();
    const amount = Number(snapshot.pools?.[button.dataset.selection] || 0);
    if (amount <= 0) return;
    const pool = document.createElement('small');
    pool.className = 'roulette__pool';
    pool.textContent = money(amount);
    button.append(pool);
  });
}

function paintBets() {
  const host = $('#rouletteBets', root);
  const bets = snapshot.yourBets || [];
  host.replaceChildren();
  if (!bets.length) {
    const empty = document.createElement('span');
    empty.className = 'roulette__empty';
    empty.textContent = state.authenticated ? 'No chips placed yet.' : 'Log in to place a chip.';
    host.append(empty);
  } else {
    for (const bet of bets) {
      const row = document.createElement('span');
      row.className = 'roulette__bet';
      const name = document.createElement('b');
      name.textContent = labelFor(bet.selection);
      const value = document.createElement('i');
      value.textContent = money(Number(bet.stakeMinor));
      row.append(name, value);
      host.append(row);
    }
  }
  /* The total, and what is left of the table limit beside it. A running total on its own answers
     "how much am I in for"; the pair answers "can I place another chip", which is the question
     somebody looking at this line is actually asking. */
  const total = roundStakedMinor();
  const allowance = roundAllowanceMinor();
  $('#rouletteMineTotal', root).textContent =
    allowance === null
      ? money(Number(total))
      : `${money(Number(total))} · ${money(Number(allowance))} left`;
}

function paintPublicBets() {
  const host = $('#roulettePublicBets', root);
  const bets = snapshot.publicBets || [];
  host.replaceChildren();
  $('#rouletteLiveBetCount', root).textContent =
    `${bets.length} ${bets.length === 1 ? 'chip' : 'chips'}`;

  if (!bets.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'roulette__tableempty';
    cell.textContent = 'No bets on this round yet.';
    row.append(cell);
    host.append(row);
    return;
  }

  for (const bet of bets) {
    const row = document.createElement('tr');
    row.dataset.you = bet.isViewer ? '1' : '0';

    const player = document.createElement('td');
    player.className = 'roulette__player';
    const name = document.createElement('span');
    name.textContent = bet.isViewer ? 'You' : bet.player;
    player.append(tableAvatar(bet.playerId), name);

    const selection = document.createElement('td');
    selection.textContent = labelFor(bet.selection);

    const stake = document.createElement('td');
    stake.className = 'roulette__tablemoney mono';
    stake.textContent = money(Number(bet.stakeMinor));

    row.append(player, selection, stake);
    host.append(row);
  }
}

async function place(selection) {
  if (placing || !isBettingOpen()) return;
  const placedSelection = selection;
  const placedAmount = amountMinor;
  placing = true;
  paintControls();
  try {
    await api.post(
      '/v1/roulette/bets',
      {
        roundId: snapshot.round.id,
        selection: placedSelection,
        stakeMinor: placedAmount.toString(),
      },
      { idempotencyKey: idempotencyKey() },
    );
    await Promise.all([refreshBalance(), refresh()]);
    toast({
      kind: 'win',
      title: 'Bet placed',
      body: `${money(Number(placedAmount))} on ${labelFor(placedSelection)}`,
    });
  } catch (error) {
    toast({
      kind: 'lose',
      title: String(error?.code || 'Bet failed').replaceAll('_', ' '),
      body: error?.message || 'The server rejected the bet.',
    });
    await refresh();
  } finally {
    placing = false;
    paintControls();
  }
}

function setWheel(result) {
  const index = ORDER.indexOf(Number(result));
  if (index < 0) return;
  wheelRotation = -((index * 360) / ORDER.length);
  const wheel = $('#rouletteWheel', root);
  wheel.style.transition = 'none';
  wheel.style.transform = `rotate(${wheelRotation}deg)`;
}

function spinTo(result, bets, opensAt) {
  const index = ORDER.indexOf(Number(result));
  if (index < 0) return;
  const wheel = $('#rouletteWheel', root);
  const target = -((index * 360) / ORDER.length);
  const normalized = ((wheelRotation % 360) + 360) % 360;
  const targetNormalized = ((target % 360) + 360) % 360;
  const delta = (targetNormalized - normalized + 360) % 360;
  const parsedOpen = Date.parse(opensAt);
  const spinWindowMs = Number.isFinite(parsedOpen) ? Math.max(0, parsedOpen - serverNowMs()) : 0;
  const animationMs = reduceMotion() || spinWindowMs <= 150 ? 0 : spinWindowMs - 100;
  wheelRotation += (animationMs === 0 ? 0 : 5 * 360) + delta;

  const finish = () => {
    wheel.classList.remove('is-spinning');
    pendingResultId = null;
    $('#rouletteResult', root).textContent = String(result);
    paintHistory();
    announceResult(result, bets);
    void refreshBalance();
  };

  if (animationMs === 0) {
    wheel.style.transition = 'none';
    wheel.style.transform = `rotate(${wheelRotation}deg)`;
    finish();
    return;
  }

  wheel.style.transition = `transform ${animationMs}ms cubic-bezier(.12,.68,.16,1)`;
  wheel.classList.add('is-spinning');
  $('#rouletteResult', root).textContent = '•';
  requestAnimationFrame(() => {
    wheel.style.transform = `rotate(${wheelRotation}deg)`;
  });
  window.setTimeout(finish, animationMs + 40);
}

function announceResult(result, bets) {
  if (!bets.length) return;
  const staked = bets.reduce((sum, bet) => sum + BigInt(bet.stakeMinor), 0n);
  const paid = bets.reduce((sum, bet) => sum + BigInt(bet.payoutMinor || '0'), 0n);
  toast({
    kind: paid > 0n ? 'win' : 'lose',
    title: paid > 0n ? `${result} hit — you won` : `${result} hit`,
    body:
      paid > 0n
        ? `${money(Number(paid))} returned on ${money(Number(staked))} staked`
        : `${money(Number(staked))} lost this round`,
  });
}

function color(number) {
  if (number === 0) return 'green';
  return RED.has(number) ? 'red' : 'black';
}
