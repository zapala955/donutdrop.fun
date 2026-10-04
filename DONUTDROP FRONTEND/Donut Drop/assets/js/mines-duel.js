/* mines-duel.js — 1v1 Mines Duel: the lobby, opening a game, and the arena.
 *
 * Two players turn tiles on the SAME hidden field at the same time. Each sees only their own tiles;
 * the other side shows nothing but whether they have finished, and the scores, the field and both
 * runs appear together when the game is over. Highest count of safe tiles wins the pot; one TNT
 * and your score is zero; equal scores return both stakes.
 *
 * The browser decides nothing. Every tile is a request the server answers with what that tile was,
 * the clock is the server's (this page only draws it, corrected for the gap between the two
 * clocks), and a game that runs out of time is settled by the server whether or not anybody is
 * looking. This file draws what it is told and plays the sounds.
 *
 * The wallet pill is held still while a game is running, for the same reason a coinflip holds it:
 * the server pays the moment it settles, and a balance that jumped before the reveal would give the
 * result away. The hold is released, and the pill refreshed for real, once the result is on screen.
 */
import { state, bus, refreshBalance, refreshActivity, holdLiveFigures } from './store.js';
import { onNavigate } from './routing.js';
import { $, el, money, parseAmount, formatAmountInput, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { api, clientSeed } from './api.js';

const TILES = 25;
const LOBBY_POLL_MS = 15_000;
const ARENA_POLL_MS = 2_000;
const TNT_ART = 'assets/img/items/tnt.png';
const GEM_ART = 'assets/img/items/diamond.png';

/** The field sizes the host can pick, and what each one means in play. */
const TNT_CHOICES = [
  { mines: 3, name: 'Cautious', note: 'Long runs, so ties are likely' },
  { mines: 5, name: 'Balanced', note: 'The classic' },
  { mines: 8, name: 'Risky', note: 'Most runs end within a few tiles' },
  { mines: 12, name: 'Brutal', note: 'One or two tiles can be the whole run' },
];

/* Where the TNT sits in the little previews. Decoration only: the real field is dealt when somebody
 * takes the game. A fixed order, so every preview of five TNT shows the same five tiles -- and each
 * run of five in it uses five different rows and columns, so a preview reads as scattered TNT
 * rather than a line. */
const PREVIEW_ORDER = [1, 8, 10, 17, 24, 4, 6, 13, 15, 22, 2, 9, 11, 18, 20, 0, 7, 14, 16, 23];

let root = null;
/** The lobby, as last read. */
let board = null;
/** The game on the arena's table, or null in the lobby. */
let game = null;
let arena = null;
/** Milliseconds the server's clock is ahead of this browser's, from the last response. */
let skew = 0;
let busy = false;
let stakeText = '1m';
let mines = 5;
let refreshing = false;
let lobbyTimer = 0;
let arenaPoll = 0;
let clockTimer = 0;
let hold = null;
/** Codes of my own open games, so one being taken can be told apart from one being cancelled. */
let myOpen = new Set();
/** Codes whose result has been shown, so a refresh never replays the reveal. */
const revealed = new Set();
/** Codes the player has walked out of after the result, so auto-resume does not pull them back. */
const dismissed = new Set();

/* ─────────── small helpers ─────────── */

const onScreen = () => Boolean(root?.isConnected) && !root.closest('.view')?.hidden;
const bigOf = (value) => BigInt(String(value ?? '0'));
const pad = (n) => String(n).padStart(2, '0');

function avatar(name, size = 'md') {
  const node = el('span', `duelav duelav--${size}`);
  node.textContent = (name || '?').slice(0, 2).toUpperCase();
  return node;
}

function notice(text, tone = '') {
  const box = el('p', 'empty mduel__notice');
  if (tone) box.dataset.tone = tone;
  box.textContent = text;
  return box;
}

function payoutFor(stakeMinor, rakeBps) {
  const pot = bigOf(stakeMinor) * 2n;
  return pot - (pot * BigInt(rakeBps)) / 10_000n;
}

/** The chance the next tile is safe, in whole percent: arithmetic on public numbers only. */
function nextSafePercent(tnt, turned) {
  const hidden = TILES - turned;
  const safeLeft = TILES - tnt - turned;
  return hidden <= 0 || safeLeft <= 0 ? 0 : Math.floor((safeLeft * 100) / hidden);
}

/** A little 5x5 of the field: TNT tiles red, the rest dark. */
function preview(tnt) {
  const grid = el('span', 'mduel__preview');
  grid.setAttribute('aria-hidden', 'true');
  const hot = new Set(PREVIEW_ORDER.slice(0, tnt));
  for (let i = 0; i < TILES; i += 1) {
    const cell = el('i');
    if (hot.has(i)) cell.dataset.tnt = '1';
    grid.append(cell);
  }
  return grid;
}

/* ─────────── holding the wallet still ─────────── */

function syncHold() {
  const needed = onScreen() && game !== null && game.status === 'playing';
  if (needed && !hold) hold = holdLiveFigures();
  if (!needed && hold) releaseHold();
}

function releaseHold() {
  if (!hold) return;
  hold();
  hold = null;
  refreshBalance().catch(() => undefined);
  refreshActivity().catch(() => undefined);
}

/* ═════════════════════════ entry ═════════════════════════ */

export function mountMinesDuel(view) {
  root = $('#minesDuelRoot', view);
  if (!root) return;

  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready'].includes(event.detail)) {
        if (event.detail === 'logout') leaveArena({ quiet: true });
        void refresh();
      }
    });
    /* The live stream is the real trigger: a game opened, taken, finished by one side or settled. */
    window.addEventListener('donut:minesduel', () => {
      if (!onScreen()) return;
      if (game && game.status === 'playing') void refreshGame();
      else if (!game) void refresh();
    });
    onNavigate(() => {
      syncHold();
      if (onScreen() && !game) void refresh();
    });
  }
  /* The recovery path for a stream that dropped. Views are hidden rather than removed on
   * navigation, so this runs only while the page is actually on screen. */
  if (!lobbyTimer) {
    lobbyTimer = window.setInterval(() => {
      if (!root?.isConnected) {
        window.clearInterval(lobbyTimer);
        lobbyTimer = 0;
        return;
      }
      if (!document.hidden && onScreen() && !game) void refresh();
    }, LOBBY_POLL_MS);
  }
  void refresh();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    board = await api.get('/v1/mines-duel');
  } catch {
    root.replaceChildren(notice('The Mines Duel board could not be loaded.'));
    return;
  } finally {
    refreshing = false;
  }

  /* One of my open games that is now running was taken: take the player to it. */
  const nowOpen = new Set(board.mine.filter((g) => g.status === 'open').map((g) => g.code));
  const taken = board.mine.find((g) => g.status === 'playing' && myOpen.has(g.code));
  myOpen = nowOpen;
  const running = board.mine.find((g) => g.status === 'playing' && !dismissed.has(g.code));
  if (!game && running && onScreen()) {
    if (taken) {
      playSound('chime');
      toast({
        kind: 'gold',
        title: 'Challenger found',
        body: 'Your duel is on. The clock is running.',
      });
    }
    openArena(running);
    return;
  }
  if (!game) renderLobby();
}

