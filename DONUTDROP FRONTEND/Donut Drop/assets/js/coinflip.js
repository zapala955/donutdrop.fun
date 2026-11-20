/* coinflip.js — Coinflip: call heads or tails, the coin is flipped, a right call pays 1.8x.
 *
 * 2026-11-20, the owner: "just make coinflip a normal coinflip game". It was a board of player
 * against player games; it is now one player against the house, like Dice and Limbo. The server
 * owns the coin: one request takes the stake, reads the coin from the player's committed fairness
 * seed and pays a right call, all at once (routes/coinflip-house.ts, lib/coinflip.ts houseFlip);
 * this page shows a coin that has already landed.
 *
 * The look is the redesign preview's: a flat coin, gold ingot for heads and iron for tails, that
 * jumps, turns end over end and drops onto the side the server named, its shadow shrinking as it
 * rises. The strip of the player's last flips sits above it. A right call bursts out of a win card;
 * a wrong one puffs red. Flat, no glow. With reduced motion the coin simply shows its side.
 *
 * A game still open on the old board (opened before the change) is listed under the button with a
 * Cancel; the board refunds it by itself once it lapses anyway.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, adjustStake, el, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { clearWin, fxColors, makeFx, winCard } from './pvfx.js';

const SIDE = {
  heads: { label: 'Heads', art: 'assets/img/items/gold_ingot.png' },
  tails: { label: 'Tails', art: 'assets/img/items/iron_ingot.png' },
};
const RECENT = 12;
/** The whole flip: up, over five times and down, in milliseconds. */
const FLIP_MS = 1_300;

let root = null;
let config = null;
let seedHash = null;
let busy = false;
let stakeText = '1m';
let call = 'heads';
let recent = []; // newest first
let leftovers = []; // this player's games still open on the old board
let fx = null; // the preview's effects over the stage (pvfx.js)
let turn = 0; // the coin's resting angle: 0 shows heads, 180 tails

/* ─────────── the maths, mirrored from lib/coinflip.ts ─────────── */

const payoutBps = () => BigInt(config?.payoutBps ?? 18_000);
const times = () => `${(Number(payoutBps()) / 10_000).toFixed(2)}×`;

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}

function payoutMinor(stake) {
  return (stake * payoutBps()) / 10_000n;
}

function largestBet() {
  return config ? BigInt(config.maxStakeMinor) : 0n;
}

function betProblem() {
  if (!config) return 'Coinflip is not answering';
  if (!config.enabled) return 'Coinflip is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest flip is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest flip is ${money(Number(config.maxStakeMinor))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/coinflip/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    try {
      const { bets } = await api.get(`/v1/coinflip/bets?limit=${RECENT}`);
      recent = bets || [];
    } catch {
      /* The strip stays as it was; the next flip fills it. */
    }
    await loadLeftovers();
  } else {
    recent = [];
    leftovers = [];
  }
  paint();
  if (recent[0] && !busy) rest(recent[0].result, recent[0].win ? 'won' : 'lost');
}

async function loadLeftovers() {
  try {
    const board = await api.get('/v1/coinflip');
    leftovers = (board.games || []).filter((game) => game.host?.isYou);
  } catch {
    leftovers = [];
  }
}

async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}

