/* duel.js — 1v1 Skill Duels: the lobby, the arena and the settlement.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLOCK PROBLEM, AND WHY THIS FILE IS SHAPED AROUND IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every round opens at a wall-clock instant the server names in advance (`startsAt`). Both
 * players open it at the same instant, so neither is answering a cue that fired late for them,
 * and each measures its own player's reaction LOCALLY against that instant — a number with no
 * network latency in it at all.
 *
 * That only works if the two clocks agree, and they do not: a browser's `Date.now()` can sit
 * seconds away from the server's. So the first thing the socket does is measure the offset from
 * the `hello` frame and keep measuring it on every pong; `serverToLocal()` applies it. Skipping
 * that step would hand every round to whichever player's machine happened to run fast.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES NOT KNOW
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It never learns the cue offset in advance — the round frame does not carry it, and the cue
 * arrives as its own frame at the moment it is due. It never computes a score, a winner or a
 * payout. All of that is the server's, because a client that could compute its own result is a
 * client that could report a better one.
 */
import { state, bus } from './store.js';
import { $, el, money, clamp } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';
import { API_BASE_URL, api } from './api.js';

let root = null;
let socket = null;
let reconnectTimer = 0;

/** Server clock minus local clock, in ms. See the header. */
let clockSkewMs = 0;

/** Lobby list plus the platform's duel configuration, as last read. */
let board = { duels: [], rakeBps: 300, minStakeMinor: '0', maxStakeMinor: '0', variants: [] };

/** The duel this client is currently inside, or null when we are looking at the lobby. */
let active = null;

/** Per-round local state. Rebuilt on every `duel:round`. */
let round = null;

const VARIANT_LABEL = {
  reflex: 'Reflex',
  precision: 'Precision',
  sequence: 'Sequence',
};

const SYMBOLS = ['▲', '■', '●', '◆', '★', '✦'];

/* ═════════════════════════ entry ═════════════════════════ */

export function mountDuel(view) {
  root = $('#duelRoot', view);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) void refresh();
    });
  }
  connect();
  void refresh();
}

async function refresh() {
  try {
    board = await api.get('/v1/duels');
  } catch (error) {
    root.replaceChildren(notice(
      error?.code === 'DUELS_DISABLED'
        ? 'Skill duels are not switched on yet.'
        : 'The duel lobby could not be loaded.',
    ));
    return;
  }
  /* A duel we are already inside outranks the lobby: reloading the page mid-match should drop
   * straight back into the arena rather than to a list with our own match on it. */
  const mine = board.duels.find((duel) => duel.status === 'running'
    && (duel.host.isYou || duel.opponent?.isYou));
  if (mine && !active) {
    active = mine;
    watch(mine.code);
  }
  render();
}

/* ═════════════════════════ transport ═════════════════════════ */

function socketUrl() {
  return `${API_BASE_URL.replace(/^http/, 'ws')}/v1/duels/live`;
}

function connect() {
  if (socket && socket.readyState <= 1) return;
  try {
    socket = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    if (active?.code) send({ type: 'watch', code: active.code });
    /* Re-measure the offset periodically. A laptop that sleeps mid-duel wakes with a clock that
     * has drifted, and a stale offset is worse than none. */
    window.setInterval(() => send({ type: 'ping' }), 20_000);
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handle(message);
  });
  socket.addEventListener('close', () => scheduleReconnect());
  socket.addEventListener('error', () => {
    try { socket?.close(); } catch { /* already gone */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !root?.isConnected) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, 2_000);
}

function send(frame) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(frame));
}

function watch(code) {
  send({ type: 'watch', code });
}

/** Converts a server wall-clock instant into this machine's clock. */
function serverToLocal(serverMs) {
  return serverMs - clockSkewMs;
}

