/* slots.js — the site's slot machines, one page each: Ore Rush (five reels of Minecraft ore, a wild
 * Totem, books for free spins) and the Ocean Monument (the guardians' temple: every Guardian a line
 * runs through doubles it, the Elder Guardian opens free spins). Same page, same rules, different
 * strips, pays and room; GAMES below holds what differs on the page.
 *
 * The server owns every spin. One request takes the stake, draws the paid spin and every free spin
 * it leads to from the player's committed fairness seed, and pays the round (lib/slots.ts); this
 * page animates a round that already exists, spin by spin. The strips, lines and pays come from
 * GET /v1/slots/config, so what the reels scroll through is the machine the server plays.
 *
 * The wallet pill does not run ahead of the reels. The live figures are held from the click, the
 * pill drops by the stake when the answer arrives, and the round's pay is shown only after the last
 * reel of the last free spin has landed.
 *
 * The machine is drawn in WebGL (slots3d.js): five drums whose facets are the server's strips, in a
 * cabinet of Minecraft blocks with a lever. The drums start turning on the click and land when the
 * answer arrives. Where WebGL is missing or its context is lost, the flat reels below do the same job:
 * each strip scrolls through its real symbols and lands with a small bounce. The flat reels are kept
 * up to date either way -- they are what a screen reader reads.
 *
 * With reduced motion every reel lands at once and nothing pulses.
 */
import { api, clientSeed, idempotencyKey } from './api.js';
import { bus, holdLiveFigures, refreshBalance, showBalance, state } from './store.js';
import { $, formatAmountInput, money, parseAmount, reduceMotion } from './util.js';
import { openModal, toast } from './ui.js';
import { playSound } from './audio-engine.js';
import { onNavigate } from './routing.js';
import { createMachine3d } from './slots3d.js';
import { onViewChange, onViewSwitch, paintViewSwitch, setWants3d, viewSwitch, wants3d } from './view3d.js';

/* What each machine's page says and shows. `art` is the item sprite (assets/img/items) for each
 * symbol the server names, real sprites drawn pixel-sharp; `prefix` keeps the two pages' element ids
 * apart, since both can be built at once. */
const GAMES = {
  'ore-rush': {
    machine: 'ore-rush',
    prefix: 'slots',
    title: 'Ore Rush',
    label: 'Ore Rush',
    art: {
      redstone: 'redstone', iron: 'iron_ingot', gold: 'gold_ingot', emerald: 'emerald', apple: 'golden_apple',
      diamond: 'diamond', netherite: 'netherite_ingot', star: 'nether_star', totem: 'totem', book: 'enchanted_book',
    },
    marquee: 'netherite_pickaxe',
    scatterId: 'book',
    scatter: ['book', 'books'],
    opened: 'Enchanted!',
    reopened: 'Re-enchanted!',
    wildNote: 'It lands on reels 2, 3 and 4 and stands in for every symbol except the book.',
  },
  monument: {
    machine: 'monument',
    prefix: 'monument',
    title: 'Ocean Monument',
    label: 'Ocean Monument',
    art: {
      cod: 'cod', pufferfish: 'pufferfish', shard: 'prismarine_shard', crystals: 'prismarine_crystals',
      nautilus: 'nautilus_shell', trim: 'tide_armor_trim_smithing_template', trident: 'trident',
      heart: 'heart_of_the_sea', guardian: 'guardian_spawn_egg', elder: 'elder_guardian_spawn_egg',
    },
    marquee: 'trident',
    scatterId: 'elder',
    scatter: ['Elder Guardian', 'Elder Guardians'],
    opened: 'The Elder wakes!',
    reopened: 'The Elder returns!',
    wildNote: 'It lands on reels 2, 3 and 4, stands in for every symbol except the Elder Guardian, and doubles every line it completes: two Guardians make it ×4, three ×8.',
  },
};

/* The glint is masked by the item's own image through a custom property. A relative url() there
 * resolves against the stylesheet that reads it, so the mask gets an absolute one. */
const absolute = (src) => new URL(src, document.baseURI).href;

/* Win tiers, in stakes. */
const TIERS = [[200, 'Epic win!'], [50, 'Mega win!'], [15, 'Big win!']];

