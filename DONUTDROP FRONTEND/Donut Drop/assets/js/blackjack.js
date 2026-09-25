/* blackjack.js — one hand against the dealer, dealt from the player's committed fairness seed.
 *
 * The server decides everything: which cards, what the dealer draws, what is paid. This module
 * only shows it, in the order a real table would -- cards leave the shoe one at a time, the hole
 * card turns over when the player is done, the dealer draws after that -- and it holds the header
 * balance until the last card has landed, so the pill never announces a result the table has not
 * shown yet.
 *
 * Motion is kept to what carries information: a card arriving, the hole card turning, one pulse
 * on a win. With reduced motion every one of those becomes a short fade.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, state } from './store.js';
import { $, el, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';

const DEAL_MS = 340; // shoe to seat
const DEAL_GAP_MS = 170; // between cards on the deal
const DEALER_GAP_MS = 460; // between the dealer's own draws, so each can be read
const FLIP_MS = 380;
const EASE = 'cubic-bezier(.22, 1, .36, 1)';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_NAMES = ['Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Jack', 'Queen', 'King'];
// Text presentation (U+FE0E) so no platform swaps the suit for a coloured emoji.
const SUITS = [
  { key: 'spade', name: 'spades', glyph: String.fromCodePoint(0x2660, 0xfe0e) },
  { key: 'heart', name: 'hearts', glyph: String.fromCodePoint(0x2665, 0xfe0e) },
  { key: 'diamond', name: 'diamonds', glyph: String.fromCodePoint(0x2666, 0xfe0e) },
  { key: 'club', name: 'clubs', glyph: String.fromCodePoint(0x2663, 0xfe0e) },
];

const RESULT = {
  blackjack: { title: 'Blackjack', tone: 'win' },
  win: { title: 'You win', tone: 'win' },
  push: { title: 'Push', tone: 'push' },
  tie: { title: 'Tie · dealer wins ties', tone: 'lose' },
  lose: { title: 'Dealer wins', tone: 'lose' },
  bust: { title: 'Bust', tone: 'lose' },
  dealer_blackjack: { title: 'Dealer blackjack', tone: 'lose' },
};

let root = null;
let config = null;
let seedHash = null;
let hand = null;
let busy = false;
let pressed = null; // which control is waiting on the server, for its label
let stakeText = '1m';
let shown = { player: 0, dealer: 0 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* An animation's end, or its scheduled length plus a margin -- whichever comes first. A browser
 * that pauses animations (a background tab, a power saver) must not leave a hand stuck half-dealt
 * with every button disabled: the table moves on whether or not the motion was seen. */
function settled(animation, ms) {
  return Promise.race([animation.finished.catch(() => undefined), wait(ms + 80)]);
}

/* ─────────── cards ─────────── */

function cardValue(face) {
  const rank = face % 13;
  if (rank === 0) return 11;
  return rank >= 9 ? 10 : rank + 1;
}