function handle(message) {
  switch (message.type) {
    case 'hello':
    case 'pong':
      /* One-way delay is ignored on purpose. Half the round trip would be a better estimate, but
       * the numbers that matter here are differences between two instants on the SAME clock, and
       * a constant bias cancels out of a difference. */
      clockSkewMs = message.now - Date.now();
      break;

    case 'duel:created':
      if (!board.duels.some((duel) => duel.code === message.duel.code)) {
        board.duels.unshift(message.duel);
        if (!active) render();
      }
      break;

    case 'duel:removed':
      board.duels = board.duels.filter((duel) => duel.code !== message.code);
      if (!active) render();
      break;

    case 'duel:joined':
      active = message.duel;
      playSound('anvil');
      render();
      break;

    case 'duel:round':
      openRound(message);
      break;

    case 'duel:cue':
      fireCue(message);
      break;

    case 'duel:scored':
      showScore(message);
      break;

    case 'duel:settled':
      settle(message.duel);
      break;

    case 'duel:cancelled':
      if (active?.code === message.code) {
        active = null;
        toast({ kind: 'gold', title: 'DUEL CANCELLED', body: message.reason });
        void refresh();
      }
      break;

    default:
      break;
  }
}

/* ═════════════════════════ lobby ═════════════════════════ */

function notice(text) {
  const box = el('p', 'empty');
  box.textContent = text;
  return box;
}

/** A player chip. Initials in gold rather than a skin render: the CSP allows no third-party
 *  images, and a duel does not need one to say who is on which side. */
function avatar(name, size = 'md') {
  const node = el('span', `duelav duelav--${size}`);
  node.textContent = (name || '?').slice(0, 2).toUpperCase();
  return node;
}

function render() {
  if (active) { renderArena(); return; }

  const wrap = el('div', 'duel');

  /* ── the rules, as metric badges ── */
  const badges = el('div', 'duel__badges');
  for (const [value, label] of [
    [`${(board.rakeBps / 100).toFixed(board.rakeBps % 100 === 0 ? 0 : 1)}%`, 'HOUSE RAKE'],
    ['0%', 'HOUSE EDGE'],
    ['10s', 'ROUND LIMIT'],
    ['SERVER', 'VALIDATED'],
  ]) {
    const badge = el('span', 'duel__badge');
    badge.append(Object.assign(el('b'), { textContent: value }),
      Object.assign(el('i'), { textContent: label }));
    badges.append(badge);
  }
  wrap.append(badges);

  /* ── create ── */
  const head = el('div', 'duel__head');
  const title = el('h2', 'duel__h');
  title.textContent = 'Open challenges';
  const create = el('button', 'btn btn--go');
  create.textContent = 'Create duel';
  create.addEventListener('click', openCreate);
  head.append(title, create);
  wrap.append(head);

  /* ── the table ── */
  const open = board.duels.filter((duel) => duel.status === 'lobby');
  if (!open.length) {
    wrap.append(notice('No open duels. Create one and the board will show it.'));
    root.replaceChildren(wrap);
    return;
  }

  const table = el('div', 'duel__table');
  const header = el('div', 'duel__row duel__row--head');
  for (const [label, cls] of [
    ['CHALLENGER', 'who'], ['STAKE', 'stake'], ['MODE', 'mode'],
    ['RAKE', 'rake'], ['WINNER TAKES', 'take'], ['', 'go'],
  ]) {
    const cell = el('span', `duel__c duel__c--${cls}`);
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);

  for (const duel of open) {
    const row = el('div', 'duel__row');
    row.dataset.mine = duel.host.isYou ? '1' : '0';

    const who = el('span', 'duel__c duel__c--who');
    who.append(avatar(duel.host.name), Object.assign(el('b'), {
      textContent: duel.host.name || 'Player',
    }));
    if (duel.visibility === 'private') {
      const lock = el('i', 'duel__lock');
      lock.textContent = 'PRIVATE';
      who.append(lock);
    }

    const stake = el('span', 'duel__c duel__c--stake mono');
    stake.textContent = money(Number(duel.stakeMinor));

    const mode = el('span', 'duel__c duel__c--mode');
    mode.textContent = VARIANT_LABEL[duel.variant] ?? duel.variant;

    const rake = el('span', 'duel__c duel__c--rake mono');
    rake.textContent = money(Number(duel.rakeMinor));

    const take = el('span', 'duel__c duel__c--take mono');
    take.textContent = money(Number(duel.payoutMinor));

    const go = el('span', 'duel__c duel__c--go');
    if (duel.host.isYou) {
      const cancel = el('button', 'btn btn--tiny');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => void cancelDuel(duel.code));
      go.append(cancel);
    } else {
      const join = el('button', 'btn btn--go btn--tiny');
      join.textContent = 'JOIN BATTLE';
      join.addEventListener('click', () => void joinDuel(duel));
      go.append(join);
    }

    row.append(who, stake, mode, rake, take, go);
    table.append(row);
  }

  wrap.append(table);
  root.replaceChildren(wrap);
}

