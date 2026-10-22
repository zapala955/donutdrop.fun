/* icefishing.js — Ice Fishing: a frozen lake, twenty-five places to drill through it, and somewhere
 * under the snow the ice is thin. Every hole that brings up a fish raises the multiplier; drilling
 * through thin ice loses the stake; pull out after any fish. Mines on the ice, and the same maths.
 *
 * The server owns the lake (lib/ice-fishing.ts, routes/ice-fishing.ts). It lays the thin ice when
 * the game starts, from the player's committed fairness seed, and never tells this page where it is
 * until the game is over; every hole drilled is a request, and the answer is a fish or the end. The
 * page prices the next hole honestly before it is drilled, and keeps the one button in step: Start,
 * then Pull out, then the result.
 *
 * The lake is drawn in WebGL (icefishing3d.js), its own chunk, at the graphics the player picked or
 * the machine can manage, and holes are picked on it; without WebGL the flat lake (a grid of ice
 * blocks) does the same job. Every result is in the page as text too.
 */
import { api, clientSeed } from './api.js';
import { betOnCommitment, bus, refreshBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { openModal, toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';

const HOLES = 25;
const QUICK_THIN = [1, 3, 5, 10, 20];
const EDGE_BPS = 1000n;
const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
const LOG_SIZE = 12;
const BIG_BPS = 100_000;

const icon = (id) => `assets/img/items/${id}.png`;
const times = (bps) => `${(Math.floor(bps / 100) / 100).toFixed(2)}×`;
const pct = (bps) => `${Math.round(bps / 100)}%`;

/* ─────────── the maths, mirrored from lib/mines.ts, which lib/ice-fishing.ts plays by ─────────── */

/** The multiplier, in basis points, for pulling out after `drilled` fish. */
function multiplierBps(thin, drilled) {
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < drilled; i += 1) {
    num *= BigInt(HOLES - i);
    den *= BigInt(HOLES - thin - i);
  }
  return Number(((10_000n - EDGE_BPS) * num) / den);
}
function fishChanceBps(thin, drilled) {
  const left = HOLES - drilled;
  const fish = HOLES - thin - drilled;
  return left > 0 && fish > 0 ? Math.floor((fish * 10_000) / left) : 0;
}

let root = null;
let view = null;
let config = null;
let seedHash = null;
let game = null; // the active or last-finished game, as the server described it
let busy = false;
let stakeText = '1m';
let thinCount = 3;
let session = { games: 0, won: 0n, best: 0n };
let log = []; // newest first: { outcome, bps, catchId }
let lake = null; // the 3D lake, once it is up
let lakeTried = null;

const inPlay = () => game?.status === 'active';

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}
function startProblem() {
  if (!config) return 'Ice Fishing is not answering';
  if (!config.enabled) return 'Ice Fishing is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest stake is ${money(Number(config.minStakeMinor))}`;
  if (stake > BigInt(config.maxStakeMinor)) return `The largest stake is ${money(Number(config.maxStakeMinor))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}
const catchName = (id) => config?.catches?.find((c) => c.id === id)?.name ?? id;

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/ice-fishing/config');
  } catch {
    config = null;
  }
  if (state.authenticated) {
    await refreshSeed();
    await reload();
    await loadLog();
  } else {
    game = null;
  }
  paint();
  if (config) await startLake();
  syncLake();
}
async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}
/** Puts a game the server knows about back on the lake. */
async function reload() {
  try {
    const { game: active } = await api.get('/v1/ice-fishing/games/active');
    if (active) game = active;
    else if (inPlay()) game = null;
  } catch {
    /* a failed read leaves the lake as it was; the next action says what is wrong */
  }
}
async function loadLog() {
  try {
    const { games } = await api.get(`/v1/ice-fishing/games?limit=${LOG_SIZE}`);
    log = games.map(logEntry);
  } catch {
    /* the log is a nicety */
  }
}
const logEntry = (g) => ({ outcome: g.outcome, bps: g.outcome === 'cashout' ? g.multiplierBps ?? 0 : 0, catchId: g.catches?.[g.catches.length - 1] ?? null });

/* ─────────── the lake ─────────── */

function startLake() {
  if (lakeTried) return lakeTried;
  lakeTried = (async () => {
    const host = $('.icefish__lake', root);
    try {
      const { createIce3d } = await import('./icefishing3d.js');
      const built = await createIce3d(host, { catches: config.catches.map((c) => c.id), icon });
      if (!built) return;
      built.onLost = () => {
        if (lake === built) lake = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onPick = (hole) => { void drill(hole); };
      built.onCue = (cue, at) => {
        if (cue === 'crack') playSound('click', { rate: 0.6 + at * 0.15 });
        else if (cue === 'catch') playSound('splash', { rate: 1.1 });
        else if (cue === 'thin') { playSound('shatter', { rate: 0.6 }); playSound('splash', { rate: 0.6 }); }
        else if (cue === 'firework') playSound('shatter', { rate: 1.5 });
      };
      lake = built;
      root.dataset.render = '3d';
      syncLake();
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    }
  })();
  return lakeTried;
}
/** The 3D lake as the game stands: the holes drilled, what they held, and whether it takes a pick. */
function syncLake() {
  if (!lake) return;
  if (game) {
    lake.setBoard(game.drilled, game.catches);
    if (game.status === 'settled' && game.thinHoles) {
      lake.reveal(game.thinHoles, game.thinHit);
    }
  } else {
    lake.reset();
  }
  lake.setActive(inPlay() && !busy);
}
function setGraphics(value) {
  if (busy || inPlay() || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (lake) {
    lake.dispose();
    lake = null;
    lakeTried = null;
    root.dataset.render = '2d';
    if (config) void startLake();
  }
  paintGraphics();
}

/* ─────────── a game ─────────── */

async function start() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  if (busy || inPlay() || startProblem()) return;
  busy = true;
  paint();
  try {
    // Sent once more against a fresh commitment if another game or tab spent this one.
    const response = await betOnCommitment(seedHash, (serverSeedHash, key) => api.post(
      '/v1/ice-fishing/games',
      { stakeMinor: stakeMinor().toString(), thin: thinCount, clientSeed: clientSeed(), serverSeedHash },
      { idempotencyKey: key },
    ));
    game = response.game;
    lake?.reset();
    hideResult();
    playSound('click');
    say(`A fresh lake, ${thinCount} of its holes thin ice. Pick a hole.`);
    await refreshSeed();
  } catch (error) {
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    if (error?.code === 'GAME_IN_PLAY') {
      await reload();
      toast({ kind: 'gold', title: 'Ice Fishing', body: 'Your game on the ice is back.' });
    } else {
      toast({ kind: 'lose', title: 'Ice Fishing', body: error?.message || 'That game did not start' });
    }
  } finally {
    busy = false;
    void refreshBalance();
    paint();
    syncLake();
  }
}

async function drill(hole) {
  if (busy || !inPlay() || game.drilled.includes(hole)) return;
  busy = true;
  lake?.setActive(false);
  paint();
  try {
    const response = await api.post(`/v1/ice-fishing/games/${game.id}/drill`, { hole, drilledCount: game.drilled.length });
    game = response.game;
    if (game.outcome === 'thin') {
      if (lake) await lake.drill(hole, null);
      else flatCrack(hole);
      lake?.reveal(game.thinHoles ?? [], hole);
      playSound('lose');
      settled();
      say(`Thin ice. You lost ${money(Number(game.stakeMinor))}.`);
    } else {
      const catchId = game.catches[game.catches.length - 1];
      if (lake) await lake.drill(hole, catchId);
      playSound('coin', { rate: 0.9 + game.drilled.length * 0.06 });
      if (game.status === 'settled') {
        settled();
      } else {
        say(`${catchName(catchId)}. ${game.drilled.length} caught. Pull out now for ${money(Number(game.cashoutMinor))}.`);
      }
    }
  } catch (error) {
    if (error?.code === 'STALE_ACTION' || error?.code === 'HOLE_TAKEN') await reload();
    else toast({ kind: 'lose', title: 'Ice Fishing', body: error?.message || 'That hole did not drill' });
  } finally {
    busy = false;
    if (game?.status === 'settled') void refreshBalance();
    paint();
    syncLake();
  }
}

async function cashOut() {
  if (busy || !inPlay() || game.drilled.length === 0) return;
  busy = true;
  paint();
  try {
    const response = await api.post(`/v1/ice-fishing/games/${game.id}/cashout`, { drilledCount: game.drilled.length });
    game = response.game;
    settled();
  } catch (error) {
    if (error?.code === 'STALE_ACTION') await reload();
    else toast({ kind: 'lose', title: 'Ice Fishing', body: error?.message || 'That did not go through' });
  } finally {
    busy = false;
    void refreshBalance();
    paint();
    syncLake();
  }
}

/** The game is over: tally it, show it, and let the lake show the rest of its thin ice. */
function settled() {
  const paid = BigInt(game.payoutMinor ?? '0');
  session.games += 1;
  session.won += paid;
  if (paid > session.best) session.best = paid;
  log.unshift(logEntry(game));
  log = log.slice(0, LOG_SIZE);
  if (game.outcome === 'cashout') {
    const bps = game.multiplierBps ?? 0;
    playSound(bps >= BIG_BPS ? 'jackpot' : 'win');
    lake?.celebrate(bps);
    splash(bps >= BIG_BPS ? 'Huge haul!' : `${times(bps)}!`, bps >= BIG_BPS ? 'big' : 'won');
    say(`Pulled out at ${times(bps)} for ${money(Number(paid))}.`);
  } else {
    splash('Thin ice!', 'lost');
  }
  showResult();
}

function randomHole() {
  if (!inPlay()) return;
  const open = [];
  for (let hole = 0; hole < HOLES; hole += 1) if (!game.drilled.includes(hole)) open.push(hole);
  // The page's own pick, not the game's: which hole the player drills changes nothing about the odds.
  if (open.length) void drill(open[Math.floor(Math.random() * open.length)]);
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintBoard();
  paintHud();
  paintControls();
  paintThin();
  paintGraphics();
  paintStats();
  paintLog();
}

/** The flat lake: a grid of ice blocks, drilled ones showing their catch, thin ice cracked. */
function paintBoard() {
  const grid = $('#icefishGrid', root);
  const thin = new Set(game?.status === 'settled' ? game.thinHoles ?? [] : []);
  const drilledAt = new Map((game?.drilled ?? []).map((hole, i) => [hole, game.catches[i]]));
  for (const button of grid.querySelectorAll('button')) {
    const hole = Number(button.dataset.hole);
    const catchId = drilledAt.get(hole);
    button.dataset.state = catchId ? 'fish' : game?.thinHit === hole ? 'broke' : thin.has(hole) ? 'thin' : 'closed';
    button.disabled = !inPlay() || busy || Boolean(catchId);
    const img = $('img', button);
    if (catchId) {
      img.src = icon(catchId);
      img.hidden = false;
    } else {
      img.hidden = true;
    }
    button.setAttribute('aria-label', catchId ? `Hole ${hole + 1}: ${catchName(catchId)}` : thin.has(hole) ? `Hole ${hole + 1}: thin ice` : `Drill hole ${hole + 1}`);
  }
}
function flatCrack(hole) {
  const button = $(`#icefishGrid button[data-hole="${hole}"]`, root);
  if (!button || reduceMotion()) return;
  button.animate([{ transform: 'scale(1)' }, { transform: 'scale(.86) rotate(-3deg)' }, { transform: 'scale(1)' }], { duration: 380 });
}

