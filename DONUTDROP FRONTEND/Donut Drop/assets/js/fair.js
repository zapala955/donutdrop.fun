/* fair.js — the Provably Fair page (/fairness).
 *
 * The owner, 2026-11-14: "rewrite https://donutluxe.com/fairness and also it shows upgrader bets only
 * for some reason". It did: the round list asked the upgrader's own history. It now lists every
 * seeded game (GET /v1/fairness/rounds), and checks a round in the player's own browser
 * (fair-replay.js): the revealed seed against the hash given before the bet, the exact HMAC the game
 * drew from, and, for the single-draw games, the result itself. Nothing in a check asks the server.
 *
 * Built in the site's flat obsidian, as the statistics and invite pages are (luxe-games.css, "the
 * Provably Fair page"): what it is, your next bet's lock, your rounds, a check by hand, how each game
 * uses the seed, and the shared chart's epochs.
 */
import { api } from './api.js';
import { bus, refreshFairness, state } from './store.js';
import { $, money } from './util.js';
import {
  coinflipSide, crashPointX100, diceRoll, hmacHex, limboResultX100, roulettePocket, rollPpm, sha256Hex,
} from './fair-replay.js';

let root = null;
let rounds = [];
let next = null;
let game = '';
let games = [];
let loading = false;

const GAME_ART = {
  cases: 'game-crates.svg',
  chicken: 'chicken.svg',
  dice: 'dice.svg',
  slots: 'game-ore-rush.svg',
};
const KNOWN_ART = new Set([
  'crash', 'mines', 'tower', 'plinko', 'limbo', 'blackjack', 'roulette', 'upgrader', 'coinflip', 'stocks',
  'mines-duel', 'battles', 'derby', 'fishing', 'ice-fishing', 'monument', 'ore-rush',
]);
const artFor = (key) => `assets/img/items/${GAME_ART[key] ?? (KNOWN_ART.has(key) ? `game-${key}.svg` : 'chest.png')}`;

const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const short = (hex) => (hex && hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex ?? '');
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const two = (hundredths) => (hundredths / 100).toFixed(2);

/* How each game turns the draw into its result. Every line is the game's own code
 * (services/api-gateway/src/lib), in words. */
const RECIPES = [
  ['Dice', '"client:nonce"', 'The first 52 bits of the digest as a fraction f. The roll is floor(f × 10,000), shown as 0.00–99.99.'],
  ['Limbo', '"client:nonce"', 'The same 52 bits, n. The result is 90 × 2^52 ÷ (2^52 − n), in hundredths: 0.90x up, capped at 1,000,000x.'],
  ['Upgrader', '"client:nonce"', 'The roll is floor(f × 1,000,000). You win when it is under your chance, in parts per million.'],
  ['Cases', '"client:nonce"', 'The same roll, floor(f × 1,000,000), picks the item whose share of the drop table it falls in.'],
  ['Crash', '"round id:0"', 'One draw for the whole round: (10,000 − edge) × 2^52 ÷ (100 × (2^52 − h)), from 1.00x to 1,000x.'],
  ['Roulette', '"round id:0"', 'One draw for the whole round: the pocket is floor(f × 37).'],
  ['Plinko', '"client:nonce"', 'One bit of the digest per row, from the first: 1 bounces right, 0 left. The slot is how many went right.'],
  ['Mines · Ice Fishing', '"client:nonce:i"', 'One draw per mine, or per thin hole, placed among the tiles still free.'],
  ['Tower', '"client:nonce:floor:i"', 'One draw per trap on each floor.'],
  ['Chicken', '"client:nonce:lane"', 'One draw per lane decides whether a minecart comes.'],
  ['Blackjack', '"client:nonce:position"', 'One draw per card position shuffles the deck.'],
  ['Slots', '"client:nonce:spin:reel"', 'One draw per reel of every spin, free spins included.'],
  ['Fishing', '"client:nonce"', 'The first 52 bits decide where the line snaps.'],
  ['Mob Derby', '"client:nonce"', 'The first byte picks the winner by the racers\' weights; the next 16 bytes lay out the track.'],
  ['Coinflip', '"coinflip:host:opponent"', 'Both players\' client seeds. Heads when the first byte of the digest is below 128.'],
  ['Mines Duel', '"minesduel:host:opponent:i"', 'Both players\' client seeds, one draw per mine.'],
  ['Case Battles', 'every player\'s seed', 'The battle\'s server seed with every seat\'s client seed and the battle\'s nonce.'],
  ['Stocks', '"epoch:tick"', 'A shared chart: each tick\'s moves come from its epoch\'s seed. The epochs are listed at the bottom of this page.'],
];