/* ═════════════════════════ create ═════════════════════════ */

function openCreate() {
  const min = Number(board.minStakeMinor);
  const max = Number(board.maxStakeMinor);
  let stake = clamp(1_000_000, min, max);
  let variant = 'reflex';
  let visibility = 'public';

  const body = el('div', 'duelnew');

  const figure = el('div', 'duelnew__fig');
  const amount = el('b', 'duelnew__amt mono');
  const breakdown = el('span', 'duelnew__split mono');
  figure.append(amount, breakdown);

  const paint = () => {
    stake = clamp(Math.floor(stake), min, max);
    amount.textContent = money(stake);
    const pot = stake * 2;
    const rake = Math.floor((pot * board.rakeBps) / 10_000);
    breakdown.textContent = `POT ${money(pot)} · RAKE ${money(rake)} · WIN ${money(pot - rake)}`;
  };

  /* ── quick stake ── */
  const chips = el('div', 'qchips');
  const step = (label, fn) => {
    const chip = el('button', 'qchip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => { stake = fn(stake); paint(); });
    chips.append(chip);
  };
  step('+$1M', (v) => v + 1_000_000);
  step('+$10M', (v) => v + 10_000_000);
  step('+$100M', (v) => v + 100_000_000);
  step('&frac12;x', (v) => Math.floor(v / 2));
  step('2x', (v) => v * 2);
  const maxChip = el('button', 'qchip qchip--max', 'MAX');
  maxChip.type = 'button';
  maxChip.addEventListener('click', () => {
    /* The wallet, not the configured ceiling: MAX means "everything I have", and offering more
     * than the balance is an error dialog dressed up as a shortcut. */
    stake = clamp(Number(state.balance ?? 0), min, max);
    paint();
  });
  chips.append(maxChip);

  /* ── mode ── */
  const modes = el('div', 'duelnew__seg');
  for (const option of board.variants) {
    const button = el('button', 'duelnew__opt');
    button.type = 'button';
    button.dataset.on = option.variant === variant ? '1' : '0';
    button.append(
      Object.assign(el('b'), { textContent: VARIANT_LABEL[option.variant] ?? option.variant }),
      Object.assign(el('i'), { textContent: `${option.rounds} ROUNDS` }),
    );
    button.addEventListener('click', () => {
      variant = option.variant;
      [...modes.children].forEach((node) => { node.dataset.on = node === button ? '1' : '0'; });
    });
    modes.append(button);
  }

  /* ── visibility ── */
  const rooms = el('div', 'duelnew__seg duelnew__seg--two');
  const secret = el('input', 'duelnew__secret');
  secret.type = 'password';
  secret.placeholder = 'Room password';
  secret.maxLength = 64;
  secret.hidden = true;
  for (const [value, label, sub] of [
    ['public', 'Public', 'ANY PLAYER'],
    ['private', 'Private', 'PASSWORD'],
  ]) {
    const button = el('button', 'duelnew__opt');
    button.type = 'button';
    button.dataset.on = value === visibility ? '1' : '0';
    button.append(Object.assign(el('b'), { textContent: label }),
      Object.assign(el('i'), { textContent: sub }));
    button.addEventListener('click', () => {
      visibility = value;
      [...rooms.children].forEach((node) => { node.dataset.on = node === button ? '1' : '0'; });
      secret.hidden = visibility !== 'private';
    });
    rooms.append(button);
  }

  const go = el('button', 'btn btn--go btn--wide btn--lg');
  go.textContent = 'OPEN CHALLENGE';
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const created = await api.post('/v1/duels', {
        variant,
        stakeMinor: String(stake),
        visibility,
        ...(visibility === 'private' ? { joinSecret: secret.value } : {}),
      });
      closeModal();
      playSound('anvil');
      active = created;
      watch(created.code);
      render();
    } catch (error) {
      toast({ kind: 'red', title: 'NOT CREATED', body: error?.message || 'Try again' });
      go.disabled = false;
    }
  });

  body.append(figure, chips, modes, rooms, secret, go);
  paint();
  openModal('New duel', (host) => host.append(body));
}