function paintHud() {
  const hud = $('#icefishHud', root);
  const drilled = game?.drilled.length ?? 0;
  let state = 'idle';
  let big = '×';
  let line = 'Start a lake, then drill: every fish raises the multiplier';
  if (inPlay()) {
    state = 'play';
    big = drilled ? times(game.multiplierBps) : '1.00×';
    line = game.nextMultiplierBps ? `Next fish ${times(game.nextMultiplierBps)} · ${pct(game.nextFishChanceBps)} chance` : 'Every fish is out';
  } else if (game?.outcome === 'cashout') {
    state = 'won';
    big = times(game.multiplierBps ?? 0);
    line = `Pulled out with ${drilled} fish`;
  } else if (game?.outcome === 'thin') {
    state = 'lost';
    big = 'Thin ice';
    line = drilled ? `Through the ice after ${drilled} fish` : 'Through the ice on the first hole';
  }
  hud.dataset.state = state;
  $('#icefishMult', hud).textContent = big;
  $('#icefishStatus', hud).textContent = line;
}

function paintControls() {
  const go = $('#icefishGo', root);
  const label = $('#icefishGoLabel', root);
  let text = `Start · ${money(Number(stakeMinor() ?? 0n))}`;
  let tone = 'go';
  if (!state.authenticated) text = 'Log in to play';
  else if (inPlay()) {
    tone = 'cash';
    text = game.drilled.length ? `Pull out · ${money(Number(game.cashoutMinor))}` : 'Pick a hole';
  } else if (busy) text = '…';
  if (label.textContent !== text) label.textContent = text;
  go.dataset.tone = tone;
  const problem = !inPlay() ? startProblem() : '';
  go.disabled = state.authenticated && (busy || (inPlay() ? game.drilled.length === 0 : Boolean(problem)));
  go.setAttribute('aria-busy', String(busy));
  $('#icefishRandom', root).disabled = !inPlay() || busy;
  $('#icefishHint', root).textContent = state.authenticated && !inPlay() ? problem : '';
  for (const node of root.querySelectorAll('.icefish__field input, .icefish__adj')) node.disabled = inPlay() || busy;
}