/* A round's recipe, by its game key; any slot machine reads as Slots. */
const RECIPE_OF = {
  mines: 'Mines · Ice Fishing', 'ice-fishing': 'Mines · Ice Fishing', tower: 'Tower', chicken: 'Chicken',
  blackjack: 'Blackjack', plinko: 'Plinko', fishing: 'Fishing', derby: 'Mob Derby', 'mines-duel': 'Mines Duel',
  battles: 'Case Battles', cases: 'Cases', dice: 'Dice', limbo: 'Limbo', upgrader: 'Upgrader', crash: 'Crash',
  roulette: 'Roulette', coinflip: 'Coinflip', stocks: 'Stocks',
};
const recipeFor = (key) => RECIPES.find(([name]) => name === (RECIPE_OF[key] ?? 'Slots'));

export function mountFair(view) {
  root = $('#fairRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    build();
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      paintCommitment();
      if (['ready', 'login', 'logout'].includes(event.detail)) void loadRounds(true);
    });
    /* Back from another tab, which may have played and spent the lock shown here. */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && root.isConnected) reloadCommitment();
    });
  }
  paintCommitment();
  reloadCommitment();
  void loadRounds(true);
  void loadEpochs();
}

/* Read from the server each time the page opens, never trusted from memory: a hash kept since
 * login was what made a reveal look like it did not match (2026-11-07). */
function reloadCommitment() {
  if (!state.authenticated) return;
  refreshFairness().catch(() => { /* the last one known stays on screen */ });
}

/* ─────────── building ─────────── */