/* ═════════════════════════ the lobby ═════════════════════════ */

function badge(value, label) {
  const node = el('span', 'duel__badge');
  node.append(
    Object.assign(el('b'), { textContent: value }),
    Object.assign(el('i'), { textContent: label }),
  );
  return node;
}

function renderLobby() {
  stopArenaTimers();
  const wrap = el('div', 'mduel__lobby');

  const badges = el('div', 'duel__badges');
  badges.append(
    badge(`${(board.rakeBps / 100).toFixed(board.rakeBps % 100 ? 1 : 0)}%`, 'House rake'),
    badge('Same', 'Field for both'),
    badge(`${board.playSeconds}s`, 'To play'),
    badge('Hidden', 'Scores until the end'),
  );
  wrap.append(badges);

  if (board.enabled === false) {
    wrap.append(
      notice('Mines Duel is closed right now. Duels already running can still be finished.'),
    );
  }

  const columns = el('div', 'mduel__cols');
  const main = el('div', 'mduel__main');
  /* The explainer sits in the left column, under the lists, so a short board does not leave a hole
   * beside the taller open-a-duel panel. */
  main.append(renderOpenList(), renderMine(), renderRecent(), renderHow());
  columns.append(main, board.enabled === false ? el('span') : renderCreate());
  wrap.append(columns);
  root.replaceChildren(wrap);
}

function sectionHead(title, hint) {
  const head = el('div', 'mduel__head');
  head.append(Object.assign(el('h2', 'duel__h'), { textContent: title }));
  if (hint) head.append(Object.assign(el('span', 'mduel__hint'), { textContent: hint }));
  return head;
}

function renderOpenList() {
  const section = el('section', 'mduel__section');
  section.append(
    sectionHead('Open duels', board.games.length ? `${board.games.length} waiting` : ''),
  );
  if (!board.games.length) {
    const empty = el('div', 'mduel__empty');
    const art = preview(5);
    art.classList.add('mduel__preview--lg');
    empty.append(
      art,
      Object.assign(el('b'), { textContent: 'No duels waiting' }),
      Object.assign(el('span'), {
        textContent: 'Open one on the right and the next player to take it plays you.',
      }),
    );
    section.append(empty);
    return section;
  }
  const list = el('div', 'mduel__list');
  for (const g of board.games) list.append(duelRow(g));
  section.append(list);
  return section;
}

