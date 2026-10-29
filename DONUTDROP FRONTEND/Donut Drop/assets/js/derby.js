/* derby.js — Mob Derby: six of the game's farm mobs race down a dirt-path track; back one. Each pays
 * fixed odds, 90% over its chance: the pig wins often and pays 2.88x, the black sheep rarely and pays
 * 19.2x.
 *
 * The server owns every race (lib/derby.ts, routes/derby.ts): one request stakes, draws the winner
 * from the player's committed fairness seed, and pays a winning pick. It hands back a track seed too,
 * from which derbyrace.js works out how the field runs; the page counts down, lifts the gate, and
 * runs the race the server has already decided.
 *
 * The wallet pill does not run ahead of the race: the live figures are held from the click until the
 * field is home.
 *
 * The track is drawn in WebGL (derby3d.js), its own chunk, at the graphics the player picked or the
 * machine can manage; without WebGL the flat lanes run the same race. The order and the result are in
 * the page as text too.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { openModal, toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { onNavigate } from './routing.js';
import { graphicsPref, setGraphicsPref } from './quality3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, setWants3d, viewSwitch, wants3d } from './view3d.js';
import { faceIcons, raceScript } from './derbyrace.js';

const GRAPHICS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/* The countdown before the gate lifts. */
const COUNTDOWN_MS = 1800;
const LOG_SIZE = 12;
const BIG = 10;

/* One formatter, made once: building it again for every figure of every frame was a measurable cost. */
const TWO_PLACES = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const times = (x100) => `${TWO_PLACES.format(x100 / 100)}×`;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduceMotion() ? 0 : ms); });

let root = null;
let view = null;
let config = null;
let seedHash = null;
let stakeText = '1m';
let pick = 'pig';
let phase = 'idle'; // idle | racing
let auto = false;
let session = { races: 0, won: 0n, best: 0n };
let log = []; // newest first: { winner, pick, x100 }
let nextTimer = 0;
let faces = {};
let track = null; // the 3D track, once it is up
let trackTried = null;
let hudFrame = 0;

/* ─────────── numbers ─────────── */

function stakeMinor() {
  const value = parseAmount(stakeText);
  return value === null ? null : BigInt(value);
}
const racers = () => config?.racers ?? [];
const racerOf = (id) => racers().find((r) => r.id === id);
const laneOf = (id) => racers().findIndex((r) => r.id === id);
function maxStake() {
  const racer = racerOf(pick);
  if (!config || !racer) return 0n;
  const ceiling = BigInt(racer.maxStakeMinor);
  const max = BigInt(config.maxStakeMinor);
  return ceiling < max ? ceiling : max;
}
function raceProblem() {
  if (!config) return 'Mob Derby is not answering';
  if (!config.enabled) return 'Mob Derby is closed right now';
  const stake = stakeMinor();
  if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
  if (stake < BigInt(config.minStakeMinor)) return `The smallest bet is ${money(Number(config.minStakeMinor))}`;
  if (stake > maxStake()) return `The largest bet on the ${racerOf(pick)?.name ?? 'racer'} is ${money(Number(maxStake()))}`;
  if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
  return '';
}

/* ─────────── talking to the server ─────────── */

async function load() {
  try {
    config = await api.get('/v1/derby/config');
  } catch {
    config = null;
  }
  if (config) {
    if (!racerOf(pick)) pick = racers()[0]?.id ?? 'pig';
    faces = await faceIcons(racers().map((r) => r.id)).catch(() => ({}));
    buildPicker();
    buildLanes();
  }
  if (state.authenticated) {
    await refreshSeed();
    await loadLog();
  }
  paint();
  if (config) await startTrack();
}
async function loadLog() {
  try {
    const { races } = await api.get(`/v1/derby/races?limit=${LOG_SIZE}`);
    if (phase === 'idle') log = races.map(logEntry);
  } catch {
    /* the log is a nicety */
  }
}
const logEntry = (race) => ({ winner: race.winner, pick: race.pick, x100: race.multiplierX100 });
async function refreshSeed() {
  try {
    seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
  } catch {
    seedHash = null;
  }
}
async function send(stake) {
  if (!seedHash) await refreshSeed();
  const body = () => ({ stakeMinor: stake.toString(), pick, clientSeed: clientSeed(), serverSeedHash: seedHash });
  try {
    return await api.post('/v1/derby/races', body(), { idempotencyKey: idempotencyKey() });
  } catch (error) {
    if (error?.code !== 'FAIRNESS_COMMITMENT_CHANGED') throw error;
    await refreshSeed();
    return api.post('/v1/derby/races', body(), { idempotencyKey: idempotencyKey() });
  }
}

