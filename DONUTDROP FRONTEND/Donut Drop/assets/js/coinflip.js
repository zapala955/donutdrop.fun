/* coinflip.js — 1v1 Coinflip: the board, opening a game, and the flip.
 *
 * The browser never decides anything here. The coin is flipped server-side in the same request
 * that takes a game, and the answer arrives already settled; this file only animates the coin
 * onto the side the server named and shows the seeds that prove it. The host learns their result
 * from the live stream: when one of their open games leaves the board, it is re-read and played.
 */
import {
  state,
  bus,
  refreshBalance,
  refreshActivity,
  holdLiveFigures,
  showBalance,
} from './store.js';
import { onNavigate } from './routing.js';
import { $, el, money, clamp, reduceMotion } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';
import { api, clientSeed } from './api.js';

let root = null;

/** The board plus the platform's coinflip configuration, as last read. */
let board = { games: [], recent: [], rakeBps: 300, minStakeMinor: '0', maxStakeMinor: '0' };

/** Codes of games this player is hosting and has not seen land yet. */
const watching = new Set();
/** Codes already animated, so a refresh never replays a flip. */
const shown = new Set();

let pollTimer = 0;
let refreshing = false;

/* ─────────── holding the wallet still ───────────
 *
 * The coin is flipped and paid in the request that takes a game, so the server's balance event
 * reaches the wallet pill before the coin has left the hand: the joiner watched their win pop in the
 * header and then sat through the spin, and so did a host whose game was taken. The live figures are
 * therefore held while this player has anything in the air on the board in front of them — an open
 * game of theirs, a join on its way, a flip that has not landed — and stakes and wins are applied to
 * the pill locally, from figures the server already confirmed. Leaving the page, or the last flip
 * landing, releases the hold and refreshes for real. */
let hold = null;
let inFlight = 0;

function onScreen() {
  return Boolean(root?.isConnected) && !root.closest('.view')?.hidden;
}

function syncHold() {
  const needed = onScreen() && (watching.size > 0 || inFlight > 0);
  if (needed && !hold) hold = holdLiveFigures();
  if (!needed && hold) {
    hold();
    hold = null;
    refreshBalance().catch(() => undefined);
    refreshActivity().catch(() => undefined);
  }
}

function moveBalance(deltaMinor) {
  showBalance(BigInt(state.balanceMinor || '0') + BigInt(deltaMinor));
}

const SIDE = {
  heads: { label: 'Heads', art: 'assets/img/items/gold_ingot.png' },
  tails: { label: 'Tails', art: 'assets/img/items/iron_ingot.png' },
};

/* ═════════════════════════ entry ═════════════════════════ */

export function mountCoinflip(view) {
  root = $('#coinflipRoot', view);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) void refresh();
    });
    window.addEventListener('donut:coinflip', () => {
      if (onScreen()) void refresh();
    });
    onNavigate(syncHold);
  }
  /* The live stream is the real trigger; this is the recovery path for a stream that dropped.
   * Views are hidden rather than removed on navigation, so "connected" alone kept this polling on
   * every other page of the site; it now runs only while the board is actually on screen. */
  if (!pollTimer) {
    pollTimer = window.setInterval(() => {
      if (!root?.isConnected) {
        window.clearInterval(pollTimer);
        pollTimer = 0;
        return;
      }
      if (!document.hidden && onScreen()) void refresh();
    }, 15_000);
  }
  void refresh();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    board = await api.get('/v1/coinflip');
  } catch (error) {
    root.replaceChildren(
      notice(
        error?.code === 'COINFLIP_DISABLED'
          ? 'Coinflip is not switched on yet.'
          : 'The coinflip board could not be loaded.',
      ),
    );
    return;
  } finally {
    refreshing = false;
  }

  /* A game of ours that has left the board was either taken or closed. Taken means a flip to
   * show, so it is re-read rather than guessed from its absence. */
  const stillOpen = new Set(board.games.map((game) => game.code));
  for (const game of board.games) {
    if (game.host.isYou) watching.add(game.code);
  }
  for (const code of [...watching]) {
    if (stillOpen.has(code)) continue;
    watching.delete(code);
    /* Counted before the read, so the hold outlives the gap between "my game left the board" and
     * the flip that tells me how it went. */
    inFlight += 1;
    void api
      .get(`/v1/coinflip/${code}`)
      .then((game) => {
        if (game.status === 'settled') showFlip(game, { counted: true });
        else landed();
      })
      .catch(() => landed());
  }
  syncHold();
  render();
}