function build() {
  root.innerHTML = `
    <section class="fp__hero">
      <div class="fp__intro">
        <span class="fp__slot fp__slot--big"><img src="assets/img/items/ender_eye.png" alt="" width="48" height="48"></span>
        <div class="fp__introcopy">
          <h2 class="fp__title">Every result is locked in before you bet</h2>
          <p class="fp__line">Each round is drawn from a secret server seed that is fixed, and shown to you as a hash, before you play. After the round the seed is revealed, and anyone can check it.</p>
        </div>
      </div>
      <ol class="fp__steps">
        <li class="fp__step"><b>1 · Locked</b><span>Before you bet you are given the SHA-256 hash of the server seed. Changing the seed would change the hash.</span></li>
        <li class="fp__step"><b>2 · Drawn</b><span>Your result is HMAC-SHA256 of your client seed and the bet's number (the nonce), keyed with that server seed.</span></li>
        <li class="fp__step"><b>3 · Revealed</b><span>After the round the seed is shown. Hash it: it must be the hash you were given. This page does it in your browser.</span></li>
      </ol>
    </section>

    <section class="fp__panel fp__lock" id="fpLock" aria-live="polite"></section>

    <section class="fp__panel" aria-labelledby="fpRoundsH">
      <header class="fp__head">
        <h2 class="fp__h" id="fpRoundsH">Your rounds</h2>
        <span class="fp__note">Check any one in your browser</span>
      </header>
      <div class="fp__filters" id="fpFilters" role="group" aria-label="Game"></div>
      <div class="fp__rounds" id="fpRounds"></div>
      <div class="fp__more"><button class="fp__btn" id="fpMore" type="button" hidden>Load more</button></div>
    </section>

    <section class="fp__panel" aria-labelledby="fpManualH">
      <header class="fp__head">
        <h2 class="fp__h" id="fpManualH">Check a round by hand</h2>
        <span class="fp__note">Any seed, from any round</span>
      </header>
      <form class="fp__form" id="fpForm" novalidate>
        <label class="fp__field fp__field--wide"><span>Server seed (revealed)</span>
          <input class="mono" id="fpSeed" placeholder="64 hex characters" autocomplete="off" spellcheck="false"></label>
        <label class="fp__field fp__field--wide"><span>Hash you were given (optional)</span>
          <input class="mono" id="fpHash" placeholder="64 hex characters" autocomplete="off" spellcheck="false"></label>
        <label class="fp__field fp__field--wide"><span>Message the game hashed</span>
          <input class="mono" id="fpMessage" placeholder="client seed:nonce" autocomplete="off" spellcheck="false"></label>
        <label class="fp__field"><span>Read it as</span>
          <select id="fpAs">
            <option value="">The digest only</option>
            <option value="dice">Dice roll</option>
            <option value="limbo">Limbo result</option>
            <option value="roll">Upgrader / Cases roll</option>
            <option value="roulette">Roulette pocket</option>
            <option value="crash">Crash point (10% edge)</option>
            <option value="coinflip">Coinflip side</option>
          </select></label>
        <button class="fp__btn fp__btn--go" type="submit">Check</button>
      </form>
      <div class="fp__checks" id="fpManualOut" hidden></div>
    </section>

    <section class="fp__panel" aria-labelledby="fpRecipesH">
      <header class="fp__head">
        <h2 class="fp__h" id="fpRecipesH">How each game uses the seed</h2>
        <span class="fp__note">HMAC-SHA256(server seed, message)</span>
      </header>
      <div class="fp__recipes">
        ${RECIPES.map(([name, message, how]) => `
          <div class="fp__recipe">
            <b class="fp__rname">${escapeText(name)}</b>
            <code class="fp__rmsg mono">${escapeText(message)}</code>
            <p class="fp__rhow">${escapeText(how)}</p>
          </div>`).join('')}
      </div>
    </section>

    <section class="fp__panel" aria-labelledby="fpEpochsH">
      <header class="fp__head">
        <h2 class="fp__h" id="fpEpochsH">Stocks: the chart's seeds</h2>
        <span class="fp__note">Each epoch's hash is out before it starts</span>
      </header>
      <div class="fp__epochs" id="fpEpochs"><p class="fp__line fp__pad">Loading…</p></div>
    </section>`;

  $('#fpMore', root).addEventListener('click', () => void loadRounds(false));
  $('#fpForm', root).addEventListener('submit', (event) => {
    event.preventDefault();
    void manualCheck();
  });
}

function paintCommitment() {
  const lock = root && $('#fpLock', root);
  if (!lock) return;
  if (!state.authenticated || !state.fairness) {
    lock.innerHTML = `
      <span class="fp__slot"><img src="assets/img/items/tripwire_hook.png" alt="" width="32" height="32"></span>
      <div class="fp__lockcopy">
        <span class="fp__k">Your next bet</span>
        <p class="fp__line">Log in to see the hash your next bet is locked to.</p>
      </div>`;
    return;
  }
  lock.innerHTML = `
    <span class="fp__slot"><img src="assets/img/items/tripwire_hook.png" alt="" width="32" height="32"></span>
    <div class="fp__lockcopy">
      <span class="fp__k">Your next bet is locked to</span>
      <code class="fp__hash mono" id="fpLockHash"></code>
    </div>
    <dl class="fp__facts">
      <div><dt>Nonce</dt><dd id="fpLockNonce"></dd></div>
      <div><dt>Algorithm</dt><dd id="fpLockAlgo"></dd></div>
    </dl>`;
  $('#fpLockHash', lock).textContent = state.fairness.serverSeedHash;
  $('#fpLockNonce', lock).textContent = String(state.fairness.nonce);
  $('#fpLockAlgo', lock).textContent = state.fairness.algorithm || 'HMAC-SHA256-v1';
}

/* ─────────── your rounds ─────────── */