function duelRow(g, { mineRow = false } = {}) {
  const row = el('div', 'mduel__row');
  row.dataset.code = g.code;

  const who = el('span', 'mduel__who');
  who.append(
    avatar(g.host.name),
    Object.assign(el('b'), { textContent: g.host.isYou ? 'You' : g.host.name }),
  );

  const tnt = el('span', 'mduel__tnt');
  tnt.append(preview(g.mines), Object.assign(el('span'), { textContent: `${g.mines} TNT` }));

  const stake = el('span', 'mduel__stake mono');
  stake.textContent = money(Number(g.stakeMinor));
  stake.title = 'Each player stakes this';

  const win = el('span', 'mduel__win mono');
  win.append(
    Object.assign(el('i'), { textContent: 'Win ' }),
    document.createTextNode(money(Number(g.payoutMinor))),
  );

  const act = el('span', 'mduel__act');
  if (g.host.isYou) {
    const cancel = el('button', 'btn btn--tiny', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => void cancelDuel(g, cancel));
    act.append(cancel);
  } else {
    const join = el('button', 'btn btn--go btn--tiny', 'Take');
    join.type = 'button';
    join.addEventListener('click', () => void takeDuel(g, join));
    act.append(join);
  }
  if (mineRow) row.dataset.mine = '1';
  row.append(who, tnt, stake, win, act);
  return row;
}

function renderMine() {
  const mine = board.mine ?? [];
  const section = el('section', 'mduel__section');
  if (!mine.length) return section;
  section.append(sectionHead('Your duels'));
  const list = el('div', 'mduel__list');
  for (const g of mine) {
    if (g.status === 'open') {
      list.append(duelRow(g, { mineRow: true }));
      continue;
    }
    const row = el('div', 'mduel__row mduel__row--live');
    row.dataset.mine = '1';
    const who = el('span', 'mduel__who');
    const other = g.host.isYou ? g.opponent : g.host;
    who.append(
      avatar(other?.name),
      Object.assign(el('b'), { textContent: `vs ${other?.name ?? '…'}` }),
    );
    const tnt = el('span', 'mduel__tnt');
    tnt.append(preview(g.mines), Object.assign(el('span'), { textContent: 'In play' }));
    const stake = el('span', 'mduel__stake mono', money(Number(g.stakeMinor)));
    const win = el('span', 'mduel__win mono');
    win.append(
      Object.assign(el('i'), { textContent: 'Win ' }),
      document.createTextNode(money(Number(g.payoutMinor))),
    );
    const act = el('span', 'mduel__act');
    const resume = el('button', 'btn btn--go btn--tiny', 'Resume');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      dismissed.delete(g.code);
      openArena(g);
    });
    act.append(resume);
    row.append(who, tnt, stake, win, act);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderRecent() {
  const section = el('section', 'mduel__section');
  const recent = board.recent ?? [];
  if (!recent.length && !(board.history ?? []).length) return section;
  const history = board.history ?? [];
  if (history.length) {
    section.append(sectionHead('Your recent duels'));
    const strip = el('div', 'mduel__strip');
    for (const g of history) strip.append(resultCard(g, true));
    section.append(strip);
  }
  if (recent.length) {
    section.append(sectionHead('Recent duels'));
    const strip = el('div', 'mduel__strip');
    for (const g of recent) strip.append(resultCard(g, false));
    section.append(strip);
  }
  return section;
}

function resultCard(g, personal) {
  const card = el('div', 'mduel__result');
  const draw = g.outcome === 'draw';
  const mineSide = g.host.isYou ? 'host' : g.opponent.isYou ? 'opponent' : null;
  const tone = draw ? 'draw' : personal ? (g.youWon ? 'won' : 'lost') : 'won';
  card.dataset.tone = tone;
  const winner = g.outcome === 'host' ? g.host : g.opponent;
  const loser = g.outcome === 'host' ? g.opponent : g.host;
  const head = el('b', 'mduel__resulthead');
  head.textContent = draw
    ? 'Draw'
    : personal
      ? g.youWon
        ? 'You won'
        : 'You lost'
      : `${winner.name} won`;
  const score = el('span', 'mono mduel__resultscore');
  score.textContent = `${g.host.score ?? 0} – ${g.opponent.score ?? 0}`;
  const money_ = el('span', 'mono mduel__resultmoney');
  money_.textContent = draw
    ? 'stakes back'
    : personal && !g.youWon
      ? `-${money(Number(g.stakeMinor))}`
      : `+${money(Number(g.payoutMinor))}`;
  const vs = el('i');
  vs.textContent = draw
    ? `${g.mines} TNT`
    : personal
      ? `${g.mines} TNT · vs ${mineSide === 'host' ? g.opponent.name : g.host.name}`
      : `${g.mines} TNT · beat ${loser.name}`;
  card.append(head, score, money_, vs);
  return card;
}

function renderHow() {
  const how = el('ol', 'mduel__how');
  const steps = [
    [
      '1',
      'Stake and pick the TNT',
      'Same stake from both players, 3 to 12 TNT hidden in 25 tiles.',
    ],
    [
      '2',
      'Turn tiles in secret',
      'Both play the same field at once. You never see their progress.',
    ],
    [
      '3',
      'Highest count wins',
      'One TNT scores zero. Lock in any time, or the clock locks you in.',
    ],
  ];
  for (const [n, title, text] of steps) {
    const li = el('li');
    li.append(
      Object.assign(el('span', 'mduel__n'), { textContent: n }),
      Object.assign(el('b'), { textContent: title }),
      Object.assign(el('span'), { textContent: text }),
    );
    how.append(li);
  }
  return how;
}