async function flip() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || betProblem()) return;
  busy = true;
  paintControls();
  clearWin($('.cflip__stage', root));
  /* Held from the click: the server's balance event can outrun its own answer, and the pill must
   * not move before the coin lands. */
  const release = holdLiveFigures();
  try {
    const stake = stakeMinor().toString();
    // Sent once more against a fresh commitment if another game or tab spent this one.
    const response = await betOnCommitment(seedHash, (serverSeedHash, key) => api.post(
      '/v1/coinflip/bets',
      { stakeMinor: stake, side: call, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    seedHash = response.nextServerSeedHash || null;
    const placed = response.bet;
    await land(placed);
    showBalance(response.balanceMinor);
    release();
    recent = [placed, ...recent.filter((row) => row.id !== placed.id)].slice(0, RECENT);
    const landed = SIDE[placed.result].label;
    say(placed.win
      ? `${landed}. You called it: ${money(Number(placed.payoutMinor))}.`
      : `${landed}. You called ${SIDE[placed.side].label.toLowerCase()}, and lost ${money(Number(placed.stakeMinor))}.`);
  } catch (error) {
    release();
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    toast({ kind: 'lose', title: 'Coinflip', body: error?.message || 'That flip did not go through' });
    void refreshBalance();
  } finally {
    busy = false;
    paint();
  }
}

async function cancelLeftover(game, button) {
  button.disabled = true;
  try {
    await api.post(`/v1/coinflip/${game.code}/cancel`, {});
    toast({ kind: 'gold', title: 'Cancelled', body: 'Your stake is back in your wallet' });
  } catch (error) {
    toast({ kind: 'lose', title: 'Not cancelled', body: error?.message || 'Try again' });
  }
  void refreshBalance();
  await loadLeftovers();
  paintLeftovers();
}

/* ─────────── motion ─────────── */

/** The coin at rest on a side, and the word under it in a tone: '' neutral, 'won', 'lost'. */
function rest(side, tone) {
  const body = $('#cflipBody', root);
  const word = $('#cflipWord', root);
  if (!body || !word) return;
  turn = side === 'tails' ? 180 : 0;
  body.style.transform = `rotateX(${turn}deg)`;
  word.textContent = tone ? SIDE[side].label : '';
  word.dataset.tone = tone;
}

/**
 * The flip: the coin jumps, turns over five times and a half if the side changes, and drops onto
 * the side the server named; it ticks as it turns. Resolves when it has landed.
 */
function land(placed) {
  const body = $('#cflipBody', root);
  const lift = $('#cflipLift', root);
  const shadow = $('#cflipShadow', root);
  const word = $('#cflipWord', root);
  const won = placed.win;
  const finish = () => {
    rest(placed.result, won ? 'won' : 'lost');
    playSound(won ? 'win' : 'lose');
    landFx(placed);
  };
  word.textContent = '';
  word.dataset.tone = '';
  if (reduceMotion() || !body.animate) {
    finish();
    return Promise.resolve();
  }
  const target = placed.result === 'tails' ? 180 : 0;
  const end = turn + 5 * 360 + ((target - turn + 360) % 360);
  playSound('coin');
  const spin = body.animate(
    [{ transform: `rotateX(${turn}deg)` }, { transform: `rotateX(${end}deg)` }],
    { duration: FLIP_MS * 0.82, easing: 'cubic-bezier(.3, .55, .35, 1)', fill: 'forwards' },
  );
  lift.animate(
    [
      { transform: 'none' },
      { transform: 'translateY(-95%) scale(1.18)', offset: 0.42, easing: 'ease-in' },
      { transform: 'none', offset: 0.82, easing: 'ease-out' },
      { transform: 'translateY(-12%)', offset: 0.9, easing: 'ease-in' },
      { transform: 'none' },
    ],
    { duration: FLIP_MS },
  );
  shadow.animate(
    [
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(.45)', opacity: 0.35, offset: 0.42 },
      { transform: 'scale(1)', opacity: 1, offset: 0.82 },
      { transform: 'scale(.85)', offset: 0.9 },
      { transform: 'scale(1)' },
    ],
    { duration: FLIP_MS },
  );
  for (let i = 0; i < 8; i += 1) {
    setTimeout(() => playSound('tick', { rate: 0.9 + i * 0.06 }), 60 + i * 120);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      spin.cancel();
      finish();
      resolve();
    }, FLIP_MS);
  });
}

/** The preview's landing: a right call bursts out of a win card; a wrong one puffs red. */
function landFx(placed) {
  if (!fx) return;
  const stage = $('.cflip__stage', root);
  if (placed.win) {
    winCard(stage, fx, Number(payoutBps()) / 10_000, Number(placed.payoutMinor));
    return;
  }
  const [x, y] = fx.at($('#cflipCoin', root));
  fx.puff(x, y + 30, { n: 4, color: fxColors().loss, size: 12 });
}

/* One polite, whole sentence per flip. */
function say(text) {
  const node = $('#cflipSay', root);
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintRecent();
  paintCall();
  paintControls();
  paintLeftovers();
}

function paintRecent() {
  const list = $('#cflipRecent', root);
  const ids = recent.map((row) => row.id).join(',');
  if (list.dataset.ids === ids) return;
  const first = list.dataset.ids ? list.dataset.ids.split(',')[0] : null;
  list.dataset.ids = ids;
  list.replaceChildren(...recent.map((row) => {
    const item = el('li', 'cflip__chip');
    item.dataset.tone = row.win ? 'won' : 'lost';
    item.dataset.side = row.result;
    if (first && row.id !== first && row === recent[0]) item.dataset.fresh = '1';
    const img = el('img');
    img.src = SIDE[row.result].art;
    img.alt = '';
    item.append(img);
    item.setAttribute('aria-label', `${SIDE[row.result].label}, ${row.win ? 'won' : 'lost'}`);
    return item;
  }));
}

function paintCall() {
  for (const button of root.querySelectorAll('.cflip__side')) {
    button.setAttribute('aria-checked', String(button.dataset.side === call));
  }
}

function paintControls() {
  const go = $('#cflipGo', root);
  const label = $('#cflipGoLabel', root);
  const hint = $('#cflipHint', root);
  const stake = stakeMinor();
  let text;
  if (!state.authenticated) text = 'Log in to play';
  else if (busy) text = 'Flipping…';
  else text = `Flip ${SIDE[call].label.toLowerCase()} · ${money(Number(stake ?? 0n))}`;
  if (label.textContent !== text) label.textContent = text;
  const problem = state.authenticated ? betProblem() : '';
  go.disabled = busy || Boolean(problem);
  go.setAttribute('aria-busy', String(busy));
  hint.textContent = problem;

  $('#cflipProfit', root).value = stake && stake > 0n ? money(Number(payoutMinor(stake) - stake)) : '—';
  $('#cflipProfitX', root).textContent = times();

  for (const node of root.querySelectorAll('.cflip__panel input, .cflip__adj, .cflip__side')) {
    node.disabled = busy;
  }
}