/* ─────────── the track ─────────── */

/** Builds the 3D track over the flat lanes, once, as its own download. Any failure leaves the lanes. */
function startTrack() {
  if (trackTried || !wants3d()) return trackTried;
  trackTried = (async () => {
    const host = $('.derby__track', root);
    try {
      const { createDerby3d } = await import('./derby3d.js');
      const built = await createDerby3d(host, { racers: racers() });
      if (!built) root.dataset.no3d = '';
      else if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        trackTried = null;
        return;
      }
      if (!built) return;
      built.onLost = () => {
        if (track === built) track = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.onCue = (cue) => {
        if (cue === 'go') playSound('boost');
        else if (cue === 'finish') playSound('chime');
        else if (cue === 'firework') playSound('shatter', { rate: 1.5 });
      };
      built.setPick(laneOf(pick));
      track = built;
      root.dataset.render = '3d';
      paintGraphics();
    } catch {
      root.dataset.render = '2d';
    }
  })();
  return trackTried;
}
function setGraphics(value) {
  if (phase !== 'idle' || !GRAPHICS.some(([id]) => id === value) || value === graphicsPref()) return;
  setGraphicsPref(value);
  playSound('click');
  if (track) {
    track.dispose();
    track = null;
    trackTried = null;
    root.dataset.render = '2d';
    if (config) void startTrack();
  }
  paintGraphics();
}

/** The 2D/3D switch (view3d.js): 2D puts the track away for the flat board, 3D builds it again. */
function setView(on) {
  if (phase !== 'idle') {
    // Switched somewhere else in the middle of a round: followed once the round lets go.
    if (on === wants3d()) setTimeout(() => setView(wants3d()), 600);
    paintGraphics();
    return;
  }
  if (on !== wants3d()) {
    setWants3d(on);
    playSound('click');
  }
  if (!on && track) {
    track.dispose();
    track = null;
    trackTried = null;
    root.dataset.render = '2d';
  }
  if (on && config) void startTrack();
  paintGraphics();
}

/** The flat lanes: each racer's face, moved along its lane by the same race. */
function buildLanes() {
  const lanes = $('#derbyLanes', root);
  if (!lanes || lanes.dataset.built === '1') return;
  lanes.dataset.built = '1';
  lanes.innerHTML = racers().map((r) => `<li data-id="${r.id}"><img src="${faces[r.id] ?? ''}" alt="" /></li>`).join('');
}
function placeLanes(script, ms) {
  // Only the flat lanes need moving; under the 3D track they are hidden, and moving them costs a style pass.
  if (root.dataset.render === '3d' && script) return;
  for (const item of root.querySelectorAll('#derbyLanes li')) {
    const lane = laneOf(item.dataset.id);
    const p = script ? Math.min(1, script.progress(lane, ms)) : 0;
    item.style.setProperty('--at', String(p));
  }
}

/** The order list: one row per racer, built once, reordered as the field changes places. */
function orderRows() {
  const list = $('#derbyOrder', root);
  if (list.dataset.built !== '1' || list.children.length !== racers().length) {
    list.dataset.built = '1';
    list.innerHTML = racers().map((r) => `<li data-id="${r.id}" data-mine="0"><b></b><img src="${faces[r.id] ?? ''}" alt="" /><span>${r.name}</span></li>`).join('');
  }
  return list;
}
function paintOrder(order) {
  const list = orderRows();
  order.forEach((lane, i) => {
    const r = racers()[lane];
    const row = list.querySelector(`li[data-id="${r.id}"]`);
    const place = String(i + 1);
    if (row.style.order !== place) row.style.order = place;
    if (row.firstElementChild.textContent !== place) row.firstElementChild.textContent = place;
    const mine = r.id === pick ? '1' : '0';
    if (row.dataset.mine !== mine) row.dataset.mine = mine;
  });
}