/* ─────────── opening a duel ─────────── */

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function createProblem() {
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < bigOf(board.minStakeMinor))
    return `The smallest duel is ${money(Number(board.minStakeMinor))}`;
  if (stake > bigOf(board.maxStakeMinor))
    return `The largest duel is ${money(Number(board.maxStakeMinor))}`;
  if (state.authenticated && stake > bigOf(state.balanceMinor))
    return 'That is more than your balance';
  return '';
}

function renderCreate() {
  const panel = el('aside', 'mduel__panel');
  panel.setAttribute('aria-label', 'Open a duel');
  const form = el('form', 'mduel__form');
  form.noValidate = true;

  form.append(Object.assign(el('h2', 'mduel__paneltitle'), { textContent: 'Open a duel' }));
  form.append(
    Object.assign(el('label', 'mduel__label'), { textContent: 'Stake each', htmlFor: 'mdStake' }),
  );
  const field = el('div', 'mduel__field');
  const input = el('input');
  input.id = 'mdStake';
  input.value = stakeText;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.inputMode = 'decimal';
  const half = el('button', 'mduel__adj', '½');
  const dbl = el('button', 'mduel__adj', '2×');
  half.type = dbl.type = 'button';
  half.setAttribute('aria-label', 'Halve the stake');
  dbl.setAttribute('aria-label', 'Double the stake');
  field.append(Object.assign(el('span'), { textContent: '$' }), input, half, dbl);
  form.append(field);

  form.append(Object.assign(el('span', 'mduel__label'), { textContent: 'TNT in the field' }));
  const choices = el('div', 'mduel__choices');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'TNT in the field');
  for (const choice of TNT_CHOICES) {
    const button = el('button', 'mduel__choice');
    button.type = 'button';
    button.dataset.mines = String(choice.mines);
    button.setAttribute('aria-pressed', String(choice.mines === mines));
    button.title = choice.note;
    const copy = el('span', 'mduel__choicetext');
    copy.append(
      Object.assign(el('b'), { textContent: String(choice.mines) }),
      Object.assign(el('i'), { textContent: choice.name }),
    );
    button.append(preview(choice.mines), copy);
    choices.append(button);
  }
  form.append(choices);

  const summary = el('div', 'mduel__summary');
  const total = el('b', 'mono');
  const split = el('span', 'mono');
  summary.append(Object.assign(el('span'), { textContent: 'Winner takes' }), total, split);
  form.append(summary);

  const go = el('button', 'btn btn--go mduel__go');
  go.type = 'submit';
  form.append(go);
  const hint = el('p', 'mduel__problem');
  hint.setAttribute('aria-live', 'polite');
  form.append(hint);
  form.append(
    Object.assign(el('p', 'mduel__fine'), {
      textContent:
        'A draw returns both stakes and charges nothing. A duel nobody takes is refunded.',
    }),
  );

  const paint = () => {
    const stake = stakeMinor();
    const ok = stake !== null && stake > 0n;
    total.textContent = ok ? money(Number(payoutFor(stake, board.rakeBps))) : '—';
    split.textContent = ok
      ? `${money(Number(stake * 2n))} pot − ${(board.rakeBps / 100).toFixed(board.rakeBps % 100 ? 1 : 0)}%`
      : '';
    const issue = state.authenticated ? createProblem() : '';
    go.textContent = !state.authenticated
      ? 'Log in to play'
      : ok
        ? `Open duel · ${money(Number(stake))}`
        : 'Open duel';
    go.disabled = state.authenticated && (Boolean(issue) || busy);
    hint.textContent = issue;
    choices.querySelectorAll('.mduel__choice').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.mines) === mines));
    });
  };
  input.addEventListener('input', () => {
    stakeText = input.value;
    paint();
  });
  const scale = (mul) => () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(mul === 'half' ? current / 2n : current * 2n));
    input.value = stakeText;
    paint();
  };
  half.addEventListener('click', scale('half'));
  dbl.addEventListener('click', scale('double'));
  choices.addEventListener('click', (event) => {
    const button = event.target.closest('.mduel__choice');
    if (!button) return;
    mines = Number(button.dataset.mines);
    paint();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void openDuel(go);
  });
  paint();
  panel.append(form);
  return panel;
}

async function openDuel(button) {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (createProblem()) return;
  button.disabled = true;
  busy = true;
  try {
    await api.post('/v1/mines-duel', {
      stakeMinor: stakeMinor().toString(),
      mines,
      clientSeed: clientSeed(),
    });
    playSound('click');
    toast({
      kind: 'gold',
      title: 'Duel open',
      body: 'Waiting for a challenger. You can cancel any time.',
    });
    await refreshBalance();
  } catch (error) {
    toast({
      kind: 'lose',
      title: 'Mines Duel',
      body: error?.message || 'The duel could not be opened',
    });
  } finally {
    busy = false;
  }
  await refresh();
}