function totalOf(faces) {
  let total = 0;
  let aces = 0;
  for (const face of faces) {
    total += cardValue(face);
    if (face % 13 === 0) aces += 1;
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

function faceLabel(face) {
  return `${RANK_NAMES[face % 13]} of ${SUITS[Math.floor(face / 13)].name}`;
}

function paintFace(card, face) {
  const suit = SUITS[Math.floor(face / 13)];
  const front = $('.bjcard__front', card);
  front.replaceChildren();
  const corner = el('span', 'bjcard__corner');
  corner.append(el('b'), el('i'));
  corner.firstChild.textContent = RANKS[face % 13];
  corner.lastChild.textContent = suit.glyph;
  const pip = el('span', 'bjcard__pip');
  pip.textContent = suit.glyph;
  front.append(corner, pip);
  card.dataset.suit = suit.key;
  card.setAttribute('aria-label', faceLabel(face));
}

/** A slot (which flies), holding a card (which may lie sideways), holding faces (which flip). */
function makeCard(face, { sideways = false } = {}) {
  const slot = el('div', 'bjslot');
  const card = el('div', 'bjcard');
  card.setAttribute('role', 'img');
  if (sideways) card.dataset.sideways = '1';
  const inner = el('div', 'bjcard__inner');
  inner.append(el('div', 'bjcard__face bjcard__front'), el('div', 'bjcard__face bjcard__back'));
  card.append(inner);
  slot.append(card);
  if (face === null || face === undefined) {
    card.dataset.down = '1';
    card.setAttribute('aria-label', 'Face-down card');
  } else {
    paintFace(card, face);
  }
  return slot;
}

/** Sends a card from the shoe to its place; resolves when it lands. */
function flyIn(slot, delay = 0) {
  if (reduceMotion()) {
    return settled(slot.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 120, delay, fill: 'backwards',
    }), delay + 120);
  }
  const shoe = $('.bj__shoe', root).getBoundingClientRect();
  const at = slot.getBoundingClientRect();
  const dx = shoe.left + shoe.width / 2 - (at.left + at.width / 2);
  const dy = shoe.top + shoe.height / 2 - (at.top + at.height / 2);
  return settled(slot.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(-14deg) scale(.86)`, opacity: 0 },
    { opacity: 1, offset: 0.25 },
    { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
  ], { duration: DEAL_MS, delay, easing: EASE, fill: 'backwards' }), delay + DEAL_MS);
}

/** Turns a face-down card over to show `face`. */
async function flip(slot, face) {
  const card = $('.bjcard', slot);
  paintFace(card, face);
  if (reduceMotion()) {
    delete card.dataset.down;
    return;
  }
  const inner = $('.bjcard__inner', card);
  delete card.dataset.down;
  await settled(inner.animate(
    [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }],
    { duration: FLIP_MS, easing: EASE },
  ), FLIP_MS);
}

/* ─────────── the table ─────────── */

function seat(name) {
  return {
    cards: $(`#bj${name}Cards`, root),
    total: $(`#bj${name}Total`, root),
  };
}

function paintTotal(which, faces, { final = false } = {}) {
  const node = seat(which).total;
  if (!faces.length) {
    node.hidden = true;
    return;
  }
  const { total, soft } = totalOf(faces);
  node.hidden = false;
  node.textContent = soft && total < 21 && !final ? `Soft ${total}` : String(total);
  node.dataset.state = total > 21 ? 'bust' : total === 21 ? 'twentyone' : '';
}

function paintBet() {
  const bet = $('#bjBet', root);
  if (!hand) { bet.hidden = true; return; }
  const onTable = BigInt(hand.stakeMinor) * (hand.doubled ? 2n : 1n);
  bet.hidden = false;
  bet.textContent = `Bet ${money(Number(onTable))}`;
}

function clearTable() {
  seat('Player').cards.replaceChildren();
  seat('Dealer').cards.replaceChildren();
  paintTotal('Player', []);
  paintTotal('Dealer', []);
  $('#bjResult', root).hidden = true;
  $('.bj__seat--player', root).dataset.result = '';
  delete $('.bj__table', root).dataset.result;
  shown = { player: 0, dealer: 0 };
}

/** Everything at once, no motion: resuming a hand, or arriving at the page mid-hand. */
function drawStatic(current) {
  clearTable();
  const settled = current.status === 'settled';
  current.player.cards.forEach((face, index) => {
    seat('Player').cards.append(makeCard(face, { sideways: current.doubled && index === 2 }));
  });
  current.dealer.cards.forEach((face) => seat('Dealer').cards.append(makeCard(face)));
  shown = { player: current.player.cards.length, dealer: current.dealer.cards.length };
  paintTotal('Player', current.player.cards, { final: settled });
  paintTotal('Dealer', current.dealer.cards.filter((face) => face !== null), { final: settled });
  paintBet();
  if (settled) paintResult(current, { animate: false });
}