/** One machine's page: its own state, its own element ids, its own 3D room. Returns the mount. */
function createSlotsGame(game) {
  const P = game.prefix;
  const icon = (id) => `assets/img/items/${game.art[id] || 'stone'}.png`;

  let root = null;
  let view = null;
  let config = null;
  let seedHash = null;
  let stakeText = '1m';
  let tops = [0, 0, 0, 0, 0]; // the strip index in the top row of each reel
  let spinning = false;
  let auto = false;
  let turbo = false;
  let round = null; // { free: { left, played, won } | null }
  let lastWins = [];
  let session = { spins: 0, won: 0n, best: 0n };
  let cycleTimer = 0;
  let nextTimer = 0;
  let tickTimer = 0;
  let countFrame = 0;
  let machine = null; // the WebGL machine, once it is up; null draws the flat reels
  let machineTried = false;

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /* ─────────── numbers ─────────── */

  function stakeMinor() {
    const value = parseAmount(stakeText);
    return value === null ? null : BigInt(value);
  }

  /** The largest stake: the configured maximum, or what the 1,000x ceiling allows, if lower. */
  function maxStake() {
    if (!config) return 0n;
    const ceiling = BigInt(config.maxPayoutMinor) / BigInt(config.maxWinX);
    const max = BigInt(config.maxStakeMinor);
    return ceiling < max ? ceiling : max;
  }

  function spinProblem() {
    if (!config) return `${game.label} is not answering`;
    if (!config.enabled) return `${game.label} is closed right now`;
    const stake = stakeMinor();
    if (stake === null || stake <= 0n) return 'Enter a stake, for example 1m';
    if (stake < BigInt(config.minStakeMinor)) return `The smallest spin is ${money(Number(config.minStakeMinor))}`;
    if (stake > maxStake()) return `The largest spin is ${money(Number(maxStake()))}`;
    if (state.authenticated && stake > BigInt(state.balanceMinor || '0')) return 'That is more than your balance';
    return '';
  }

  const symbolOf = (index) => config?.symbols?.[index] ?? { id: 'stone', name: '' };
  const visible = (reel, top = tops[reel]) => {
    const strip = config.strips[reel];
    return [0, 1, 2].map((row) => strip[(top + row) % strip.length]);
  };

  /* ─────────── talking to the server ─────────── */

  async function load() {
    try {
      config = await api.get(`/v1/slots/config?machine=${game.machine}`);
    } catch {
      config = null;
    }
    if (state.authenticated) await refreshSeed();
    if (config && !spinning) for (let reel = 0; reel < 5; reel += 1) paintReel(reel);
    paint();
    if (config && !machineTried) void startMachine();
  }

  /** Builds the 3D machine over the flat reels. Any failure leaves the flat reels in charge. */
  async function startMachine() {
    if (!wants3d()) return;
    machineTried = true;
    try {
      const built = await createMachine3d($('.slots__window', root), {
        strips: config.strips,
        symbols: config.symbols,
        scatter: config.scatter,
        lines: config.lines,
        icon,
        theme: game.machine,
        onLever: () => void spin(),
        onAuto: () => $(`#${P}Auto`, root)?.click(),
        onTurbo: () => $(`#${P}Turbo`, root)?.click(),
      });
      if (!built) {
        root.dataset.no3d = '';
        return;
      }
      if (!wants3d()) {
        // Switched to 2D while it was loading.
        built.dispose();
        machineTried = false;
        return;
      }
      built.onLost = () => {
        machine = null;
        built.dispose();
        root.dataset.render = '2d';
      };
      built.showStops(tops);
      built.setMode(root.dataset.mode);
      built.setFlags({ auto, turbo });
      machine = built;
      root.dataset.render = '3d';
    } catch {
      machine = null;
      root.dataset.render = '2d';
    }
  }

  /** The 2D/3D switch (view3d.js): 2D puts the machine away for the flat reels, 3D builds it again. */
  function setView(on) {
    if (spinning) {
      // Switched somewhere else mid-spin: followed once the reels stop.
      if (on === wants3d()) setTimeout(() => setView(wants3d()), 600);
      paintView();
      return;
    }
    if (on !== wants3d()) {
      setWants3d(on);
      playSound('click');
    }
    if (!on && machine) {
      machine.dispose();
      machine = null;
      machineTried = false;
      root.dataset.render = '2d';
      if (config) for (let reel = 0; reel < 5; reel += 1) paintReel(reel);
    }
    if (on && config && !machineTried) void startMachine();
    paintView();
  }

  function paintView() {
    if (root) paintViewSwitch(root, $(`#${P}View`, root), { disabled: spinning });
  }

  function setMode(mode) {
    root.dataset.mode = mode;
    machine?.setMode(mode);
  }

  async function refreshSeed() {
    try {
      seedHash = (await api.get('/v1/fairness/current')).serverSeedHash;
    } catch {
      seedHash = null;
    }
  }

  async function send(stake) {
    if (!seedHash) await refreshSeed();
    const body = () => ({ stakeMinor: stake.toString(), clientSeed: clientSeed(), serverSeedHash: seedHash, machine: game.machine });
    let key = idempotencyKey();
    try {
      return await api.post('/v1/slots/spins', body(), { idempotencyKey: key });
    } catch (error) {
      /* The commitment moved (another tab played something): pick up the new one and go again under a
       * new key, since the request itself is now a different one. */
      if (error?.code !== 'FAIRNESS_COMMITMENT_CHANGED') throw error;
      await refreshSeed();
      key = idempotencyKey();
      return api.post('/v1/slots/spins', body(), { idempotencyKey: key });
    }
  }

  /* ─────────── a paid spin, and the round it buys ─────────── */

  async function spin() {
    clearTimeout(nextTimer);
    if (!state.authenticated) {
      stopAuto();
      $('#loginBtn')?.click();
      return;
    }
    if (spinning) return;
    if (spinProblem()) {
      stopAuto();
      paint();
      return;
    }
    spinning = true;
    const stake = stakeMinor();
    const before = BigInt(state.balanceMinor || '0');
    /* Held from the click, not from the answer: a poll landing between the two would print the
     * round's pay before the reels had stopped. */
    const release = holdLiveFigures();
    let failed = false;
    clearWins();
    cancelAnimationFrame(countFrame);
    paintMeter(0n);
    pullLever();
    // The drums start on the click; they land when the answer arrives.
    if (machine) machine.spinStart();
    else root.querySelectorAll('.slots__reel').forEach((node) => { node.dataset.state = 'spin'; });
    paint();
    try {
      const response = await send(stake);
      seedHash = response.nextServerSeedHash || null;
      // The stake leaves the pill now; what the round paid waits for the reels.
      const after = before - stake;
      showBalance((after < 0n ? 0n : after).toString());
      await playRound(response.spin, stake);
      showBalance(response.balanceMinor);
    } catch (error) {
      failed = true;
      stopAuto();
      if (error?.code === 'FAIRNESS_COMMITMENT_CHANGED') await refreshSeed();
      toast({ kind: 'lose', title: game.label, body: error?.message || 'That spin did not go through' });
      // Nothing was spun: the drums come back to rest where they were.
      if (machine) await machine.land(tops, { minSpin: 0.1, gap: 0.05 });
      if (config) for (let reel = 0; reel < 5; reel += 1) paintReel(reel);
    } finally {
      release();
      spinning = false;
      round = null;
      setMode('base');
      void refreshBalance();
      paint();
    }
    if (!failed) scheduleNext();
  }

  async function playRound(result, stake) {
    const spins = result.spins;
    let won = 0n;
    round = { free: null };
    for (let index = 0; index < spins.length; index += 1) {
      const step = spins[index];
      if (step.free) {
        round.free.left -= 1;
        round.free.played += 1;
        paint();
      }
      clearWins();
      await roll(step.stops);
      tops = step.stops;
      session.spins += 1;
      const paid = BigInt(step.payoutMinor);
      won += paid;
      if (round.free) {
        round.free.won += paid;
        paintFree();
      }
      await present(step, stake, won);

      if (step.awarded > 0) {
        if (round.free) {
          round.free.left += step.awarded;
          machine?.enchant('retrigger');
          await banner('retrigger', `+${step.awarded} free spins`);
        } else {
          round.free = { left: step.awarded, played: 0, won: 0n };
          machine?.enchant('enchant');
          setMode('free');
          await banner('enchant', `${step.awarded} free spins · wins ×${config.freeMultiplier}`);
        }
        paint();
      } else if (step.free && index < spins.length - 1) {
        await wait((lastWins.length ? 900 : 380) * (turbo ? 0.4 : 1));
      }
    }
    const total = BigInt(result.payoutMinor);
    session.won += total;
    if (total > session.best) session.best = total;
    paintStats();
    if (result.capped) await banner('summary', `Max win: ${config.maxWinX.toLocaleString('en-US')}× the stake`);
    else if (round.free) await banner('summary', round.free.won > 0n ? `${money(Number(round.free.won))} from the free spins` : 'Nothing from the free spins');
    say(total > 0n ? `The spin paid ${money(Number(total))}.` : 'No win.');
  }

  function scheduleNext() {
    clearTimeout(nextTimer);
    if (!auto) return;
    if (!view || view.hidden || spinProblem()) {
      stopAuto();
      return;
    }
    nextTimer = setTimeout(() => {
      if (!view || view.hidden) {
        stopAuto();
        return;
      }
      void spin();
    }, (lastWins.length ? 1100 : 420) * (turbo ? 0.4 : 1));
  }

  function stopAuto() {
    clearTimeout(nextTimer);
    if (!auto) return;
    auto = false;
    paintControls();
  }

  /* ─────────── motion ─────────── */

  function cellHtml(symbol, row) {
    const s = symbolOf(symbol);
    const src = icon(s.id);
    return `<div class="slots__cell"${row === undefined ? '' : ` data-row="${row}"`} data-sym="${s.id}" style="--icon:url('${absolute(src)}')"><img src="${src}" alt="" draggable="false" /></div>`;
  }

  function paintReel(reel, symbols = visible(reel)) {
    const node = root.querySelector(`.slots__reel[data-reel="${reel}"]`);
    const strip = node.querySelector('.slots__strip');
    strip.innerHTML = symbols.map((symbol, row) => cellHtml(symbol, row)).join('');
    node.dataset.state = 'idle';
    node.dataset.tease = '0';
    node.setAttribute('aria-label', `Reel ${reel + 1}: ${symbols.map((symbol) => symbolOf(symbol).name).join(', ')}`);
  }

  /** Scroll each reel through its own strip and land on the new stops, left to right. */
  function roll(next) {
    const grid = next.map((top, reel) => visible(reel, top));
    if (machine) {
      clearInterval(tickTimer);
      tickTimer = setInterval(() => playSound('reeltick'), turbo ? 70 : 95);
      return machine.land(next, {
        minSpin: turbo ? 0.12 : 0.5,
        gap: turbo ? 0.07 : 0.2,
        tease: turbo ? 0.35 : 0.7,
        landTime: turbo ? 0.28 : 0.42,
        onStop: (reel) => {
          paintReel(reel, grid[reel]);
          playSound('tick', { rate: 0.9 + reel * 0.06 });
          if (grid[reel].includes(config.scatter)) playSound('chime');
        },
      }).finally(() => clearInterval(tickTimer));
    }
    if (reduceMotion()) {
      grid.forEach((symbols, reel) => paintReel(reel, symbols));
      playSound('tick');
      return Promise.resolve();
    }
    const first = root.querySelector('.slots__reel');
    const h = first ? first.getBoundingClientRect().height / 3 : 0;
    const quick = turbo ? 0.45 : 1;
    let teaseFrom = -1;
    let booksSoFar = 0;
    const jobs = next.map((top, reel) => {
      const strip = config.strips[reel];
      const length = strip.length;
      /* Distance in cells: back from the old top to the new one, plus whole turns of the strip. The
       * column's first three cells are the landing window and its last three what was showing, so
       * the scroll runs through real strip order. */
      const turns = 1 + Math.floor(reel / 2) + (turbo ? 0 : 1);
      const distance = ((tops[reel] - top + length) % length) + turns * length;
      let duration = (720 + reel * 200) * quick;
      if (teaseFrom >= 0) duration += (reel - teaseFrom + 1) * 700 * quick;
      const cells = [];
      for (let k = 0; k <= distance + 2; k += 1) cells.push(strip[(top + k) % length]);
      const node = root.querySelector(`.slots__reel[data-reel="${reel}"]`);
      const column = node.querySelector('.slots__strip');
      column.innerHTML = cells.map((symbol, k) => cellHtml(symbol, k < 3 ? k : undefined)).join('');
      node.dataset.state = 'spin';
      node.dataset.tease = teaseFrom >= 0 ? '1' : '0';

      booksSoFar += grid[reel].filter((symbol) => symbol === config.scatter).length;
      if (booksSoFar >= 2 && teaseFrom < 0 && reel < 4) teaseFrom = reel + 1;

      const animation = column.animate(
        [
          { transform: `translateY(${-distance * h}px)`, easing: 'cubic-bezier(.32, .04, .26, 1)' },
          { transform: `translateY(${Math.round(h * 0.12)}px)`, offset: 0.93, easing: 'ease-in-out' },
          { transform: 'translateY(0)' },
        ],
        { duration },
      );
      /* The blur comes off a little before the reel lands, so the symbol is sharp as it settles. */
      setTimeout(() => { node.dataset.state = 'settle'; }, duration * 0.78);
      return animation.finished.then(() => {
        paintReel(reel, grid[reel]);
        playSound('tick', { rate: 0.9 + reel * 0.06 });
        if (grid[reel].includes(config.scatter)) playSound('chime');
      });
    });

    clearInterval(tickTimer);
    tickTimer = setInterval(() => playSound('reeltick'), turbo ? 70 : 95);
    return Promise.all(jobs).finally(() => clearInterval(tickTimer));
  }

  function pullLever() {
    playSound('click');
    machine?.pull();
    const lever = $(`#${P}Lever`, root);
    if (!lever || reduceMotion()) return;
    lever.animate(
      [{ transform: 'rotate(8deg) scaleY(1)' }, { transform: 'rotate(8deg) scaleY(-.8)', offset: 0.4 }, { transform: 'rotate(8deg) scaleY(1)' }],
      { duration: turbo ? 380 : 620, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
  }

  function clearWins() {
    clearInterval(cycleTimer);
    lastWins = [];
    root.querySelectorAll('.slots__cell[data-win], .slots__cell[data-dim]').forEach((cell) => {
      delete cell.dataset.win;
      delete cell.dataset.dim;
    });
    $(`#${P}Lines`, root).innerHTML = '';
    $(`#${P}Splash`, root).hidden = true;
    machine?.clear();
    setAction(round?.free ? `Free spins pay ×${config?.freeMultiplier ?? 2}` : 'Three or more in a row from the left', '');
  }

  function cellAt(reel, row) {
    return root.querySelector(`.slots__reel[data-reel="${reel}"] .slots__cell[data-row="${row}"]`);
  }

  /** The wins one landed spin shows, each with the cells it lit and what it paid. */
  function winsOf(step, stake) {
    const mult = BigInt(step.free ? config.freeMultiplier : 1);
    const wins = step.lines.map((win) => ({
      kind: 'line',
      line: win.line,
      symbol: win.symbol,
      count: win.count,
      multiplier: win.multiplier ?? 1,
      amount: (stake * BigInt(win.pays) * mult) / 10n,
      cells: config.lines[win.line].slice(0, win.count).map((row, reel) => [reel, row]),
    }));
    if (step.books >= 3) {
      const cells = [];
      step.grid.forEach((column, reel) => column.forEach((symbol, row) => {
        if (symbol === config.scatter) cells.push([reel, row]);
      }));
      wins.push({
        kind: 'scatter', symbol: config.scatter, count: step.books, cells,
        amount: stake * BigInt(config.scatterPayX[step.books] ?? 0) * mult,
      });
    }
    return wins;
  }

  /** Show what a landed spin paid: lit cells, drawn lines, the meter, and a splash if it was big. */
  async function present(step, stake, roundWon) {
    const wins = winsOf(step, stake);
    if (!wins.length) {
      paintMeter(roundWon);
      machine?.react?.('lose');
      return;
    }
    lastWins = wins;
    const lit = new Set();
    for (const win of wins) for (const [reel, row] of win.cells) lit.add(`${reel}:${row}`);
    for (let reel = 0; reel < 5; reel += 1) {
      for (let row = 0; row < 3; row += 1) {
        const cell = cellAt(reel, row);
        if (!cell) continue;
        if (lit.has(`${reel}:${row}`)) cell.dataset.win = '1';
        else cell.dataset.dim = '1';
      }
    }
    drawLines(wins.filter((win) => win.kind === 'line'));
    if (machine) machine.highlight(wins.map(asMachineWin));
    else burst(wins);
    if (machine && BigInt(step.payoutMinor) > 0n) {
      // What it paid spills out of the chute.
      machine.payout(Number((BigInt(step.payoutMinor) * 100n) / stake) / 100);
      setTimeout(() => playSound('spill'), 260);
    }

    const paid = BigInt(step.payoutMinor);
    const ratio = Number((paid * 100n) / stake) / 100;
    const tier = TIERS.find(([min]) => ratio >= min);
    playSound(tier ? 'jackpot' : ratio >= 3 ? 'win' : 'coin');
    countUp(roundWon - paid, roundWon, tier ? 1600 : 500);
    if (tier) {
      splash(tier[1]);
      machine?.celebrate(TIERS.length - TIERS.indexOf(tier));
    }
    // The trader beside the machine nods along; the book's own moment comes with the free spins.
    machine?.react?.(tier ? 'big' : step.books >= 3 ? 'free' : 'win', ratio);
    cycleWins();
    if (tier && !reduceMotion()) await wait(turbo ? 900 : 1800);
  }

  const asMachineWin = (win) => ({ line: win.kind === 'line' ? win.line : 'scatter', cells: win.cells });

  function drawLines(lineWins, only = null) {
    $(`#${P}Lines`, root).innerHTML = lineWins
      .filter((win) => only === null || win.line === only)
      .map((win) => {
        // Drawn as far as the line paid, so three in a row does not look like a line across all five.
        const points = config.lines[win.line].slice(0, win.count).map((row, reel) => `${reel * 100 + 50},${row * 100 + 50}`).join(' ');
        return `<polyline class="slots__path" data-line="${win.line}" points="${points}" />`;
      })
      .join('');
  }

  /** With several wins, step through them one at a time in the action bar, each with its line. */
  function cycleWins() {
    clearInterval(cycleTimer);
    const lineWins = lastWins.filter((win) => win.kind === 'line');
    const describe = (win) => win.kind === 'scatter'
      ? [`${win.count}× ${symbolOf(win.symbol).name}`, `${money(Number(win.amount))} + free spins`]
      : [`Line ${win.line + 1} · ${win.count}× ${symbolOf(win.symbol).name}${win.multiplier > 1 ? ` · ${symbolOf(config.wild).name} ×${win.multiplier}` : ''}`, money(Number(win.amount))];
    const show = (win) => {
      const [label, amount] = describe(win);
      setAction(label, amount, win.kind === 'line' ? win.line : 'scatter');
      drawLines(lineWins, win.kind === 'line' && lastWins.length > 1 ? win.line : null);
      if (lastWins.length > 1) {
        machine?.focus(asMachineWin(win));
        for (const cell of root.querySelectorAll('.slots__cell[data-win]')) cell.dataset.win = 'rest';
        for (const [reel, row] of win.cells) {
          const cell = cellAt(reel, row);
          if (cell) cell.dataset.win = '1';
        }
      }
    };
    let index = 0;
    show(lastWins[0]);
    if (lastWins.length < 2) return;
    cycleTimer = setInterval(() => {
      index = (index + 1) % lastWins.length;
      show(lastWins[index]);
    }, 1300);
  }

  function countUp(from, to, duration) {
    cancelAnimationFrame(countFrame);
    if (reduceMotion() || duration <= 0 || to <= from) {
      paintMeter(to);
      return;
    }
    const start = performance.now();
    const span = Number(to - from);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      paintMeter(from + BigInt(Math.round(span * (1 - Math.pow(1 - t, 3)))));
      if (t < 1) countFrame = requestAnimationFrame(step);
    };
    countFrame = requestAnimationFrame(step);
  }

  /** Experience orbs rise from every winning cell, as they do from ore in the game. */
  function burst(wins) {
    if (reduceMotion()) return;
    const layer = $(`#${P}Fx`, root);
    const box = layer.getBoundingClientRect();
    const seen = new Set();
    for (const win of wins) {
      for (const [reel, row] of win.cells) {
        const key = `${reel}:${row}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = cellAt(reel, row);
        if (!cell) continue;
        const rect = cell.getBoundingClientRect();
        const x = rect.left - box.left + rect.width / 2;
        const y = rect.top - box.top + rect.height / 2;
        for (let i = 0; i < 4; i += 1) {
          const orb = document.createElement('i');
          orb.className = 'slots__orb';
          orb.style.left = `${x}px`;
          orb.style.top = `${y}px`;
          layer.append(orb);
          const dx = (Math.random() - 0.5) * rect.width * 1.1;
          const rise = rect.height * (0.6 + Math.random() * 0.7);
          orb.animate(
            [
              { transform: 'translate(-50%, -50%) scale(.4)', opacity: 0 },
              { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% - ${rise * 0.5}px)) scale(1)`, opacity: 1, offset: 0.35 },
              { transform: `translate(calc(-50% + ${dx}px), calc(-50% - ${rise}px)) scale(.7)`, opacity: 0 },
            ],
            { duration: 900 + Math.random() * 500, delay: i * 70, easing: 'cubic-bezier(.22, 1, .36, 1)' },
          ).finished.then(() => orb.remove(), () => orb.remove());
        }
      }
    }
  }

  function splash(text) {
    const node = $(`#${P}Splash`, root);
    node.textContent = text;
    node.hidden = false;
  }

  /** The round's interstitials: free spins opened, opened again, and the round's total. */
  function banner(kind, detail) {
    const node = $(`#${P}Banner`, root);
    node.dataset.kind = kind;
    const title = kind === 'enchant' ? game.opened : kind === 'retrigger' ? game.reopened : 'Round over';
    $('b', node).textContent = title;
    $('span', node).textContent = detail;
    node.hidden = false;
    playSound(kind === 'summary' ? 'reward' : 'portal');
    say(`${title} ${detail}.`);
    paint();
    return wait(reduceMotion() ? 1400 : turbo ? 1000 : 2200).then(() => { node.hidden = true; });
  }

  /* ─────────── painting ─────────── */

  function paint() {
    if (!root) return;
    paintView();
    paintControls();
    paintStats();
    paintFree();
  }

  function paintMeter(amount) {
    const meter = $(`#${P}Win`, root);
    meter.textContent = amount > 0n ? money(Number(amount)) : '—';
    meter.dataset.on = amount > 0n ? '1' : '0';
  }

  function setAction(label, amount, line = '') {
    $(`#${P}ActionLabel`, root).textContent = label;
    $(`#${P}ActionAmount`, root).textContent = amount;
    $(`#${P}Action`, root).dataset.line = String(line);
    // The lit cells take the same colour as the line being described.
    $('.slots__window', root).dataset.line = String(line);
  }

  function paintControls() {
    const go = $(`#${P}Go`, root);
    const label = $(`#${P}GoLabel`, root);
    const problem = spinProblem();
    let text = `Spin · ${money(Number(stakeMinor() ?? 0n))}`;
    if (!state.authenticated) text = 'Log in to play';
    else if (round?.free) {
      const { played, left } = round.free;
      text = played === 0 || (left === 0 && !spinning) ? `${played + left} free spins` : `Free spin ${played} of ${played + left}`;
    }
    else if (spinning) text = 'Spinning…';
    if (label.textContent !== text) label.textContent = text;
    go.disabled = state.authenticated && (spinning || Boolean(problem));
    go.setAttribute('aria-busy', String(spinning));
    go.dataset.tone = round?.free ? 'free' : 'go';

    const autoButton = $(`#${P}Auto`, root);
    autoButton.setAttribute('aria-pressed', String(auto));
    autoButton.textContent = auto ? 'Stop auto' : 'Auto spin';
    autoButton.disabled = !state.authenticated || (Boolean(problem) && !auto);
    $(`#${P}Turbo`, root).setAttribute('aria-pressed', String(turbo));
    machine?.setFlags({ auto, turbo });
    $(`#${P}Hint`, root).textContent = state.authenticated && !spinning ? problem : '';
    for (const node of root.querySelectorAll('.slots__field input, .slots__adj')) node.disabled = spinning;
  }

  function paintStats() {
    $(`#${P}Spins`, root).textContent = session.spins.toLocaleString('en-US');
    $(`#${P}Won`, root).textContent = money(Number(session.won));
    $(`#${P}Best`, root).textContent = session.best > 0n ? money(Number(session.best)) : '—';
  }

  function paintFree() {
    const bar = $(`#${P}Free`, root);
    const free = round?.free;
    bar.hidden = !free;
    if (!free) return;
    $(`#${P}FreeLeft`, root).textContent = `${free.left} left`;
    $(`#${P}FreeWon`, root).textContent = money(Number(free.won));
  }

  /* One polite, whole sentence per event. */
  function say(text) {
    const node = $(`#${P}Say`, root);
    if (!node) return;
    node.textContent = '';
    requestAnimationFrame(() => { node.textContent = text; });
  }

  /* ─────────── the paytable ─────────── */

  function paytableHtml() {
    if (!config) return '<p class="slotspay__sub">The paytable loads with the machine.</p>';
    const symbols = config.symbols;
    const pays = symbols.filter((s) => s.pays.length).slice().reverse().map((s) => `
      <li class="slotspay__pay">
        <span class="slotspay__icon"><img src="${icon(s.id)}" alt="" /></span>
        <span class="slotspay__name">${s.name}</span>
        <span class="slotspay__row"><b>5 in a row</b>${s.pays[2].toLocaleString('en-US')}×</span>
        <span class="slotspay__row"><b>4 in a row</b>${s.pays[1]}×</span>
        <span class="slotspay__row"><b>3 in a row</b>${s.pays[0]}×</span>
      </li>`).join('');
    const minis = config.lines.map((rows, index) => {
      const dots = [0, 1, 2].map((row) => rows.map((r) => `<i${r === row ? ' data-on="1"' : ''}></i>`).join('')).join('');
      return `<li class="slotspay__mini" data-line="${index}"><span>${index + 1}</span><div>${dots}</div></li>`;
    }).join('');
    const wild = symbolOf(config.wild);
    const book = symbolOf(config.scatter);
    const x = config.scatterPayX;
    const n = config.scatterSpins;
    const rtp = ((10_000 - config.houseEdgeBps) / 100).toFixed(2);
    return `
      <p class="slotspay__sub">Line pays are multiples of the line bet (the stake ÷ 10), left to right from reel one. The best win on each line pays.</p>
      <ul class="slotspay__pays">${pays}</ul>
      <div class="slotspay__specials">
        <div class="slotspay__special" data-kind="wild">
          <span class="slotspay__icon"><img src="${icon(wild.id)}" alt="" /></span>
          <p><b>${wild.name}</b> is wild. ${game.wildNote}</p>
        </div>
        <div class="slotspay__special" data-kind="scatter">
          <span class="slotspay__icon"><img src="${icon(book.id)}" alt="" /></span>
          <p><b>${book.name}</b> pays anywhere: 3 ${game.scatter[1]} pay ${x[3]}× the stake and ${n[3]} free spins, 4 pay ${x[4]}× and ${n[4]}, 5 pay ${x[5]}× and ${n[5]}. Free spins pay ×${config.freeMultiplier} and can retrigger.</p>
        </div>
      </div>
      <h3 class="slotspay__h3">The ten lines</h3>
      <ol class="slotspay__minis">${minis}</ol>
      <p class="slotspay__sub">Returns ${rtp}% of the stake over the long run. A round pays at most ${config.maxWinX.toLocaleString('en-US')}× the stake and plays at most ${config.maxFreeSpins} free spins. Every spin comes from your fairness seed and can be checked on the Fairness page.</p>`;
  }

  function openPaytable() {
    openModal(`${game.title} paytable`, (body) => {
      const wrap = document.createElement('div');
      wrap.className = 'slotspay';
      wrap.innerHTML = paytableHtml();
      body.append(wrap);
    });
  }

  /* ─────────── building ─────────── */

  function build() {
    const reels = [0, 1, 2, 3, 4].map((reel) => `
      <div class="slots__reel" data-reel="${reel}" data-state="idle" role="img" aria-label="Reel ${reel + 1}"><div class="slots__strip"></div></div>`).join('');
    root.dataset.mode = 'base';
    root.dataset.render = '2d';
    root.dataset.machine = game.machine;
    root.innerHTML = `
      <section class="slots__stage" aria-label="The machine">
        <div class="slots__cabinet">
          <i class="slots__corner" data-at="tl"></i><i class="slots__corner" data-at="tr"></i>
          <i class="slots__corner" data-at="bl"></i><i class="slots__corner" data-at="br"></i>
          <header class="slots__marquee">
            <img src="assets/img/items/${game.marquee}.png" alt="" />
            <span class="slots__title">${game.title}</span>
            <img src="assets/img/items/${game.marquee}.png" alt="" data-flip="1" />
          </header>
          <div class="slots__free" id="${P}Free" hidden>
            <img src="${icon(game.scatterId)}" alt="" />
            <span>Free spins</span>
            <b id="${P}FreeLeft"></b>
            <span>Won <b id="${P}FreeWon"></b></span>
          </div>
          <div class="slots__window" data-line="">
            <div class="slots__reels" id="${P}Reels">${reels}</div>
            <svg class="slots__lines" id="${P}Lines" viewBox="0 0 500 300" preserveAspectRatio="none" aria-hidden="true"></svg>
            <div class="slots__fx" id="${P}Fx" aria-hidden="true"></div>
            <p class="slots__splash" id="${P}Splash" hidden></p>
            <div class="slots__banner" id="${P}Banner" hidden><b></b><span></span></div>
          </div>
          <div class="slots__action" id="${P}Action" data-line="">
            <span id="${P}ActionLabel"></span>
            <b id="${P}ActionAmount"></b>
          </div>
          <div class="slots__meter">
            <span>Win</span>
            <b id="${P}Win" data-on="0">—</b>
          </div>
        </div>
        <div class="slots__lever" id="${P}LeverBox" aria-hidden="true">
          <span class="slots__arm" id="${P}Lever"><i></i></span>
          <span class="slots__base"></span>
        </div>
      </section>

      <aside class="slots__panel" aria-label="Your spin">
        <form class="slots__form" id="${P}Form" novalidate>
          <label class="slots__label" for="${P}Stake">Stake</label>
          <div class="slots__field">
            <span aria-hidden="true">$</span>
            <input id="${P}Stake" inputmode="decimal" autocomplete="off" spellcheck="false" />
            <button type="button" class="slots__adj" data-adj="half" aria-label="Halve the stake">½</button>
            <button type="button" class="slots__adj" data-adj="double" aria-label="Double the stake">2×</button>
          </div>
          <button class="btn slots__go" id="${P}Go" type="submit" data-tone="go">
            <span id="${P}GoLabel">Loading…</span>
          </button>
          <div class="slots__toggles">
            <button class="slots__toggle" id="${P}Auto" type="button" aria-pressed="false">Auto spin</button>
            <button class="slots__toggle" id="${P}Turbo" type="button" aria-pressed="false">Turbo</button>
          </div>
          <p class="slots__hint" id="${P}Hint" aria-live="polite"></p>
          <dl class="slots__stats">
            <div><dt>Spins</dt><dd id="${P}Spins"></dd></div>
            <div><dt>Won</dt><dd id="${P}Won"></dd></div>
            <div><dt>Best</dt><dd id="${P}Best"></dd></div>
          </dl>
          <button class="slots__paytable" id="${P}Paytable" type="button">Paytable</button>
          ${viewSwitch(`${P}View`)}
        </form>
      </aside>
      <div class="slots__say" id="${P}Say" role="status" aria-atomic="true"></div>`;

    const stake = $(`#${P}Stake`, root);
    stake.value = stakeText;
    stake.addEventListener('input', () => { stakeText = stake.value; paint(); });
    root.querySelectorAll('.slots__adj').forEach((button) => button.addEventListener('click', () => {
      const current = stakeMinor() ?? 0n;
      stakeText = formatAmountInput(Number(button.dataset.adj === 'half' ? current / 2n : current * 2n));
      stake.value = stakeText;
      paint();
    }));
    $(`#${P}Form`, root).addEventListener('submit', (event) => {
      event.preventDefault();
      void spin();
    });
    $(`#${P}LeverBox`, root).addEventListener('click', () => void spin());
    $(`#${P}Auto`, root).addEventListener('click', () => {
      auto = !auto;
      paintControls();
      if (auto && !spinning) void spin();
      else if (!auto) clearTimeout(nextTimer);
    });
    $(`#${P}Turbo`, root).addEventListener('click', () => { turbo = !turbo; paintControls(); });
    $(`#${P}Paytable`, root).addEventListener('click', openPaytable);
    onViewSwitch($(`#${P}View`, root), setView);
    // The same choice made anywhere else: 2D at once, 3D only for the machine on screen.
    onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });

    /* Space spins, as on every slot machine, but only on this page and never while typing or on a
     * control (a focused button already answers Space itself). */
    document.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || !view || view.hidden || event.repeat) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.target.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) return;
      event.preventDefault();
      void spin();
    });
    // Auto-spin never runs on a page nobody is looking at.
    onNavigate(() => {
      if (view?.hidden) stopAuto();
    });
  }

  return function mount(section) {
    view = section;
    root = $(`#${P}Root`, section);
    if (!root) return;
    if (!root.dataset.built) {
      root.dataset.built = '1';
      build();
      clearWins();
      paintMeter(0n);
      /* A refresh mounts this page before the session check has answered; ready and login are the
       * moments a seed can first be asked for. */
      bus.addEventListener('change', (event) => {
        if (['ready', 'login'].includes(event.detail)) {
          if (!spinning) void load();
          return;
        }
        if (event.detail === 'logout') {
          stopAuto();
          seedHash = null;
        }
        if (!spinning) paint();
      });
    }
    void load();
  }
}

export const mountSlots = createSlotsGame(GAMES['ore-rush']);
export const mountMonument = createSlotsGame(GAMES.monument);