/* ─────────── a race ─────────── */

async function race() {
  clearTimeout(nextTimer);
  if (!state.authenticated) {
    stopAuto();
    $('#loginBtn')?.click();
    return;
  }
  if (phase !== 'idle') return;
  if (raceProblem()) {
    stopAuto();
    paint();
    return;
  }
  phase = 'racing';
  const stake = stakeMinor();
  const release = holdLiveFigures();
  hideResult();
  playSound('click');
  track?.reset();
  placeLanes(null, 0);
  paintHud('waiting');
  paint();
  try {
    const response = await send(stake);
    seedHash = response.nextServerSeedHash || null;
    const result = response.race;
    const winner = laneOf(result.winner);
    const script = raceScript(result.trackSeed, winner, racers().length);
    // The countdown, then the gate.
    const countdown = reduceMotion() ? 0 : COUNTDOWN_MS;
    const finished = track ? track.race(script, winner, countdown) : null;
    const startAt = track ? track.startAt : performance.now() + countdown;
    for (const n of countdown ? [3, 2, 1] : []) {
      paintHud('countdown', String(n));
      playSound('click', { rate: n === 1 ? 1.4 : 1 });
      await wait(countdown / 3);
    }
    if (!track) playSound('boost');
    runHud(script, startAt);
    if (finished) await finished;
    else await wait(script.duration + 400);
    cancelAnimationFrame(hudFrame);
    placeLanes(script, script.duration + 400);
    present(result, stake, script);
    showBalance(response.balanceMinor);
    release();
  } catch (error) {
    stopAuto();
    release();
    cancelAnimationFrame(hudFrame);
    if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
    toast({ kind: 'lose', title: 'Mob Derby', body: error?.message || 'That bet did not go through' });
    track?.reset();
    paintHud('idle');
  }
  phase = 'idle';
  void refreshBalance();
  paint();
  scheduleNext();
}

/** The order as the race runs, leader first, and the flat lanes with it. */
function runHud(script, startAt) {
  paintHud('running');
  let paintedAt = 0;
  const tick = () => {
    const now = performance.now();
    const ms = now - startAt;
    placeLanes(script, ms);
    // The order ten times a second is plenty to follow, and costs nothing between.
    if (now - paintedAt >= 100) {
      paintedAt = now;
      paintOrder(script.order(Math.max(0, ms)));
    }
    hudFrame = requestAnimationFrame(tick);
  };
  tick();
}

function present(result, stake, script) {
  const paid = BigInt(result.payoutMinor);
  const won = paid > 0n;
  const winner = racerOf(result.winner);
  session.races += 1;
  session.won += paid;
  if (paid > session.best) session.best = paid;
  log.unshift(logEntry(result));
  log = log.slice(0, LOG_SIZE);
  // The final order, as the field crossed the line.
  paintOrder(script.order(script.duration + 400));
  paintHud(won ? 'won' : 'lost', `${winner?.name ?? result.winner} wins!`);
  showResult(result, stake);
  track?.celebrate(result.multiplierX100);
  splash(won ? `${times(result.multiplierX100)}!` : `${winner?.name ?? ''} wins`, won ? (result.multiplierX100 >= BIG * 100 ? 'big' : 'won') : 'lost');
  playSound(won ? (result.multiplierX100 >= BIG * 100 ? 'jackpot' : 'win') : 'lose');
  say(`${winner?.name ?? result.winner} won the race. ${won ? `Your bet pays ${times(result.multiplierX100)}, ${money(Number(paid))}.` : `Your ${racerOf(result.pick)?.name ?? ''} lost.`}`);
  paintStats();
  paintLog();
}

function scheduleNext() {
  clearTimeout(nextTimer);
  if (!auto) return;
  if (!view || view.hidden || raceProblem()) {
    stopAuto();
    return;
  }
  nextTimer = setTimeout(() => {
    if (!view || view.hidden) {
      stopAuto();
      return;
    }
    void race();
  }, 2200);
}
function stopAuto() {
  clearTimeout(nextTimer);
  if (!auto) return;
  auto = false;
  paintControls();
}