/** Adds one card to a seat and waits for it to land, then updates that seat's total. */
async function deliver(which, face, { delay = 0, sideways = false, faces }) {
  const slot = makeCard(face, { sideways });
  seat(which).cards.append(slot);
  await flyIn(slot, delay);
  playSound('tick');
  if (faces) paintTotal(which, faces);
  return slot;
}

async function animateDeal(current) {
  clearTable();
  paintBet();
  const [p1, p2] = current.player.cards;
  const [d1] = current.dealer.cards;
  /* The hole card goes down face-down even when the hand is already over (a natural): the reveal
   * is its own beat, handled by finish(). */
  const order = [
    ['Player', p1, [p1]],
    ['Dealer', d1, [d1]],
    ['Player', p2, [p1, p2]],
    ['Dealer', null, null],
  ];
  const landings = order.map(([which, face, faces], index) =>
    deliver(which, face, { delay: index * DEAL_GAP_MS, faces }));
  await Promise.all(landings);
  shown = { player: 2, dealer: 2 };
}

/** The hand is over: turn the hole card, let the dealer draw, then say what happened. */
async function finish(current) {
  const dealerCards = current.dealer.cards;
  const hole = seat('Dealer').cards.children[1];
  if (hole && $('.bjcard', hole)?.dataset.down) {
    await wait(reduceMotion() ? 0 : 220);
    await flip(hole, dealerCards[1]);
    paintTotal('Dealer', dealerCards.slice(0, 2));
  }
  for (let index = shown.dealer; index < dealerCards.length; index += 1) {
    await wait(reduceMotion() ? 0 : DEALER_GAP_MS - DEAL_MS);
    await deliver('Dealer', dealerCards[index], { faces: dealerCards.slice(0, index + 1) });
  }
  shown.dealer = dealerCards.length;
  paintTotal('Dealer', dealerCards, { final: true });
  paintTotal('Player', current.player.cards, { final: true });
  paintResult(current, { animate: true });
}

function paintResult(current, { animate }) {
  const box = $('#bjResult', root);
  const result = RESULT[current.outcome] ?? { title: 'Hand over', tone: 'push' };
  const onTable = BigInt(current.stakeMinor) * (current.doubled ? 2n : 1n);
  const net = BigInt(current.payoutMinor ?? '0') - onTable;
  $('b', box).textContent = result.title;
  $('span', box).textContent = net > 0n
    ? `+${money(Number(net))}`
    : net === 0n ? 'Stake returned' : `−${money(Number(-net))}`;
  box.dataset.tone = result.tone;
  box.hidden = false;
  $('.bj__seat--player', root).dataset.result = result.tone;
  $('.bj__table', root).dataset.result = result.tone;
  if (!animate) return;
  playSound(result.tone === 'win' ? (current.outcome === 'blackjack' ? 'reward' : 'win') : result.tone === 'lose' ? 'lose' : 'chime');
  if (!reduceMotion()) {
    box.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(.94)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }], {
      duration: 240, easing: EASE,
    });
  }
}

function paintFairness(current) {
  const line = $('#bjFair', root);
  if (!current) {
    line.textContent = seedHash ? `Next hand commits to server seed ${seedHash.slice(0, 16)}…` : '';
    return;
  }
  const f = current.fairness;
  line.textContent = f.serverSeed
    ? `Server seed ${f.serverSeed} · SHA-256 ${f.serverSeedHash.slice(0, 16)}… · client seed ${f.clientSeed} · nonce ${f.nonce}`
    : `Dealt from committed server seed ${f.serverSeedHash.slice(0, 16)}… · revealed when the hand ends`;
}