async function loadRounds(reset) {
  const list = root && $('#fpRounds', root);
  if (!list || loading) return;
  if (!state.authenticated) {
    rounds = [];
    next = null;
    paintFilters();
    list.innerHTML = '<p class="fp__line fp__pad">Log in to see your rounds and check them.</p>';
    $('#fpMore', root).hidden = true;
    return;
  }
  loading = true;
  if (reset) {
    rounds = [];
    next = null;
    list.innerHTML = '<p class="fp__line fp__pad">Loading your rounds…</p>';
  }
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (game) params.set('game', game);
    if (!reset && next) params.set('before', next);
    const data = await api.get(`/v1/fairness/rounds?${params}`);
    games = data.games ?? games;
    rounds = reset ? data.rounds : [...rounds, ...data.rounds];
    next = data.next;
    paintFilters();
    paintRounds();
  } catch (error) {
    list.innerHTML = `<p class="fp__line fp__pad">${escapeText(error?.message || 'Your rounds could not be loaded.')}</p>`;
  } finally {
    loading = false;
  }
}

function paintFilters() {
  const box = $('#fpFilters', root);
  if (!state.authenticated || !games.length) {
    box.innerHTML = '';
    return;
  }
  const options = [{ game: '', name: 'All games' }, ...games];
  box.innerHTML = options.map((option) =>
    `<button class="fp__chip" type="button" data-game="${escapeText(option.game)}" aria-pressed="${option.game === game}">${escapeText(option.name)}</button>`,
  ).join('');
  box.querySelectorAll('[data-game]').forEach((chip) => chip.addEventListener('click', () => {
    game = chip.dataset.game;
    void loadRounds(true);
  }));
}

function paintRounds() {
  const list = $('#fpRounds', root);
  $('#fpMore', root).hidden = !next;
  if (!rounds.length) {
    list.innerHTML = `<p class="fp__line fp__pad">${game ? 'No rounds of this game yet.' : 'No rounds yet. Play one and it appears here, ready to check.'}</p>`;
    return;
  }
  list.innerHTML = '';
  for (const round of rounds) list.appendChild(roundRow(round));
}

function roundRow(round) {
  const row = document.createElement('article');
  row.className = 'fp__round';
  const profit = Number(round.payoutMinor) - Number(round.wagerMinor);
  const dir = profit > 0 ? 'up' : profit < 0 ? 'down' : '';
  row.innerHTML = `
    <div class="fp__rowmain">
      <span class="fp__slot"><img src="${artFor(round.game)}" alt="" width="32" height="32"></span>
      <div class="fp__rowcopy">
        <b class="fp__rowname"></b>
        <span class="fp__rowdetail"></span>
      </div>
      <div class="fp__rowmoney">
        <b class="fp__rowresult" data-dir="${dir}"></b>
        <span class="fp__rowwhen"></span>
      </div>
      <button class="fp__btn" type="button" aria-expanded="false">Check</button>
    </div>
    <div class="fp__rowbody" hidden>
      <dl class="fp__seeds">
        <div><dt>Hash given before the bet</dt><dd class="mono" data-k="hash"></dd></div>
        <div><dt>Server seed, revealed</dt><dd class="mono" data-k="seed"></dd></div>
        <div><dt>Client seed</dt><dd class="mono" data-k="client"></dd></div>
        <div><dt>Nonce</dt><dd class="mono" data-k="nonce"></dd></div>
      </dl>
      <div class="fp__checks" aria-live="polite"></div>
    </div>`;
  $('.fp__rowname', row).textContent = round.name;
  $('.fp__rowdetail', row).textContent = round.detail || '';
  $('.fp__rowresult', row).textContent = profit > 0 ? `+${money(profit)}` : profit < 0 ? `−${money(-profit)}` : 'Even';
  $('.fp__rowwhen', row).textContent = `${money(Number(round.wagerMinor))} · ${when(round.at)}`;
  $('[data-k="hash"]', row).textContent = round.serverSeedHash;
  $('[data-k="seed"]', row).textContent = round.serverSeed;
  $('[data-k="client"]', row).textContent = round.clientSeed ?? '— (none: a shared round)';
  $('[data-k="nonce"]', row).textContent = round.nonce ?? '—';

  const button = $('.fp__btn', row);
  const body = $('.fp__rowbody', row);
  button.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide' : 'Check';
    if (open && !body.dataset.checked) {
      body.dataset.checked = '1';
      void checkRound(round, $('.fp__checks', body));
    }
  });
  return row;
}