function setPick(id) {
  if (phase !== 'idle' || !racerOf(id) || id === pick) return;
  pick = id;
  globalThis.DonutPrefs?.update?.({ derbyPick: id === 'pig' ? undefined : id });
  track?.setPick(laneOf(id));
  playSound('click');
  paintHud('idle');
  paint();
}

/* ─────────── painting ─────────── */

function paint() {
  if (!root) return;
  paintControls();
  paintPicker();
  paintGraphics();
  paintStats();
  paintLog();
  if (phase === 'idle' && $('#derbyHud', root).dataset.state === 'idle') paintHud('idle');
}

function paintControls() {
  const go = $('#derbyGo', root);
  const label = $('#derbyGoLabel', root);
  const problem = phase === 'idle' ? raceProblem() : '';
  let text = `Race · ${money(Number(stakeMinor() ?? 0n))} on the ${racerOf(pick)?.name ?? '…'}`;
  if (!state.authenticated) text = 'Log in to play';
  else if (phase === 'racing') text = 'They’re off…';
  if (label.textContent !== text) label.textContent = text;
  go.disabled = state.authenticated && (phase !== 'idle' || Boolean(problem));
  go.setAttribute('aria-busy', String(phase !== 'idle'));
  const autoButton = $('#derbyAuto', root);
  autoButton.setAttribute('aria-pressed', String(auto));
  autoButton.textContent = auto ? 'Stop auto' : 'Auto race';
  autoButton.disabled = !state.authenticated;
  $('#derbyHint', root).textContent = state.authenticated && phase === 'idle' ? problem : '';
  for (const node of root.querySelectorAll('.derby__field input, .derby__adj')) node.disabled = phase !== 'idle';
}

function buildPicker() {
  const group = $('.derby__picks', root);
  if (!group || group.dataset.built === '1') return;
  group.dataset.built = '1';
  group.innerHTML = racers().map((r) => `
    <button class="derby__pick" type="button" role="radio" data-id="${r.id}" aria-checked="false">
      <img src="${faces[r.id] ?? ''}" alt="" />
      <b>${r.name}</b>
      <span class="derby__odds">${times(r.oddsX100)}</span>
      <span class="derby__chance">${((r.weight / config.span) * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%</span>
    </button>`).join('');
}
function paintPicker() {
  for (const button of root.querySelectorAll('.derby__pick')) {
    const on = button.dataset.id === pick;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    button.disabled = phase !== 'idle';
  }
}
function paintGraphics() {
  if (root) paintViewSwitch(root, $('#derbyView', root), { disabled: Boolean(phase !== 'idle') });
  const select = root && $('#derbyGfx', root);
  if (!select) return;
  const pref = graphicsPref();
  if (select.value !== pref) select.value = pref;
  const chosen = track?.tier;
  $('option[value="auto"]', select).textContent = chosen ? `Auto · ${chosen[0].toUpperCase()}${chosen.slice(1)}` : 'Auto';
  select.disabled = phase !== 'idle';
}
function paintStats() {
  $('#derbyRaces', root).textContent = session.races.toLocaleString('en-US');
  $('#derbyWon', root).textContent = money(Number(session.won));
  $('#derbyBest', root).textContent = session.best > 0n ? money(Number(session.best)) : '—';
}
function paintLog() {
  const list = $('#derbyLog', root);
  list.innerHTML = log.map((entry) => `<li class="derby__logitem" data-won="${entry.x100 > 0 ? '1' : '0'}" title="${racerOf(entry.winner)?.name ?? entry.winner} won · you backed the ${racerOf(entry.pick)?.name ?? entry.pick}">
      <img src="${faces[entry.winner] ?? ''}" alt="" /><span>${entry.x100 > 0 ? times(entry.x100) : '—'}</span></li>`).join('');
  list.setAttribute('aria-label', log.length ? `Your last ${log.length} races` : 'No races yet');
  $('#derbyLogEmpty', root).hidden = log.length > 0;
}