/* ═════════════════════════ joining ═════════════════════════ */

async function joinDuel(duel) {
  let joinSecret;
  if (duel.visibility === 'private') {
    joinSecret = window.prompt('Room password');
    if (!joinSecret) return;
  }
  try {
    active = await api.post(`/v1/duels/${duel.code}/join`, joinSecret ? { joinSecret } : {});
    watch(active.code);
    playSound('anvil');
    render();
  } catch (error) {
    toast({ kind: 'red', title: 'CANNOT JOIN', body: error?.message || 'Try again' });
  }
}

async function cancelDuel(code) {
  try {
    await api.post(`/v1/duels/${code}/cancel`, {});
    toast({ kind: 'gold', title: 'CANCELLED', body: 'Your stake is back in your wallet' });
    await refresh();
  } catch (error) {
    toast({ kind: 'red', title: 'NOT CANCELLED', body: error?.message || 'Try again' });
  }
}

/* ═════════════════════════ the arena ═════════════════════════ */

function renderArena() {
  const wrap = el('div', 'arena');
  const youAreHost = active.host.isYou;

  const side = (player, which) => {
    const panel = el('div', `arena__side arena__side--${which}`);
    panel.dataset.you = player?.isYou ? '1' : '0';
    panel.append(
      avatar(player?.name, 'lg'),
      Object.assign(el('b', 'arena__name'), { textContent: player?.name || 'Waiting…' }),
      Object.assign(el('span', 'arena__stake mono'), {
        textContent: money(Number(active.stakeMinor)),
      }),
    );
    const status = el('span', 'arena__status');
    status.dataset.role = which;
    status.textContent = active.status === 'running' ? 'READY' : 'WAITING';
    panel.append(status);
    const rounds = el('span', 'arena__rounds mono');
    rounds.dataset.role = which;
    rounds.textContent = '0';
    panel.append(rounds);
    return panel;
  };

  const stage = el('div', 'arena__stage');
  stage.id = 'duelStage';
  const cue = el('div', 'arena__cue');
  cue.id = 'duelCue';
  const label = el('div', 'arena__label');
  label.id = 'duelLabel';
  label.textContent = active.opponent ? 'GET READY' : 'WAITING FOR AN OPPONENT';
  stage.append(cue, label);

  const pot = el('div', 'arena__pot');
  pot.append(
    Object.assign(el('b', 'mono'), { textContent: money(Number(active.potMinor)) }),
    Object.assign(el('i'), { textContent: `POT · RAKE ${(active.rakeBps / 100).toFixed(1)}%` }),
  );

  wrap.append(
    side(youAreHost ? active.host : active.opponent, 'left'),
    stage,
    side(youAreHost ? active.opponent : active.host, 'right'),
    pot,
  );
  root.replaceChildren(wrap);

  /* The whole stage is the input surface: a duel decided on a 200ms reaction must not also be a
   * test of mouse travel to a button. Keyboard gets the same, because a reflex test that only
   * accepts a click excludes anyone who plays on a keyboard. */
  stage.addEventListener('pointerdown', submitInput);
  stage.tabIndex = 0;
  stage.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); submitInput(); }
  });
}