async function takeDuel(g, button) {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  button.disabled = true;
  try {
    const started = await api.post(`/v1/mines-duel/${g.code}/join`, { clientSeed: clientSeed() });
    playSound('click');
    await refreshBalance();
    openArena(started);
  } catch (error) {
    toast({
      kind: 'lose',
      title: 'Mines Duel',
      body: error?.message || 'That duel could not be taken',
    });
    button.disabled = false;
    void refresh();
  }
}

async function cancelDuel(g, button) {
  button.disabled = true;
  try {
    await api.post(`/v1/mines-duel/${g.code}/cancel`, {});
    toast({
      kind: 'win',
      title: 'Duel cancelled',
      body: `${money(Number(g.stakeMinor))} is back in your balance.`,
    });
    await refreshBalance();
  } catch (error) {
    toast({
      kind: 'lose',
      title: 'Mines Duel',
      body: error?.message || 'That duel could not be cancelled',
    });
  }
  void refresh();
}

/* ═════════════════════════ the arena ═════════════════════════ */

function openArena(view) {
  dismissed.delete(view.code);
  game = view;
  syncSkew(view);
  arena = null;
  syncHold();
  buildArena();
  paintArena();
  startArenaTimers();
  if (view.status === 'settled') revealResult({ instant: true });
}

function leaveArena({ quiet = false } = {}) {
  if (game) dismissed.add(game.code);
  game = null;
  arena = null;
  stopArenaTimers();
  releaseHold();
  if (!quiet && board) renderLobby();
  void refresh();
}

function syncSkew(view) {
  const server = Date.parse(view.serverNow);
  if (Number.isFinite(server)) skew = server - Date.now();
}

function startArenaTimers() {
  stopArenaTimers();
  clockTimer = window.setInterval(paintClock, 200);
  arenaPoll = window.setInterval(() => {
    if (game?.status === 'playing' && onScreen() && !document.hidden) void refreshGame();
  }, ARENA_POLL_MS);
}

function stopArenaTimers() {
  window.clearInterval(clockTimer);
  window.clearInterval(arenaPoll);
  clockTimer = arenaPoll = 0;
}

async function refreshGame() {
  if (!game || busy) return;
  const code = game.code;
  try {
    const next = await api.get(`/v1/mines-duel/${code}`);
    if (game?.code === code) applyGame(next);
  } catch {
    /* The next poll or event will try again. */
  }
}

function applyGame(next) {
  const before = game?.status;
  game = next;
  syncSkew(next);
  if (!arena || arena.code !== next.code) buildArena();
  paintArena();
  if (next.status === 'settled' && before !== 'settled') revealResult({});
}

const remainingMs = () =>
  game?.deadlineAt ? Date.parse(game.deadlineAt) - (Date.now() + skew) : 0;

function you() {
  return game?.you ?? null;
}

const canPlay = () =>
  game?.status === 'playing' && you()?.state === 'playing' && remainingMs() > 0 && !busy;