/** The headline over the track: the pick, the countdown, the race, the result. */
function paintHud(status, text) {
  const hud = $('#derbyHud', root);
  hud.dataset.state = status;
  const racer = racerOf(pick);
  let big = racer ? `${racer.name} · ${times(racer.oddsX100)}` : '';
  let line = 'Back a racer, then race';
  if (status === 'waiting') line = 'Into the gate…';
  else if (status === 'countdown') { big = text; line = 'Get ready…'; }
  else if (status === 'running') line = `You backed the ${racer?.name ?? ''}`;
  else if (status === 'won' || status === 'lost') { big = text; line = status === 'won' ? 'Your racer won!' : `You backed the ${racer?.name ?? ''}`; }
  $('#derbyBig', hud).textContent = big;
  $('#derbyStatus', hud).textContent = line;
  $('#derbyOrder', root).hidden = !['running', 'won', 'lost'].includes(status);
}

function showResult(result, stake) {
  const card = $('#derbyResult', root);
  const paid = BigInt(result.payoutMinor);
  card.dataset.tone = paid > 0n ? (result.multiplierX100 >= BIG * 100 ? 'big' : 'win') : 'none';
  $('img', card).src = faces[result.winner] ?? '';
  $('.derby__resultname', card).textContent = `${racerOf(result.winner)?.name ?? result.winner} wins`;
  $('.derby__resultkind', card).textContent = `You backed the ${racerOf(result.pick)?.name ?? result.pick}`;
  $('.derby__resultpay', card).textContent = paid > 0n ? `+${money(Number(paid - stake))} · ${money(Number(paid))}` : `−${money(Number(stake))}`;
  card.hidden = false;
}
function hideResult() {
  const card = root && $('#derbyResult', root);
  if (card) card.hidden = true;
}
function splash(text, tone) {
  const node = $('#derbySplash', root);
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
  const node = $('#derbySay', root);
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}

/* ─────────── how it works ─────────── */

function paytableHtml() {
  if (!config) return '<p class="derbypay__sub">The field loads with the track.</p>';
  const rtp = ((10_000 - config.houseEdgeBps) / 100).toFixed(0);
  const rows = racers().map((r) => `
      <tr><th scope="row"><span class="derbypay__item"><img src="${faces[r.id] ?? ''}" alt="" />${r.name}</span></th>
      <td>${r.weight} of ${config.span} · ${((r.weight / config.span) * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%</td>
      <td><b>${times(r.oddsX100)}</b></td></tr>`).join('');
  return `
      <p class="derbypay__sub">Six farm mobs race down the track. Back one; if it crosses the line first your bet pays its odds, times your stake. The odds are fixed: the favourite wins most often and pays least.</p>
      <div class="derbypay__scroll"><table class="derbypay__table"><thead><tr><th scope="col">Racer</th><th scope="col">Wins</th><th scope="col">Pays</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="derbypay__sub">Every racer pays ${rtp}% over its chance, so every bet returns ${rtp}% over the long run whichever you back. The winner is the first byte of your race's fairness hash (0 to 255, the racers' shares laid end to end down the table); the next sixteen bytes only say how the field runs on the way. The seed is revealed with the race; check any race on the Fairness page.</p>`;
}
function openPaytable() {
  openModal('Mob Derby: how it works', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'derbypay';
    wrap.innerHTML = paytableHtml();
    body.append(wrap);
  });
}

/* ─────────── building ─────────── */