function openRound(message) {
  if (!active || message.code !== active.code) return;
  const localStart = serverToLocal(message.startsAt);

  round = {
    index: message.roundIndex,
    startsAt: localStart,
    roundMs: message.roundMs,
    symbols: message.symbols ?? [],
    cueAt: null,
    sent: false,
    entered: [],
  };

  const label = $('#duelLabel');
  const stage = $('#duelStage');
  const cue = $('#duelCue');
  if (!label || !stage || !cue) return;

  stage.dataset.state = 'countdown';
  cue.dataset.on = '0';
  label.textContent = `ROUND ${message.roundIndex + 1}`;

  const wait = Math.max(0, localStart - Date.now());
  window.setTimeout(() => {
    if (!round || round.index !== message.roundIndex) return;
    stage.dataset.state = active.variant === 'precision' ? 'sweep' : 'armed';
    label.textContent = active.variant === 'precision' ? 'STOP ON THE MARK'
      : active.variant === 'sequence' ? 'REPEAT THE ORDER'
        : 'WAIT FOR GOLD';
    if (active.variant === 'precision') startSweep();
    if (active.variant === 'sequence') showSequence();
  }, wait);
}

/** The reflex cue. Arrives as its own frame at the moment it is due, never in advance. */
function fireCue(message) {
  if (!round || !active || message.code !== active.code) return;
  if (message.roundIndex !== round.index) return;
  round.cueAt = serverToLocal(message.at);
  const stage = $('#duelStage');
  const cue = $('#duelCue');
  const label = $('#duelLabel');
  if (stage) stage.dataset.state = 'cue';
  if (cue) cue.dataset.on = '1';
  if (label) label.textContent = 'NOW';
  playSound('click', { rate: 1.6 });
}

/** The precision needle. One rAF loop against the shared start, so both screens agree. */
function startSweep() {
  const cue = $('#duelCue');
  if (!cue) return;
  const step = () => {
    if (!round || !active) return;
    const elapsed = Date.now() - round.startsAt;
    if (elapsed > round.roundMs || round.sent) return;
    cue.style.setProperty('--sweep', String(clamp(elapsed / round.roundMs, 0, 1)));
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

/** The sequence prompt, then the pad to answer it on. */
function showSequence() {
  const stage = $('#duelStage');
  if (!stage || !round) return;
  const pad = el('div', 'arena__pad');
  round.symbols.forEach((symbol, index) => {
    const slot = el('span', 'arena__sym');
    slot.textContent = SYMBOLS[symbol] ?? '?';
    slot.style.setProperty('--i', String(index));
    pad.append(slot);
  });
  stage.append(pad);

  window.setTimeout(() => {
    pad.remove();
    const answer = el('div', 'arena__pad arena__pad--live');
    SYMBOLS.forEach((glyph, value) => {
      const key = el('button', 'arena__key');
      key.type = 'button';
      key.textContent = glyph;
      key.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!round || round.sent) return;
        round.entered.push(value);
        key.dataset.hit = '1';
        window.setTimeout(() => { key.dataset.hit = '0'; }, 120);
        if (round.entered.length >= round.symbols.length) submitInput();
      });
      answer.append(key);
    });
    stage.append(answer);
  }, 1_600);
}

/**
 * Sends this player's input for the current round.
 *
 * `reportedMs` is measured against the round's shared start on THIS machine — no network in it.
 * The server bounds it against its own arrival time; see duel-engine.ts.
 */