/* ─────────── the check, in the browser ─────────── */

function paintChecks(box, lines) {
  box.hidden = false;
  box.innerHTML = lines.map(({ ok, value }) => `
    <div class="fp__check" data-ok="${ok === null ? '' : ok}">
      <i aria-hidden="true">${ok === true ? '✓' : ok === false ? '✗' : '·'}</i>
      <span><span class="fp__checktext"></span>${value ? '<code class="mono fp__checkval"></code>' : ''}</span>
    </div>`).join('');
  box.querySelectorAll('.fp__check').forEach((node, i) => {
    $('.fp__checktext', node).textContent = lines[i].text;
    const code = $('.fp__checkval', node);
    if (code) code.textContent = lines[i].value;
  });
}

/** What a game's own formula makes of a digest, against what was recorded. */
function replayLine(gameKey, digest, facts) {
  if (!facts) return null;
  if (gameKey === 'dice' && facts.roll !== undefined) {
    const mine = diceRoll(digest);
    return { ok: mine === facts.roll, text: `Rolled ${two(mine)}: ${mine === facts.roll ? 'the same as the recorded roll' : `the round says ${two(facts.roll)}`}.` };
  }
  if (gameKey === 'limbo' && facts.resultX100 !== undefined) {
    const mine = limboResultX100(digest);
    return { ok: mine === facts.resultX100, text: `Drew ${two(Math.max(100, mine))}x: ${mine === facts.resultX100 ? 'the same as recorded' : `the round says ${two(facts.resultX100)}x`}.` };
  }
  if (gameKey === 'upgrader' && facts.rollPpm !== undefined) {
    const mine = rollPpm(digest);
    const outcome = mine < facts.chancePpm ? 'win' : 'lose';
    const same = mine === facts.rollPpm && outcome === facts.outcome;
    return { ok: same, text: `Roll ${(mine / 10_000).toFixed(4)}% against a ${(facts.chancePpm / 10_000).toFixed(2)}% chance: a ${outcome}. ${same ? 'The same as recorded.' : 'The round says otherwise.'}` };
  }
  if (gameKey === 'roulette' && facts.pocket !== undefined) {
    const mine = roulettePocket(digest);
    return { ok: mine === Number(facts.pocket), text: `Landed on ${mine}: ${mine === Number(facts.pocket) ? 'the same as recorded' : `the round says ${facts.pocket}`}.` };
  }
  if (gameKey === 'crash' && facts.crashX100 !== undefined) {
    const mine = crashPointX100(digest, Number(facts.edgeBps ?? 1000));
    return { ok: mine === facts.crashX100, text: `Crashed at ${two(mine)}x: ${mine === facts.crashX100 ? 'the same as recorded' : `the round says ${two(facts.crashX100)}x`}.` };
  }
  if (gameKey === 'coinflip' && facts.result) {
    const mine = coinflipSide(digest);
    return { ok: mine === facts.result, text: `Landed ${mine}: ${mine === facts.result ? 'the same as recorded' : `the round says ${facts.result}`}.` };
  }
  return null;
}