/** One thing that was in the air has come down. */
function landed() {
  inFlight = Math.max(0, inFlight - 1);
  syncHold();
}

/* ═════════════════════════ the board ═════════════════════════ */

function notice(text) {
  const box = el('p', 'empty');
  box.textContent = text;
  return box;
}

function avatar(name) {
  const node = el('span', 'duelav duelav--md');
  node.textContent = (name || '?').slice(0, 2).toUpperCase();
  return node;
}

function sideChip(side) {
  const chip = el('span', 'cfside');
  chip.dataset.side = side;
  const img = el('img');
  img.src = SIDE[side].art;
  img.alt = '';
  chip.append(img, Object.assign(el('b'), { textContent: SIDE[side].label }));
  return chip;
}

function render() {
  const wrap = el('div', 'duel cf');

  const badges = el('div', 'duel__badges');
  for (const [value, label] of [
    [`${(board.rakeBps / 100).toFixed(board.rakeBps % 100 === 0 ? 0 : 1)}%`, 'HOUSE RAKE'],
    ['0%', 'HOUSE EDGE'],
    ['50/50', 'EXACT ODDS'],
    ['HMAC', 'PROVABLY FAIR'],
  ]) {
    const badge = el('span', 'duel__badge');
    badge.append(
      Object.assign(el('b'), { textContent: value }),
      Object.assign(el('i'), { textContent: label }),
    );
    badges.append(badge);
  }
  wrap.append(badges);

  const head = el('div', 'duel__head');
  const title = el('h2', 'duel__h');
  title.textContent = 'Open flips';
  const create = el('button', 'btn btn--go');
  create.type = 'button';
  create.textContent = 'Create flip';
  create.addEventListener('click', () => {
    if (!state.authenticated) {
      $('#loginBtn')?.click();
      return;
    }
    openCreate();
  });
  head.append(title, create);
  wrap.append(head);

  if (!board.games.length) {
    wrap.append(notice('No open flips. Create one and pick your side.'));
  } else {
    const table = el('div', 'duel__table');
    const header = el('div', 'duel__row duel__row--head cf__row');
    for (const [label, cls] of [
      ['PLAYER', 'who'],
      ['SIDE', 'mode'],
      ['STAKE', 'stake'],
      ['WINNER TAKES', 'take'],
      ['', 'go'],
    ]) {
      const cell = el('span', `duel__c duel__c--${cls}`);
      cell.textContent = label;
      header.append(cell);
    }
    table.append(header);

    for (const game of board.games) {
      const row = el('div', 'duel__row cf__row');
      row.dataset.mine = game.host.isYou ? '1' : '0';

      const who = el('span', 'duel__c duel__c--who');
      who.append(
        avatar(game.host.name),
        Object.assign(el('b'), {
          textContent: game.host.name || 'Player',
        }),
      );

      const side = el('span', 'duel__c duel__c--mode');
      side.append(sideChip(game.host.side));

      const stake = el('span', 'duel__c duel__c--stake mono');
      stake.textContent = money(Number(game.stakeMinor));

      const take = el('span', 'duel__c duel__c--take mono');
      take.textContent = money(Number(game.payoutMinor));

      const go = el('span', 'duel__c duel__c--go');
      if (game.host.isYou) {
        const cancel = el('button', 'btn btn--tiny');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => void cancelGame(game, cancel));
        go.append(cancel);
      } else {
        const join = el('button', 'btn btn--go btn--tiny');
        join.type = 'button';
        const theirs = game.host.side === 'heads' ? 'tails' : 'heads';
        join.textContent = `TAKE ${SIDE[theirs].label.toUpperCase()}`;
        join.addEventListener('click', () => void takeGame(game, join));
        go.append(join);
      }

      row.append(who, side, stake, take, go);
      table.append(row);
    }
    wrap.append(table);
  }

  if (board.recent?.length) {
    const recentHead = el('h2', 'duel__h cf__recenth');
    recentHead.textContent = 'Recent flips';
    const strip = el('div', 'cf__recent');
    for (const game of board.recent) {
      const card = el('button', 'cf__flip');
      card.type = 'button';
      card.dataset.side = game.result;
      card.title = 'Show this flip and its proof';
      const img = el('img');
      img.src = SIDE[game.result]?.art ?? SIDE.heads.art;
      img.alt = SIDE[game.result]?.label ?? '';
      const winner = game.winner === 'host' ? game.host : game.opponent;
      card.append(
        img,
        Object.assign(el('b', 'mono'), { textContent: money(Number(game.payoutMinor)) }),
        Object.assign(el('i'), { textContent: winner?.name || 'Player' }),
      );
      card.addEventListener('click', () => showFlip(game, { replay: true }));
      strip.append(card);
    }
    wrap.append(recentHead, strip);
  }

  root.replaceChildren(wrap);
}