async function submitInput() {
  if (!round || !active || round.sent) return;
  const reportedMs = Math.max(0, Math.round(Date.now() - round.startsAt));
  if (reportedMs > round.roundMs) return;
  round.sent = true;

  const stage = $('#duelStage');
  if (stage) stage.dataset.state = 'sent';
  playSound('click');

  try {
    await api.post(`/v1/duels/${active.code}/input`, {
      roundIndex: round.index,
      reportedMs,
      ...(active.variant === 'sequence' ? { symbols: round.entered } : {}),
    });
  } catch {
    /* A dropped input costs the round, never money. The server closes the round on its own timer
     * regardless, so there is nothing to recover and nothing to warn about. */
  }
}

function showScore(message) {
  if (!active || message.code !== active.code) return;
  const youAreHost = active.host.isYou;
  const label = $('#duelLabel');
  const stage = $('#duelStage');
  if (stage) stage.dataset.state = 'scored';

  const yours = youAreHost ? message.hostScore : message.opponentScore;
  const theirs = youAreHost ? message.opponentScore : message.hostScore;
  const yourVerdict = youAreHost ? message.hostVerdict : message.opponentVerdict;

  const unit = active.variant === 'sequence' ? '' : 'ms';
  if (label) {
    label.textContent = yourVerdict !== 'valid'
      ? VERDICT_COPY[yourVerdict] ?? 'NO RESULT'
      : `${yours}${unit} vs ${theirs === null ? '—' : theirs + unit}`;
  }

  for (const [role, count] of [
    ['left', youAreHost ? message.hostRounds : message.opponentRounds],
    ['right', youAreHost ? message.opponentRounds : message.hostRounds],
  ]) {
    const node = document.querySelector(`.arena__rounds[data-role="${role}"]`);
    if (node) node.textContent = String(count);
  }

  if (yours !== null && theirs !== null) playSound(yours < theirs ? 'coin' : 'lose');
}

const VERDICT_COPY = {
  too_early: 'TOO EARLY',
  too_late: 'TOO SLOW',
  implausible: 'REJECTED',
};

/* ═════════════════════════ settlement ═════════════════════════ */

function settle(duel) {
  active = duel;
  round = null;

  const won = duel.youWon;
  const drew = duel.outcome === 'draw';
  playSound(drew ? 'portal' : won ? 'win' : 'lose');

  const body = el('div', 'duelend');
  body.dataset.result = drew ? 'draw' : won ? 'win' : 'lose';

  const kicker = el('span', 'duelend__kicker');
  kicker.textContent = drew ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';

  const figure = el('b', 'duelend__fig mono');
  figure.textContent = drew
    ? money(Number(duel.stakeMinor))
    : money(Number(won ? duel.payoutMinor : duel.stakeMinor));

  const caption = el('span', 'duelend__cap');
  caption.textContent = drew ? 'STAKE RETURNED'
    : won ? 'TOTAL POT WIN' : 'STAKE LOST';

  const chips = el('div', 'duelend__chips');
  for (const [value, label] of [
    [money(Number(duel.potMinor)), 'POT'],
    [`${(duel.rakeBps / 100).toFixed(1)}%`, 'HOUSE FEE'],
    /* On a draw the house took nothing, and the chip says so rather than quoting a fee that was
     * never charged. */
    [drew ? money(0) : money(Number(duel.rakeMinor)), 'FEE PAID'],
  ]) {
    const chip = el('span', 'duelend__chip');
    chip.append(Object.assign(el('b', 'mono'), { textContent: value }),
      Object.assign(el('i'), { textContent: label }));
    chips.append(chip);
  }

  const again = el('button', 'btn btn--go btn--wide');
  again.textContent = 'BACK TO LOBBY';
  again.addEventListener('click', () => {
    closeModal();
    active = null;
    void refresh();
  });

  body.append(kicker, figure, caption, chips, again);
  openModal(drew ? 'Draw' : won ? 'You win' : 'You lose', (host) => host.append(body));
}