async function checkRound(round, box) {
  paintChecks(box, [{ ok: null, text: 'Checking in your browser…' }]);
  try {
    const hashed = await sha256Hex(round.serverSeed);
    const lines = [{
      ok: hashed === round.serverSeedHash,
      text: hashed === round.serverSeedHash
        ? 'The revealed seed hashes to the hash you were given before the bet: it was fixed in advance.'
        : 'The revealed seed does NOT hash to the hash given before the bet. Tell us in the Discord.',
    }];
    if (round.message) {
      const digest = await hmacHex(round.serverSeed, round.message);
      lines.push({ ok: null, text: `HMAC-SHA256 of "${round.message}", keyed with the seed:`, value: digest });
      const replay = replayLine(round.game, digest, round.facts);
      if (replay) lines.push(replay);
    } else {
      const recipe = recipeFor(round.game);
      lines.push({ ok: null, text: recipe ? `${round.name} draws from ${recipe[1]}: ${recipe[2]}` : `${round.name} draws from this seed as described below.` });
    }
    paintChecks(box, lines);
  } catch {
    paintChecks(box, [{ ok: null, text: 'Your browser could not run the check (it needs a secure page and WebCrypto).' }]);
  }
}

async function manualCheck() {
  const out = $('#fpManualOut', root);
  const seed = $('#fpSeed', root).value.trim();
  const committed = $('#fpHash', root).value.trim().toLowerCase();
  const message = $('#fpMessage', root).value.trim();
  const as = $('#fpAs', root).value;
  if (!/^[a-f0-9]{64}$/i.test(seed)) return paintChecks(out, [{ ok: false, text: 'A server seed is 64 hex characters.' }]);
  if (committed && !/^[a-f0-9]{64}$/.test(committed)) return paintChecks(out, [{ ok: false, text: 'A hash is 64 hex characters.' }]);
  const hashed = await sha256Hex(seed);
  const lines = [committed
    ? { ok: hashed === committed, text: hashed === committed ? 'The seed hashes to that hash.' : 'The seed does NOT hash to that hash.' }
    : { ok: null, text: 'SHA-256 of the seed:', value: hashed }];
  if (message) {
    const digest = await hmacHex(seed, message);
    lines.push({ ok: null, text: `HMAC-SHA256 of "${message}":`, value: digest });
    const read = {
      dice: () => `Dice roll ${two(diceRoll(digest))}`,
      limbo: () => `Limbo result ${two(Math.max(100, limboResultX100(digest)))}x`,
      roll: () => `Roll ${(rollPpm(digest) / 10_000).toFixed(4)}% (${rollPpm(digest)} of 1,000,000)`,
      roulette: () => `Roulette pocket ${roulettePocket(digest)}`,
      crash: () => `Crash point ${two(crashPointX100(digest, 1000))}x`,
      coinflip: () => `Coinflip: ${coinflipSide(digest)}`,
    }[as];
    if (read) lines.push({ ok: null, text: read() });
  }
  paintChecks(out, lines);
}

/* ─────────── Stocks epochs ─────────── */

async function loadEpochs() {
  const box = root && $('#fpEpochs', root);
  if (!box) return;
  try {
    const data = await api.get('/v1/stocks/epochs');
    const epochs = (data.epochs ?? []).slice(0, 6);
    if (!epochs.length) {
      box.innerHTML = '<p class="fp__line fp__pad">No epoch has ended yet.</p>';
      return;
    }
    box.innerHTML = '';
    for (const epoch of epochs) {
      const row = document.createElement('div');
      row.className = 'fp__epoch';
      row.innerHTML = `
        <b class="fp__epochname"></b>
        <span class="fp__epochseed mono" title="Server seed"></span>
        <span class="fp__epochok" aria-live="polite"></span>
        <button class="fp__btn" type="button">Check</button>`;
      $('.fp__epochname', row).textContent = `Epoch ${epoch.seq} · ${when(epoch.startsAt)}`;
      $('.fp__epochseed', row).textContent = short(epoch.serverSeed);
      $('.fp__btn', row).addEventListener('click', async () => {
        const ok = (await sha256Hex(epoch.serverSeed)) === epoch.serverSeedHash;
        const mark = $('.fp__epochok', row);
        mark.dataset.ok = String(ok);
        mark.textContent = ok ? '✓ matches its hash' : '✗ does not match';
      });
      box.appendChild(row);
    }
  } catch {
    box.innerHTML = '<p class="fp__line fp__pad">The epochs could not be loaded.</p>';
  }
}