function build() {
  const remembered = globalThis.DonutPrefs?.get?.().derbyPick;
  if (typeof remembered === 'string') pick = remembered;
  root.dataset.render = '2d';
  root.innerHTML = `
    <section class="derby__stage" aria-label="The track">
      <div class="derby__track">
        <ol class="derby__lanes" id="derbyLanes" aria-hidden="true"></ol>
        <div class="derby__hud" id="derbyHud" data-state="idle">
          <p class="derby__big" id="derbyBig"></p>
          <p class="derby__status" id="derbyStatus">Back a racer, then race</p>
        </div>
        <ol class="derby__order" id="derbyOrder" aria-label="The order" hidden></ol>
        <p class="derby__splash" id="derbySplash" aria-hidden="true" hidden></p>
        <div class="derby__result" id="derbyResult" hidden>
          <span class="derby__slot"><img src="" alt="" /></span>
          <span class="derby__resulttxt"><b class="derby__resultname"></b><span class="derby__resultkind"></span><span class="derby__resultpay"></span></span>
        </div>
      </div>
    </section>

    <aside class="derby__panel" aria-label="Your bet">
      <form class="derby__form" id="derbyForm" novalidate>
        <label class="derby__label" for="derbyStake">Stake</label>
        <div class="derby__field">
          <span aria-hidden="true">$</span>
          <input id="derbyStake" inputmode="decimal" autocomplete="off" spellcheck="false" />
          <button type="button" class="derby__adj" data-adj="half" aria-label="Halve the stake">½</button>
          <button type="button" class="derby__adj" data-adj="double" aria-label="Double the stake">2×</button>
        </div>
        <span class="derby__label" id="derbyPickLabel">Back a racer</span>
        <div class="derby__picks" role="radiogroup" aria-labelledby="derbyPickLabel"></div>
        <button class="btn derby__go" id="derbyGo" type="submit"><span id="derbyGoLabel">Loading…</span></button>
        <div class="derby__toggles">
          <button class="derby__toggle" id="derbyAuto" type="button" aria-pressed="false">Auto race</button>
          <button class="derby__paytable" id="derbyPaytable" type="button">How it works</button>
        </div>
        <p class="derby__hint" id="derbyHint" aria-live="polite"></p>
        <dl class="derby__stats">
          <div><dt>Races</dt><dd id="derbyRaces"></dd></div>
          <div><dt>Won</dt><dd id="derbyWon"></dd></div>
          <div><dt>Best</dt><dd id="derbyBest"></dd></div>
        </dl>
        <span class="derby__label">Last races</span>
        <ol class="derby__log" id="derbyLog"></ol>
        <p class="derby__logempty" id="derbyLogEmpty">No races yet.</p>
        ${viewSwitch('derbyView')}
        <label class="derby__gfx" for="derbyGfx">
          <span>Graphics</span>
          <select id="derbyGfx">${GRAPHICS.map(([id, text]) => `<option value="${id}">${text}</option>`).join('')}</select>
        </label>
      </form>
    </aside>
    <div class="derby__say" id="derbySay" role="status" aria-atomic="true"></div>`;

  const stake = $('#derbyStake', root);
  stake.value = stakeText;
  stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
  root.querySelectorAll('.derby__adj').forEach((button) => button.addEventListener('click', () => {
    const current = stakeMinor() ?? 0n;
    stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
    stake.value = stakeText;
    paint();
  }));
  const group = $('.derby__picks', root);
  group.addEventListener('click', (event) => {
    const button = event.target.closest('.derby__pick');
    if (button) setPick(button.dataset.id);
  });
  group.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || phase !== 'idle' || !racers().length) return;
    event.preventDefault();
    const index = laneOf(pick);
    const next = racers()[(index + step + racers().length) % racers().length].id;
    setPick(next);
    $(`.derby__pick[data-id="${next}"]`, root)?.focus();
  });
  $('#derbyGfx', root).addEventListener('change', (event) => setGraphics(event.target.value));
  onViewSwitch($('#derbyView', root), setView);
  // The same choice made anywhere else (the top bar, the settings page) applies here too: 2D at
  // once, 3D only for the page on screen (the others build theirs when they are next opened).
  onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });
  $('#derbyForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void race();
  });
  $('#derbyAuto', root).addEventListener('click', () => {
    auto = !auto;
    paintControls();
    if (auto && phase === 'idle') void race();
    else if (!auto) clearTimeout(nextTimer);
  });
  $('#derbyPaytable', root).addEventListener('click', openPaytable);
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || !view || view.hidden || event.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) return;
    event.preventDefault();
    void race();
  });
  onNavigate(() => {
    if (view?.hidden) stopAuto();
  });
}

export function mountDerby(section) {
  view = section;
  root = $('#derbyRoot', section);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', (event) => {
      if (['ready', 'login'].includes(event.detail)) {
        if (phase === 'idle') void load();
        return;
      }
      if (event.detail === 'logout') {
        stopAuto();
        seedHash = null;
        log = [];
      }
      if (phase === 'idle') paint();
    });
  }
  void load();
}