/* ─────────── controls ─────────── */

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function stakeProblem() {
  const stake = stakeMinor();
  if (!config) return 'The table is not answering';
  if (!config.enabled) return 'The table is closed right now';
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest hand is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest hand is ${money(Number(config.maxStakeMinor))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

function paintControls() {
  if (!root) return;
  const inPlay = hand?.status === 'active';
  $('#bjBetting', root).hidden = inPlay;
  $('#bjActions', root).hidden = !inPlay;

  const deal = $('#bjDeal', root);
  const problem = stakeProblem();
  const hint = $('#bjHint', root);
  if (!state.authenticated) {
    deal.textContent = 'Log in to play';
    deal.disabled = false;
    hint.textContent = '';
  } else {
    deal.textContent = busy && pressed === 'deal' ? 'Dealing…' : hand ? 'Deal again' : 'Deal';
    deal.disabled = busy || Boolean(problem);
    hint.textContent = problem;
  }
  deal.setAttribute('aria-busy', String(busy && pressed === 'deal'));

  if (inPlay) {
    const stake = BigInt(hand.stakeMinor);
    const canAffordDouble = BigInt(state.balanceMinor || '0') >= stake;
    const double = $('#bjDouble', root);
    $('#bjDoubleLabel', root).textContent = `Double ${money(Number(stake))}`;
    double.disabled = busy || !hand.canDouble || !canAffordDouble;
    double.title = !hand.canDouble ? 'Only on your first two cards' : canAffordDouble ? '' : 'Not enough balance to double';
    $('#bjHit', root).disabled = busy;
    $('#bjStand', root).disabled = busy;
    for (const id of ['bjHit', 'bjStand', 'bjDouble']) {
      $(`#${id}`, root).setAttribute('aria-busy', String(busy && pressed === id));
    }
  }
}

function problemToast(error) {
  toast({ kind: 'lose', title: 'Blackjack', body: error?.message || 'That did not go through' });
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function deal() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || stakeProblem()) return;
  busy = true;
  pressed = 'deal';
  paintControls();
  const release = holdLiveFigures();
  try {
    if (!seedHash) await refreshSeed();
    const response = await api.post(
      '/v1/blackjack/hands',
      { stakeMinor: stakeMinor().toString(), clientSeed: clientSeed(), serverSeedHash: seedHash },
      { idempotencyKey: idempotencyKey() },
    );
    hand = response.hand;
    paintFairness(hand);
    await animateDeal(hand);
    if (hand.status === 'settled') await settleShown();
  } catch (error) {
    // A commitment rotated elsewhere (another tab played the upgrader): pick up the new one.
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    problemToast(error);
  } finally {
    release();
    busy = false;
    pressed = null;
    await refreshBalance();
    paintControls();
  }
}

async function settleShown() {
  await finish(hand);
  paintFairness(hand);
  await refreshSeed();
}

async function act(action, buttonId) {
  if (busy || hand?.status !== 'active') return;
  busy = true;
  pressed = buttonId;
  paintControls();
  const release = holdLiveFigures();
  try {
    const response = await api.post(`/v1/blackjack/hands/${hand.id}/actions`, {
      action,
      cardsInHand: hand.player.cards.length,
    });
    hand = response.hand;
    paintBet();
    const cards = hand.player.cards;
    for (let index = shown.player; index < cards.length; index += 1) {
      await deliver('Player', cards[index], {
        sideways: action === 'double',
        faces: cards.slice(0, index + 1),
      });
    }
    shown.player = cards.length;
    if (hand.status === 'settled') await settleShown();
  } catch (error) {
    problemToast(error);
    // The hand moved on somewhere else (another tab, a double click): show where it really is.
    if (error?.code === 'STALE_ACTION' || error?.code === 'HAND_SETTLED') await reload();
  } finally {
    release();
    busy = false;
    pressed = null;
    await refreshBalance();
    paintControls();
  }
}

async function reload() {
  if (!state.authenticated) return;
  try {
    const { hand: active } = await api.get('/v1/blackjack/hands/active');
    if (active) {
      hand = active;
      drawStatic(hand);
      paintFairness(hand);
    }
  } catch {
    // The table stays as it was; the next action will say what is wrong.
  }
}

/* ─────────── build ─────────── */

function build() {
  root.innerHTML = `
    <div class="bj__table">
      <div class="bj__shoe" aria-hidden="true"><span></span></div>
      <section class="bj__seat bj__seat--dealer" aria-label="Dealer">
        <div class="bj__label"><span>Dealer</span><output class="bj__total" id="bjDealerTotal" hidden></output></div>
        <div class="bj__cards" id="bjDealerCards"></div>
      </section>
      <svg class="bj__felt" viewBox="0 0 640 96" aria-hidden="true" focusable="false">
        <path id="bjArc" d="M 40 24 Q 320 104 600 24" fill="none" />
        <text><textPath href="#bjArc" startOffset="50%" text-anchor="middle">BLACKJACK PAYS 3 TO 2 · DEALER WINS TIES</textPath></text>
      </svg>
      <p class="bj__rules"><span class="bj__rules-tie">Dealer wins ties · </span>Dealer hits soft 17 · Blackjack against blackjack pushes · Double on any first two cards</p>
      <section class="bj__seat bj__seat--player" aria-label="Your hand">
        <div class="bj__cards" id="bjPlayerCards"></div>
        <div class="bj__label"><span>You</span><output class="bj__total" id="bjPlayerTotal" hidden></output><span class="bj__bet" id="bjBet" hidden></span></div>
      </section>
      <div class="bj__result" id="bjResult" role="status" aria-live="polite" hidden><b></b><span></span></div>
    </div>

    <div class="bj__controls">
      <form class="bj__betting" id="bjBetting" novalidate>
        <label class="bj__stakelabel" for="bjStake">Stake</label>
        <div class="bj__stake">
          <span aria-hidden="true">$</span>
          <input id="bjStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="bj__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="bj__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <button class="btn btn--go bj__deal" id="bjDeal" type="submit">Deal</button>
        <p class="bj__hint" id="bjHint" aria-live="polite"></p>
      </form>
      <div class="bj__actions" id="bjActions" hidden>
        <button class="btn btn--go" id="bjHit" type="button" aria-keyshortcuts="H">Hit <kbd>H</kbd></button>
        <button class="btn" id="bjStand" type="button" aria-keyshortcuts="S">Stand <kbd>S</kbd></button>
        <button class="btn" id="bjDouble" type="button" aria-keyshortcuts="D"><span id="bjDoubleLabel">Double</span> <kbd>D</kbd></button>
      </div>
    </div>
    <p class="bj__fair" id="bjFair"></p>`;

  const input = $('#bjStake', root);
  input.value = stakeText;
  input.addEventListener('input', () => { stakeText = input.value; paintControls(); });
  root.querySelectorAll('.bj__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    const next = button.dataset.adj === 'half' ? current / 2n : current * 2n;
    stakeText = formatAmountInput(Number(next));
    input.value = stakeText;
    paintControls();
  }));
  $('#bjBetting', root).addEventListener('submit', (event) => { event.preventDefault(); void deal(); });
  $('#bjHit', root).addEventListener('click', () => void act('hit', 'bjHit'));
  $('#bjStand', root).addEventListener('click', () => void act('stand', 'bjStand'));
  $('#bjDouble', root).addEventListener('click', () => void act('double', 'bjDouble'));

  /* H, S, D while a hand is live -- unless the player is typing, or the page is not showing. */
  document.addEventListener('keydown', (event) => {
    if (!root?.isConnected || root.closest('.view')?.hidden) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (hand?.status !== 'active') return;
    const key = event.key.toLowerCase();
    if (key === 'h') { event.preventDefault(); void act('hit', 'bjHit'); }
    else if (key === 's') { event.preventDefault(); void act('stand', 'bjStand'); }
    else if (key === 'd' && !$('#bjDouble', root).disabled) { event.preventDefault(); void act('double', 'bjDouble'); }
  });

  // Signing in or out, and every balance change, can change what the controls allow.
  bus.addEventListener('change', () => {
    if (!busy) paintControls();
  });
}

async function load() {
  try {
    config = await api.get('/v1/blackjack/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    if (!busy) await reload();
  }
  if (!hand) paintFairness(null);
  paintControls();
}

export function mountBlackjack(view) {
  root = $('#blackjackRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    build();
    root.dataset.built = '1';
  }
  void load();
}