function setTile(node, kind) {
  if (node.dataset.kind === kind) return;
  const wasHidden = node.dataset.kind === 'hidden';
  node.dataset.kind = kind;
  const img = node.querySelector('img');
  const art =
    kind === 'tnt' || kind === 'boom'
      ? TNT_ART
      : kind === 'gem' || kind === 'dim-gem'
        ? GEM_ART
        : null;
  if (art) {
    img.src = art;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
  if (wasHidden && (kind === 'gem' || kind === 'boom') && !reduceMotion()) {
    node.classList.remove('is-pop');
    void node.offsetWidth;
    node.classList.add('is-pop');
  }
}

function tileNode(tag, index) {
  const node = el(tag, 'mtile');
  node.dataset.tile = String(index);
  node.dataset.kind = 'hidden';
  const img = el('img');
  img.alt = '';
  img.hidden = true;
  img.draggable = false;
  node.append(img);
  return node;
}

function buildArena() {
  const wrap = el('section', 'mduel__arena');
  wrap.dataset.state = 'playing';

  /* ── the bar across the top ── */
  const top = el('header', 'mduel__top');
  const meta = el('div', 'mduel__meta');
  const live = el('b', 'mduel__live');
  meta.append(live, Object.assign(el('span', 'mono'), { textContent: `Duel #${game.code}` }));
  const terms = el('div', 'mduel__terms');
  terms.append(
    Object.assign(el('span'), { textContent: `${money(Number(game.stakeMinor))} each` }),
    Object.assign(el('span'), { textContent: `pot ${money(Number(game.potMinor))}` }),
    Object.assign(el('span'), { textContent: `${game.mines} TNT` }),
  );
  top.append(meta, terms);

  /* ── the result strip, empty until the game is over ── */
  const result = el('div', 'mduel__outcome');
  result.hidden = true;
  result.setAttribute('role', 'status');
  result.setAttribute('aria-atomic', 'true');

  /* ── the two sides ── */
  const sides = el('div', 'mduel__sides');
  const youSide = el('article', 'mduel__side mduel__side--you');
  const youHead = el('header', 'mduel__sidehead');
  const youScore = el('b', 'mduel__score');
  youHead.append(
    avatar(game[game.you?.role ?? 'host'].name, 'sm'),
    Object.assign(el('span', 'mduel__name'), { textContent: 'You' }),
    youScore,
  );
  const youBoard = el('div', 'mduel__board');
  youBoard.setAttribute('role', 'group');
  youBoard.setAttribute('aria-label', 'Your field');
  const youTiles = [];
  for (let i = 0; i < TILES; i += 1) {
    const tile = tileNode('button', i);
    tile.type = 'button';
    tile.setAttribute('aria-label', `Tile ${i + 1}`);
    youBoard.append(tile);
    youTiles.push(tile);
  }
  const youFoot = el('footer', 'mduel__sidefoot');
  const odds = el('span', 'mduel__odds');
  const lockBtn = el('button', 'btn btn--go mduel__lock');
  lockBtn.type = 'button';
  const youNote = el('p', 'mduel__note');
  youNote.setAttribute('aria-live', 'polite');
  youFoot.append(odds, lockBtn, youNote);
  youSide.append(youHead, youBoard, youFoot);

  const middle = el('div', 'mduel__middle');
  const vs = el('span', 'mduel__vs', 'VS');
  const clock = clockNode();
  middle.append(vs, clock.node);

  const otherRole = game.you?.role === 'host' ? 'opponent' : 'host';
  const themSide = el('article', 'mduel__side mduel__side--them');
  const themHead = el('header', 'mduel__sidehead');
  const themScore = el('b', 'mduel__score');
  const themStatus = el('span', 'mduel__status');
  themHead.append(
    avatar(game[otherRole]?.name, 'sm'),
    Object.assign(el('span', 'mduel__name'), { textContent: game[otherRole]?.name ?? 'Opponent' }),
    themScore,
  );
  const themBoard = el('div', 'mduel__board mduel__board--mini');
  themBoard.setAttribute('aria-hidden', 'true');
  const themTiles = [];
  for (let i = 0; i < TILES; i += 1) {
    const tile = tileNode('span', i);
    themBoard.append(tile);
    themTiles.push(tile);
  }
  const themFoot = el('footer', 'mduel__sidefoot');
  const themNote = el('p', 'mduel__note');
  themFoot.append(themStatus, themNote);
  themSide.append(themHead, themBoard, themFoot);

  sides.append(youSide, middle, themSide);

  /* ── the proof ── */
  const proof = el('details', 'mduel__proof');
  const summary = el('summary', '', 'Provably fair');
  const proofBody = el('div', 'mduel__proofbody');
  proof.append(summary, proofBody);

  const actions = el('div', 'mduel__actions');
  actions.hidden = true;
  const rematch = el('button', 'btn btn--go', 'Rematch');
  rematch.type = 'button';
  const back = el('button', 'btn', 'Back to lobby');
  back.type = 'button';
  actions.append(rematch, back);

  wrap.append(top, result, sides, actions, proof);
  root.replaceChildren(wrap);

  arena = {
    code: game.code,
    wrap,
    live,
    middle,
    vs,
    result,
    youTiles,
    themTiles,
    youScore,
    themScore,
    themStatus,
    themNote,
    odds,
    lockBtn,
    youNote,
    clock,
    proofBody,
    actions,
    youSide,
    themSide,
    rematch,
    back,
  };

  youBoard.addEventListener('click', (event) => {
    const tile = event.target.closest('.mtile');
    if (tile) void pickTile(Number(tile.dataset.tile), tile);
  });
  lockBtn.addEventListener('click', () => void lockIn());
  back.addEventListener('click', () => leaveArena());
  rematch.addEventListener('click', () => void playAgain(rematch));
}

function clockNode() {
  const NS = 'http://www.w3.org/2000/svg';
  const node = el('div', 'mduel__clock');
  node.setAttribute('role', 'timer');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'circle');
  const arc = document.createElementNS(NS, 'circle');
  for (const circle of [track, arc]) {
    circle.setAttribute('cx', '40');
    circle.setAttribute('cy', '40');
    circle.setAttribute('r', '34');
  }
  track.setAttribute('class', 'mduel__track');
  arc.setAttribute('class', 'mduel__arc');
  svg.append(track, arc);
  const digits = el('b', 'mduel__digits mono');
  node.append(svg, digits);
  return { node, arc, digits, circumference: 2 * Math.PI * 34 };
}