function paintThin() {
  const input = $('#icefishThin', root);
  if (Number(input.value) !== thinCount) input.value = String(thinCount);
  input.disabled = inPlay() || busy;
  for (const button of root.querySelectorAll('.icefish__quick')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.thin) === thinCount));
    button.disabled = inPlay() || busy;
  }
  // What the first and the fifth fish would pay at this much thin ice.
  const first = multiplierBps(thinCount, 1);
  const fifth = thinCount <= HOLES - 5 ? multiplierBps(thinCount, 5) : null;
  $('#icefishThinNote', root).textContent = `First fish ${times(first)}${fifth ? ` · five ${times(fifth)}` : ''} · ${pct(fishChanceBps(thinCount, 0))} safe`;
}

function paintGraphics() {
  const select = root && $('#icefishGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = lake?.tier;
  $('option[value="auto"]', select).textContent = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  select.disabled = inPlay() || busy;
}
function paintStats() {
  $('#icefishGames', root).textContent = session.games.toLocaleString('en-US');
  $('#icefishWon', root).textContent = money(Number(session.won));
  $('#icefishBest', root).textContent = session.best > 0n ? money(Number(session.best)) : '—';
}
function paintLog() {
  const list = $('#icefishLog', root);
  list.innerHTML = log.map((entry) => {
    const won = entry.outcome === 'cashout';
    return `<li class="icefish__logitem" data-won="${won ? '1' : '0'}" title="${won ? `Pulled out at ${times(entry.bps)}` : 'Thin ice'}">
      <img src="${icon(won && entry.catchId ? entry.catchId : 'snowball')}" alt="" /><span>${won ? times(entry.bps) : '—'}</span></li>`;
  }).join('');
  list.setAttribute('aria-label', log.length ? `Your last ${log.length} games` : 'No games yet');
  $('#icefishLogEmpty', root).hidden = log.length > 0;
  $('#icefishRecent', root).innerHTML = log.slice(0, 8).map((entry) => `<li data-won="${entry.outcome === 'cashout' ? '1' : '0'}">${entry.outcome === 'cashout' ? times(entry.bps) : '0.00×'}</li>`).join('');
}

function showResult() {
  const card = $('#icefishCatch', root);
  const paid = BigInt(game.payoutMinor ?? '0');
  const stake = BigInt(game.stakeMinor);
  const won = game.outcome === 'cashout';
  const last = game.catches[game.catches.length - 1];
  card.dataset.tone = won ? ((game.multiplierBps ?? 0) >= BIG_BPS ? 'big' : 'win') : 'none';
  $('img', card).src = icon(won && last ? last : 'snowball');
  $('.icefish__catchname', card).textContent = won ? `${game.drilled.length} fish · ${times(game.multiplierBps ?? 0)}` : 'Thin ice';
  $('.icefish__catchkind', card).textContent = won ? `Best catch: ${catchName(last)}` : `${game.thin} thin, ${game.drilled.length} fish first`;
  $('.icefish__catchpay', card).textContent = won ? `+${money(Number(paid - stake))} · ${money(Number(paid))}` : `−${money(Number(stake))}`;
  card.hidden = false;
}
function hideResult() {
  const card = root && $('#icefishCatch', root);
  if (card) card.hidden = true;
}
function splash(text, tone) {
  const node = $('#icefishSplash', root);
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = false;
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
  clearTimeout(splash.timer);
  splash.timer = setTimeout(() => { node.hidden = true; }, 1700);
}
function say(text) {
  const node = $('#icefishSay', root);
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── how it works ─────────── */

function paytableHtml() {
  if (!config) return '<p class="icepay__sub">The table loads with the lake.</p>';
  const rtp = ((10_000 - config.houseEdgeBps) / 100).toFixed(0);
  const counts = [1, 3, 5, 10, 20];
  const rows = [1, 2, 3, 5, 8, 12].map((fish) => `
      <tr><th scope="row">${fish} fish</th>${counts.map((thin) => `<td>${fish <= HOLES - thin ? `<b>${times(multiplierBps(thin, fish))}</b>` : '—'}</td>`).join('')}</tr>`).join('');
  const catches = config.catches.map((c) => `<span class="icepay__item"><img src="${icon(c.id)}" alt="" />${c.name} from ${times(c.fromBps)}</span>`).join(' ');
  return `
      <p class="icepay__sub">Twenty-five holes on a frozen lake; you choose how many of them are thin ice. Drill a hole: a fish raises the multiplier, thin ice loses the stake. Pull out after any fish for your stake times the multiplier.</p>
      <div class="icepay__scroll"><table class="icepay__table"><thead><tr><th scope="col">Pull out after</th>${counts.map((thin) => `<th scope="col">${thin} thin</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="icepay__sub">The more thin ice, the faster the multiplier climbs. What comes up is named by how far the game has got: ${catches}.</p>
      <p class="icepay__sub">It is Mines on the ice, with the same maths: whenever you pull out, the game returns ${rtp}% over the long run. The thin ice is laid from your fairness seed the moment you start, by the same shuffle as Mines, and revealed when the game ends; check any game on the Fairness page.</p>`;
}
function openPaytable() {
  openModal('Ice Fishing: how it works', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'icepay';
    wrap.innerHTML = paytableHtml();
    body.append(wrap);
  });
}

/* ─────────── building ─────────── */

function build() {
  const remembered = Number(globalThis.DonutPrefs?.get?.().icefishThin);
  if (Number.isInteger(remembered) && remembered >= 1 && remembered <= 24) thinCount = remembered;
  root.dataset.render = '2d';
  root.innerHTML = `
    <section class="icefish__stage" aria-label="The frozen lake">
      <div class="icefish__lake">
        <div class="icefish__flat">
          <div class="icefish__grid" id="icefishGrid" role="grid" aria-label="The holes">
            ${Array.from({ length: HOLES }, (_, hole) => `<button type="button" data-hole="${hole}" data-state="closed"><img alt="" hidden /></button>`).join('')}
          </div>
        </div>
        <div class="icefish__hud" id="icefishHud" data-state="idle">
          <p class="icefish__mult" id="icefishMult">×</p>
          <p class="icefish__status" id="icefishStatus"></p>
        </div>
        <ol class="icefish__recent" id="icefishRecent" aria-label="Recent games"></ol>
        <p class="icefish__splash" id="icefishSplash" aria-hidden="true" hidden></p>
        <div class="icefish__catch" id="icefishCatch" hidden>
          <span class="icefish__slot icefish__slot--big"><img src="" alt="" /></span>
          <span class="icefish__catchtxt"><b class="icefish__catchname"></b><span class="icefish__catchkind"></span><span class="icefish__catchpay"></span></span>
        </div>
      </div>
    </section>

    <aside class="icefish__panel" aria-label="Your game">
      <form class="icefish__form" id="icefishForm" novalidate>
        <label class="icefish__label" for="icefishStake">Stake</label>
        <div class="icefish__field">
          <span aria-hidden="true">$</span>
          <input id="icefishStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="icefish__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="icefish__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <label class="icefish__label" for="icefishThin">Thin ice</label>
        <div class="icefish__thin">
          <input id="icefishThin" type="number" min="1" max="24" step="1" inputmode="numeric" />
          ${QUICK_THIN.map((n) => `<button type="button" class="icefish__quick" data-thin="${n}" aria-pressed="false">${n}</button>`).join('')}
        </div>
        <p class="icefish__thinnote" id="icefishThinNote"></p>
        <button class="btn icefish__go" id="icefishGo" type="submit" data-tone="go"><span id="icefishGoLabel">Loading…</span></button>
        <div class="icefish__toggles">
          <button class="icefish__toggle" id="icefishRandom" type="button">Random hole</button>
          <button class="icefish__paytable" id="icefishPaytable" type="button">How it works</button>
        </div>
        <p class="icefish__hint" id="icefishHint" aria-live="polite"></p>
        <dl class="icefish__stats">
          <div><dt>Games</dt><dd id="icefishGames"></dd></div>
          <div><dt>Won</dt><dd id="icefishWon"></dd></div>
          <div><dt>Best</dt><dd id="icefishBest"></dd></div>
        </dl>
        <span class="icefish__label">Last games</span>
        <ol class="icefish__log" id="icefishLog"></ol>
        <p class="icefish__logempty" id="icefishLogEmpty">No games yet.</p>
        <label class="icefish__gfx" for="icefishGfx">
          <span>Graphics</span>
          <select id="icefishGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="icefish__say" id="icefishSay" role="status" aria-atomic="true"></div>`;

  const stake = $('#icefishStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.icefish__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paint();
  }));
  const setThin = (n) => {
    if (inPlay() || busy || !Number.isInteger(n) || n < 1 || n > 24) return;
    thinCount = n;
    globalThis.DonutPrefs?.update?.({ icefishThin: n === 3 ? undefined : n });
    paint();
  };
  $('#icefishThin', root).addEventListener('change', (event) => setThin(Math.round(Number(event.target.value))));
  root.querySelectorAll('.icefish__quick').forEach((button) => button.addEventListener('click', () => {
    playSound('click');
    setThin(Number(button.dataset.thin));
  }));
  $('#icefishGrid', root).addEventListener('click', (event) => {
    const button = event.target.closest('button[data-hole]');
    if (button) void drill(Number(button.dataset.hole));
  });
  $('#icefishRandom', root).addEventListener('click', randomHole);
  $('#icefishGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  $('#icefishForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    if (inPlay()) void cashOut();
    else void start();
  });
  $('#icefishPaytable', root).addEventListener('click', openPaytable);
  /* Space starts, or pulls out; R drills a random hole. Only on this page, never while typing. */
  document.addEventListener('keydown', (event) => {
    if (!view || view.hidden || event.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (inPlay()) void cashOut();
      else void start();
    } else if (event.key === 'r' || event.key === 'R') {
      randomHole();
    }
  });
}

export function mountIceFishing(section) {
  view = section;
  root = $('#icefishRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (!busy) void load();
        return;
      }
      if (event.detail === 'logout') {
        seedHash = null;
        game = null;
        log = [];
      }
      if (!busy) paint();
    });
  }
  void load();
}