/* ═════════════════════════ open a game ═════════════════════════ */

function openCreate() {
  const min = Number(board.minStakeMinor);
  const max = Number(board.maxStakeMinor);
  let stake = clamp(1_000_000, min, max);
  let side = 'heads';

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

  const chips = el('div', 'qchips');
  const step = (label, fn) => {
    const chip = el('button', 'qchip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      stake = fn(stake);
      paint();
    });
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
    stake = clamp(Number(state.balance ?? 0), min, max);
    paint();
  });
  chips.append(maxChip);

  const sides = el('div', 'duelnew__seg duelnew__seg--two');
  for (const value of ['heads', 'tails']) {
    const button = el('button', 'duelnew__opt cf__pick');
    button.type = 'button';
    button.dataset.on = value === side ? '1' : '0';
    button.dataset.side = value;
    const img = el('img');
    img.src = SIDE[value].art;
    img.alt = '';
    button.append(img, Object.assign(el('b'), { textContent: SIDE[value].label }));
    button.addEventListener('click', () => {
      side = value;
      [...sides.children].forEach((node) => {
        node.dataset.on = node === button ? '1' : '0';
      });
    });
    sides.append(button);
  }

  const go = el('button', 'btn btn--go btn--wide btn--lg');
  go.type = 'button';
  go.textContent = 'OPEN FLIP';
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const created = await api.post('/v1/coinflip', {
        stakeMinor: String(stake),
        side,
        clientSeed: clientSeed(),
      });
      watching.add(created.code);
      syncHold();
      /* The stake is the whole of what opening a game does to the wallet. */
      moveBalance(-BigInt(stake));
      closeModal();
      playSound('coin');
      await refresh();
    } catch (error) {
      toast({ kind: 'red', title: 'NOT OPENED', body: error?.message || 'Try again' });
      go.disabled = false;
    }
  });

  body.append(figure, chips, sides, go);
  paint();
  openModal('New coinflip', (host) => host.append(body));
}

/* ═════════════════════════ take / cancel ═════════════════════════ */

async function takeGame(game, button) {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  button.disabled = true;
  /* Held before the request: the flip is decided and paid inside it, and the balance event can
   * beat its answer here. Only the stake is shown leaving; the win waits for the coin. */
  inFlight += 1;
  syncHold();
  try {
    const settled = await api.post(`/v1/coinflip/${game.code}/join`, { clientSeed: clientSeed() });
    moveBalance(-BigInt(game.stakeMinor));
    showFlip(settled, { counted: true });
    void refresh();
  } catch (error) {
    landed();
    toast({ kind: 'red', title: 'NOT JOINED', body: error?.message || 'Try again' });
    button.disabled = false;
    void refresh();
  }
}

async function cancelGame(game, button) {
  button.disabled = true;
  try {
    await api.post(`/v1/coinflip/${game.code}/cancel`, {});
    watching.delete(game.code);
    moveBalance(BigInt(game.stakeMinor));
    syncHold();
    toast({ kind: 'gold', title: 'CANCELLED', body: 'Your stake is back in your wallet' });
    await refresh();
  } catch (error) {
    toast({ kind: 'red', title: 'NOT CANCELLED', body: error?.message || 'Try again' });
    button.disabled = false;
    void refresh();
  }
}