function paintClock() {
  if (!arena || !game) return;
  const { arc, digits, circumference, node } = arena.clock;
  if (game.status !== 'playing') {
    node.hidden = true;
    node.dataset.urgent = '0';
    return;
  }
  node.hidden = false;
  const total = game.playSeconds * 1000;
  const left = Math.max(0, remainingMs());
  const seconds = Math.ceil(left / 1000);
  digits.textContent = `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  arc.style.strokeDasharray = String(circumference);
  arc.style.strokeDashoffset = String(circumference * (1 - left / total));
  node.dataset.urgent = left <= 10_000 ? '1' : '0';
  /* The clock has run out and the server has not told us yet: ask now, rather than at the next poll. */
  if (left === 0 && !busy && !arena.asked) {
    arena.asked = true;
    void refreshGame().finally(() => {
      if (arena) arena.asked = false;
    });
  }
  paintControls();
}

function paintArena() {
  if (!arena || !game) return;
  const g = game;
  const me = g.you;
  const settled = g.status === 'settled';
  arena.wrap.dataset.state = settled ? 'settled' : 'playing';
  arena.live.textContent = settled ? 'Finished' : 'Live';
  arena.live.dataset.state = settled ? 'over' : 'live';

  const result = g.result;
  const picked = new Map((me?.picks ?? []).map((p) => [p.tile, p.mine]));
  const tnt = new Set(result?.mines ?? []);
  const otherRole = me?.role === 'host' ? 'opponent' : 'host';
  const theirPicks = new Map((result?.[otherRole]?.picks ?? []).map((p) => [p.tile, p.mine]));

  for (let i = 0; i < TILES; i += 1) {
    const mine = arena.youTiles[i];
    const kind = picked.has(i)
      ? picked.get(i)
        ? 'boom'
        : 'gem'
      : settled
        ? tnt.has(i)
          ? 'tnt'
          : 'dim-gem'
        : 'hidden';
    setTile(mine, kind);
    const label =
      kind === 'hidden'
        ? `Tile ${i + 1}, not turned`
        : kind === 'gem'
          ? `Tile ${i + 1}, diamond`
          : kind === 'boom'
            ? `Tile ${i + 1}, TNT, you hit it`
            : kind === 'tnt'
              ? `Tile ${i + 1}, TNT`
              : `Tile ${i + 1}, diamond, not turned`;
    mine.setAttribute('aria-label', label);

    const theirs = arena.themTiles[i];
    setTile(
      theirs,
      theirPicks.has(i)
        ? theirPicks.get(i)
          ? 'boom'
          : 'gem'
        : settled
          ? tnt.has(i)
            ? 'tnt'
            : 'dim-gem'
          : 'hidden',
    );
  }

  /* Scores: yours counts up as you play; theirs stays hidden until the end. */
  arena.youScore.textContent = settled ? String(result[me.role].score ?? 0) : String(me?.safe ?? 0);
  arena.youScore.title = settled ? 'Your final score' : 'Safe tiles turned';
  arena.themScore.textContent = settled ? String(result[otherRole].score ?? 0) : '?';
  arena.themScore.dataset.hidden = settled ? '0' : '1';

  /* The other side: no more than "finished" until the reveal. */
  const finished = g.opponentFinished === true;
  arena.themStatus.textContent = settled ? 'Final score' : finished ? 'Finished' : 'Playing';
  arena.themStatus.dataset.state = settled ? 'final' : finished ? 'done' : 'live';
  arena.themNote.textContent = settled
    ? ''
    : 'Their tiles and score stay hidden until you have both finished.';

  paintControls();
  paintProof();
  arena.youSide.dataset.active = !settled && me?.state === 'playing' ? '1' : '0';
  arena.themSide.dataset.active = !settled && me?.state !== 'playing' && !finished ? '1' : '0';
}

function paintControls() {
  if (!arena || !game) return;
  const g = game;
  const me = g.you;
  const settled = g.status === 'settled';
  const playing = canPlay();
  arena.youTiles.forEach((tile) => {
    const live = playing && tile.dataset.kind === 'hidden';
    tile.disabled = !live;
    tile.setAttribute('aria-disabled', String(!live));
  });
  arena.wrap.dataset.turn = playing ? 'you' : 'wait';

  const safe = me?.safe ?? 0;
  if (settled || !me) {
    arena.odds.textContent = '';
    arena.lockBtn.hidden = true;
    arena.youNote.textContent = '';
    return;
  }
  if (me.state === 'playing') {
    const chance = nextSafePercent(g.mines, safe);
    arena.odds.textContent = remainingMs() > 0 ? `Next tile is safe: ${chance}%` : 'Time is up…';
    arena.odds.dataset.risk = chance >= 70 ? 'low' : chance >= 45 ? 'mid' : 'high';
    arena.lockBtn.hidden = false;
    arena.lockBtn.textContent = safe > 0 ? `Lock in · ${safe} safe` : 'Lock in';
    arena.lockBtn.disabled = !playing || safe < 1;
    arena.youNote.textContent =
      safe < 1 ? 'Turn a tile. One TNT and your score is zero.' : 'Push on, or lock in and wait.';
  } else {
    arena.odds.textContent = '';
    arena.lockBtn.hidden = true;
    arena.youNote.textContent =
      me.state === 'busted'
        ? 'You hit TNT: your score is 0. Waiting for your opponent…'
        : `Locked in at ${safe}. Waiting for your opponent…`;
  }
}

function paintProof() {
  if (!arena || !game) return;
  const g = game;
  const body = arena.proofBody;
  body.replaceChildren();
  const list = el('dl', 'mduel__proofdl');
  body.append(list);
  const add = (label, value) => {
    list.append(
      Object.assign(el('dt'), { textContent: label }),
      Object.assign(el('dd', 'mono'), { textContent: value ?? '—' }),
    );
  };
  add('Server seed hash', g.serverSeedHash);
  if (g.result) {
    add('Server seed', g.result.serverSeed);
    add('Host client seed', g.result.hostClientSeed);
    add('Opponent client seed', g.result.opponentClientSeed);
    add('TNT tiles (1–25)', g.result.mines.map((t) => t + 1).join(', '));
  }
  const formula = el('code', 'mduel__formula');
  formula.textContent =
    'Fisher–Yates over the 25 tiles; step i takes HMAC-SHA256(serverSeed, "minesduel:" + hostSeed + ":" + opponentSeed + ":" + i), first 52 bits as a fraction. The first TNT-count tiles of the shuffle are the TNT.';
  body.append(formula);
  if (!g.result) {
    body.append(
      Object.assign(el('p', 'mduel__fine'), {
        textContent:
          'The server committed to this seed before you joined and cannot change it. The seed and both client seeds are revealed when the game ends, so you can recompute the field yourself.',
      }),
    );
  }
}

/* ─────────── playing ─────────── */

async function pickTile(index, node) {
  if (!canPlay() || node.dataset.kind !== 'hidden') return;
  busy = true;
  node.setAttribute('aria-busy', 'true');
  paintControls();
  try {
    const response = await api.post(`/v1/mines-duel/${game.code}/pick`, { tile: index });
    node.removeAttribute('aria-busy');
    busy = false;
    if (!response.accepted) {
      toast({ kind: 'lose', title: 'Time was up', body: 'That tile did not count.' });
      applyGame(response.game);
      return;
    }
    playSound(response.mine ? 'slam' : 'tick');
    applyGame(response.game);
  } catch (error) {
    node.removeAttribute('aria-busy');
    busy = false;
    toast({
      kind: 'lose',
      title: 'Mines Duel',
      body: error?.message || 'That tile could not be turned',
    });
    void refreshGame();
  } finally {
    busy = false;
    paintControls();
  }
}

async function lockIn() {
  if (!canPlay() || (you()?.safe ?? 0) < 1) return;
  busy = true;
  arena.lockBtn.disabled = true;
  try {
    const response = await api.post(`/v1/mines-duel/${game.code}/lock`, {});
    busy = false;
    playSound('click');
    applyGame(response.game);
  } catch (error) {
    busy = false;
    toast({ kind: 'lose', title: 'Mines Duel', body: error?.message || 'Could not lock in' });
    void refreshGame();
  } finally {
    busy = false;
    paintControls();
  }
}

async function playAgain(button) {
  const stake = bigOf(game.stakeMinor);
  button.disabled = true;
  try {
    await api.post('/v1/mines-duel', {
      stakeMinor: stake.toString(),
      mines: game.mines,
      clientSeed: clientSeed(),
    });
    toast({ kind: 'gold', title: 'Rematch open', body: 'Waiting for a challenger.' });
    leaveArena();
    await refreshBalance();
  } catch (error) {
    toast({
      kind: 'lose',
      title: 'Mines Duel',
      body: error?.message || 'The rematch could not be opened',
    });
    button.disabled = false;
  }
}

/* ─────────── the reveal ─────────── */

function revealResult({ instant = false } = {}) {
  if (!arena || !game || game.status !== 'settled') return;
  const g = game;
  const code = g.code;
  const first = !revealed.has(code);
  revealed.add(code);

  const role = g.you?.role;
  const draw = g.outcome === 'draw';
  const won = g.youWon;
  const tone = draw ? 'draw' : won ? 'won' : 'lost';
  const mineScore = g.result[role].score ?? 0;
  const theirScore = g.result[role === 'host' ? 'opponent' : 'host'].score ?? 0;

  const strip = arena.result;
  strip.hidden = false;
  strip.dataset.tone = tone;
  strip.replaceChildren(
    Object.assign(el('b', 'mduel__verdict'), {
      textContent: draw ? 'Draw' : won ? 'Victory' : 'Defeat',
    }),
    Object.assign(el('span', 'mduel__tally mono'), {
      textContent: `${mineScore}  –  ${theirScore}`,
    }),
    Object.assign(el('span', 'mduel__money mono'), {
      textContent: draw
        ? 'Both stakes returned'
        : won
          ? `+${money(Number(g.payoutMinor))}`
          : `-${money(Number(g.stakeMinor))}`,
    }),
  );
  arena.actions.hidden = false;
  arena.wrap.dataset.outcome = tone;

  const finish = () => {
    releaseHold();
    paintClock();
  };
  if (!first || instant || reduceMotion()) {
    finish();
    return;
  }
  /* Tiles fall into place a few at a time, then the verdict lands with its sound. */
  const nodes = [...arena.youTiles, ...arena.themTiles].filter(
    (n) => n.dataset.kind === 'tnt' || n.dataset.kind === 'dim-gem',
  );
  nodes.forEach((node, i) => {
    node.classList.add('is-late');
    node.style.animationDelay = `${Math.min(i * 22, 700)}ms`;
  });
  window.setTimeout(
    () => {
      playSound(draw ? 'chime' : won ? 'win' : 'lose');
      finish();
    },
    Math.min(nodes.length * 22, 700) + 120,
  );
}