function paintLeftovers() {
  const box = $('#cflipOld', root);
  box.hidden = leftovers.length === 0;
  if (!leftovers.length) {
    box.replaceChildren();
    return;
  }
  const head = el('p', 'cflip__oldhead');
  head.textContent = 'Still open on the old board';
  const rows = leftovers.map((game) => {
    const row = el('div', 'cflip__oldrow');
    const text = el('span');
    text.textContent = `${money(Number(game.stakeMinor))} on ${SIDE[game.host.side]?.label ?? game.host.side}`;
    const cancel = el('button', 'cflip__oldcancel');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => void cancelLeftover(game, cancel));
    row.append(text, cancel);
    return row;
  });
  box.replaceChildren(head, ...rows);
}

/* ─────────── building ─────────── */

function build() {
  const face = (side) => `<div class="cflip__face cflip__face--${side}"><img src="${SIDE[side].art}" alt="" draggable="false" /></div>`;
  const pick = (side) => `<button type="button" class="cflip__side" role="radio" data-side="${side}" aria-checked="false"><img src="${SIDE[side].art}" alt="" /><b>${SIDE[side].label}</b></button>`;
  root.innerHTML = `
    <section class="cflip__stage" aria-label="The coin">
      <div class="cflip__top">
        <ol class="cflip__recent" id="cflipRecent" aria-label="Your last flips, newest first"></ol>
      </div>
      <div class="cflip__show">
        <div class="cflip__coin" id="cflipCoin" aria-hidden="true">
          <div class="cflip__shadow" id="cflipShadow"></div>
          <div class="cflip__lift" id="cflipLift">
            <div class="cflip__body" id="cflipBody">${face('heads')}${face('tails')}</div>
          </div>
        </div>
        <b class="cflip__word" id="cflipWord" data-tone=""></b>
      </div>
    </section>

    <aside class="cflip__panel" aria-label="Your flip">
      <form class="cflip__form" id="cflipForm" novalidate>
        <label class="cflip__label" for="cflipStake">Bet amount</label>
        <div class="cflip__field">
          <span aria-hidden="true">$</span>
          <input id="cflipStake" inputmode="text" autocapitalize="off" autocorrect="off" enterkeyhint="go" autocomplete="off" spellcheck="false" />
          <button type="button" class="cflip__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="cflip__adj" data-adj="double" aria-label="Double the stake">2×</button>
          <button type="button" class="cflip__adj" data-adj="max" aria-label="Bet the most you can">Max</button>
        </div>
        <span class="cflip__label" id="cflipCallLabel">Your call</span>
        <div class="cflip__sides" role="radiogroup" aria-labelledby="cflipCallLabel">${pick('heads')}${pick('tails')}</div>
        <label class="cflip__label cflip__label--row" for="cflipProfit"><span>Profit on win</span><span class="cflip__profitx" id="cflipProfitX"></span></label>
        <div class="cflip__field cflip__field--read">
          <output id="cflipProfit" for="cflipStake">—</output>
        </div>
        <button class="btn cflip__go" id="cflipGo" type="submit" data-sfx="none">
          <span id="cflipGoLabel">Loading…</span>
        </button>
        <p class="cflip__hint" id="cflipHint" aria-live="polite"></p>
      </form>
      <div class="cflip__old" id="cflipOld" hidden></div>
    </aside>
    <div class="cflip__say" id="cflipSay" role="status" aria-atomic="true"></div>`;

  fx = makeFx($('.cflip__stage', root));

  const stake = $('#cflipStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paintControls(); });
  root.querySelectorAll('.cflip__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(adjustStake(button.dataset.adj, current, state.balanceMinor, largestBet())));
    stake.value = stakeText;
    paintControls();
  }));

  const sides = $('.cflip__sides', root);
  sides.addEventListener('click', (event) => {
    const button = event.target.closest('.cflip__side');
    if (!button || busy) return;
    call = button.dataset.side;
    playSound('click');
    paintCall();
    paintControls();
  });
  // A radio group: the arrow keys move the call.
  sides.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || busy) return;
    event.preventDefault();
    call = call === 'heads' ? 'tails' : 'heads';
    paintCall();
    paintControls();
    $(`.cflip__side[data-side="${call}"]`, root)?.focus();
  });

  $('#cflipForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void flip();
  });
}

export function mountCoinflip(section) {
  root = $('#coinflipRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    /* A refresh mounts this page before the session check has answered; ready and login are the
     * moments the player's own flips can first be asked for. */
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        recent = [];
        leftovers = [];
        seedHash = null;
        rest('heads', '');
      }
      if (!busy) paint();
    });
  }
  void load();
}