/* ═════════════════════════ the flip ═════════════════════════ */

/**
 * Plays a settled game: the coin spins and lands on the side the server already chose.
 *
 * The spin is decoration with a fixed length. The number of half-turns is picked so the face
 * that ends up showing is the result, which is the only thing about the animation that matters.
 */
function showFlip(game, { replay = false, counted = false } = {}) {
  if (!replay) {
    if (shown.has(game.code)) {
      if (counted) landed();
      return;
    }
    shown.add(game.code);
  }

  const youPlayed = game.host.isYou || game.opponent?.isYou;
  const winner = game.winner === 'host' ? game.host : game.opponent;

  const body = el('div', 'cfstage');
  const players = el('div', 'cfstage__players');
  for (const player of [game.host, game.opponent]) {
    const side = el('div', 'cfstage__player');
    side.dataset.side = player?.side ?? '';
    side.append(
      avatar(player?.name),
      Object.assign(el('b'), { textContent: player?.isYou ? 'You' : player?.name || 'Player' }),
      sideChip(player?.side ?? 'heads'),
    );
    players.append(side);
  }

  const coin = el('div', 'cfcoin');
  const faces = el('div', 'cfcoin__body');
  for (const value of ['heads', 'tails']) {
    const face = el('div', `cfcoin__face cfcoin__face--${value}`);
    const img = el('img');
    img.src = SIDE[value].art;
    img.alt = SIDE[value].label;
    face.append(img);
    faces.append(face);
  }
  coin.append(faces);

  const verdict = el('div', 'cfstage__verdict');
  verdict.textContent = 'Flipping…';

  const proof = el('details', 'cfproof');
  const summary = el('summary');
  summary.textContent = 'Verify this flip';
  const formula = el('code', 'cfproof__formula');
  formula.textContent =
    'HMAC_SHA256(serverSeed, "coinflip:" + hostSeed + ":" + opponentSeed) — first byte < 128 = Heads';
  const list = el('dl', 'cfproof__list');
  for (const [label, value] of [
    ['Server seed hash', game.serverSeedHash],
    ['Server seed', game.serverSeed],
    ['Host seed', game.hostClientSeed],
    ['Opponent seed', game.opponentClientSeed],
  ]) {
    list.append(
      Object.assign(el('dt'), { textContent: label }),
      Object.assign(el('dd', 'mono'), { textContent: value ?? '—' }),
    );
  }
  proof.append(summary, formula, list);

  body.append(players, coin, verdict, proof);
  openModal('Coinflip', (host) => host.append(body));

  const land = () => {
    // The card whose side came up lights; the other dims.
    for (const card of players.children) {
      card.dataset.result = card.dataset.side === game.result ? 'won' : 'lost';
    }
    verdict.dataset.state = !youPlayed ? 'neutral' : game.youWon ? 'won' : 'lost';
    const name = winner?.isYou ? 'You' : winner?.name || 'Player';
    verdict.textContent = `${SIDE[game.result].label} — ${name} ${winner?.isYou ? 'win' : 'wins'} ${money(Number(game.payoutMinor))}`;
    if (youPlayed) {
      playSound(game.youWon ? 'win' : 'lose');
      /* The pot reaches the pill now, on the frame the coin lands; a real refresh follows as soon
       * as nothing else of this player's is still in the air. */
      if (game.youWon && !replay) moveBalance(BigInt(game.payoutMinor));
    }
    if (counted) landed();
  };

  /* Whole turns plus a half for tails: the face showing at rest is the result. */
  const turns = 5 + (game.result === 'tails' ? 0.5 : 0);
  if (reduceMotion()) {
    faces.style.transform = `rotateY(${turns * 360}deg)`;
    land();
    return;
  }
  playSound('coin');
  faces.style.setProperty('--cf-turns', `${turns * 360}deg`);
  coin.dataset.spin = '1';
  window.setTimeout(land, 2_200);
}
