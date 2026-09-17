/* reel.js — the case-opening scroll.
 *
 * A horizontal reel of items races past a fixed centre marker, decelerates,
 * overshoots, rocks back over the last few candidates and settles on the
 * winner. It is the CS:GO case opening, and the reason that interaction has
 * survived a decade unchanged is that the tension lives entirely in the
 * deceleration curve — not in the art, not in the sound, in the curve.
 *
 * WHY A CANVAS AND NOT A DOM STRIP
 * --------------------------------
 * A DOM reel is the obvious build: a flex row, one transform, a CSS transition
 * with a bezier on it. It also cannot do the two things that make this read as
 * physical. It cannot motion-blur the tiles while they are moving fast, because
 * a CSS filter blurs the whole strip uniformly including the tiles that are
 * nearly stopped. And it cannot cheaply tell you WHICH tile is crossing the
 * marker on this frame, which is what the tick sound is keyed to. On a canvas
 * both are a subtraction: position minus previous position.
 *
 * THE MOTION
 * ----------
 * Three phases on one timeline, in seconds:
 *
 *   race       constant-speed blur — nothing is legible, and that is the point
 *   brake      a long bezier deceleration onto a deliberate overshoot
 *   settle     a damped oscillation that rocks back across the winner
 *
 * The overshoot is not decoration. A reel that eases straight onto its target
 * reads as a number being assigned; a reel that goes slightly too far and has
 * to come back reads as a physical thing with mass that was stopped by
 * friction. The settle is a decaying sine, so it crosses the winner two or
 * three times before it dies — each crossing ticks, which is the sound everyone
 * actually remembers from this interaction.
 */
import { RARITY } from './data.js';
import { $, el, money, reduceMotion, drawItem } from './util.js';
import { play } from './audio.js';
import { clamp01, span, bezier, blit, tint, radial, pool, img, deviolet } from './fx.js';

/* ── the timeline ── */
const T_RACE = 1.45;
const T_BRAKE = 2.85;
const T_SETTLE = 1.30;
const DUR = T_RACE + T_BRAKE + T_SETTLE;

/* The brake curve. Front-loaded almost to the point of absurdity: it sheds most
 * of its speed in the first third of the beat and then crawls the rest, which
 * is what produces the long agonising drift onto the marker. A symmetrical
 * ease-out arrives too confidently and the whole thing deflates. */
const BRAKE = bezier(0.04, 0.62, 0.10, 1.00);

/* The crawl. Nearly linear so the last stretch does not stall dead and then
 * lurch — it creeps at an almost constant walking pace and stops. An ease-out
 * here would asymptote, which looks like the animation has hung. */
const CRAWL = bezier(0.25, 0.55, 0.45, 1.00);

/* How many tiles sit between the start of the reel and the winner. Long enough
 * that the race phase never shows the end of the strip. */
const RUN = 46;
const WIN_AT = RUN - 6;            // the winner, with a few tiles left behind it

/* ── one tile ──
 * Pre-rendered per item, once. A tile is a rounded rectangle, a rarity wash, a
 * top bar and a sprite; rebuilding that per frame for thirty visible tiles is
 * thirty gradient rasterisations a frame, which is exactly the mistake that
 * cost this project its frame budget once already. */
const tileCache = new Map();
function tileFor(item, w, h, dpr) {
  const key = `${item.id}@${w}x${h}@${dpr}`;
  let c = tileCache.get(key);
  if (c) return c;

  c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  const rar = RARITY[item.rarity].color;
  const r = 4;

  // body: gunmetal, with the rarity bled up from the floor of the tile
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(26,30,36,.96)');
  g.addColorStop(0.55, 'rgba(16,19,23,.96)');
  g.addColorStop(1, 'rgba(10,12,15,.98)');
  x.beginPath();
  x.roundRect(1, 1, w - 2, h - 2, r);
  x.fillStyle = g;
  x.fill();

  const wash = x.createLinearGradient(0, h, 0, h * 0.35);
  wash.addColorStop(0, rar + '3a');
  wash.addColorStop(1, rar + '00');
  x.fillStyle = wash;
  x.fill();

  // the rarity bar along the top edge — the read at speed is this bar, not art
  x.save();
  x.beginPath();
  x.roundRect(1, 1, w - 2, h - 2, r);
  x.clip();
  x.fillStyle = rar;
  x.fillRect(0, 0, w, 3);
  x.restore();

  x.strokeStyle = 'rgba(150,176,196,.16)';
  x.lineWidth = 1;
  x.beginPath();
  x.roundRect(1.5, 1.5, w - 3, h - 3, r);
  x.stroke();

  tileCache.set(key, c);
  return c;
}

/* ── the gold slot ──
 *
 * THE CATEGORY TEASE.
 *
 * When the roll is top-tier, the winning tile is NOT the item. It is a gold
 * slot with a question mark on it, and the reel locks onto that. The player
 * learns instantly that they secured a legendary — the whole dopamine spike of
 * "I got one" — while the question of WHICH one stays open for the cinematic
 * that follows.
 *
 * This is the single most effective thing CS:GO does, and the reason is that it
 * splits one payoff into two: the tier lands on the ticker, the identity lands
 * on the reveal. One event becomes two, and the gap between them is where the
 * tension lives. Showing the item on the ticker collapses both into a moment
 * that is over before the player has finished reading it.
 *
 * It is not a lie. The tier shown is the real tier of the real item that was
 * already drawn; the only thing withheld is which item inside that tier, and
 * the next beat answers it.
 */
let goldTile = null;
/* ── mystery teaser padding ──
 *
 * How much of the visible strip is drawn as a golden `?` rather than as an item.
 *
 * This is DECORATION, and it is worth being precise about why that matters. The strip's other
 * tiles are rolled from the crate's real weighted pool, so what scrolls past is made of outcomes
 * that could genuinely have happened. These are not: at one in ninety thousand, a truthful strip
 * would show the `?` roughly never, and the brief asks for it to appear often enough to build
 * tension on the approach.
 *
 * Over-representing a jackpot symbol next to the payline is a recognised gambling dark pattern —
 * it is the mechanism behind "near miss" psychology, and several regulators treat manufacturing
 * it as a deceptive practice. It is implemented here because it was specified, and it is
 * mitigated in the one way that actually answers the objection: the reel header carries the
 * crate’s REAL mystery odds, in figures, for the entire spin. A player can see a question mark
 * go past and the words "1 in 93,390" at the same time, so the decoration cannot be mistaken for
 * the rate. Setting this to 0 turns the padding off entirely.
 *
 * A COUNT, not a rate.
 *
 * A per-tile probability was the wrong control. It is unbounded, so the number that actually
 * appeared swung from spin to spin, and the unlucky ones still showed a cluster — independent
 * coin flips are precisely the thing that clumps. Tuning it down twice (0.18, then 0.06) moved
 * the average without ever removing the clumping, which is why it still looked frequent.
 *
 * One tile per strip, placed once, is what rare actually looks like: a single question mark
 * drifts past early in the spin and then nothing. The SERVER odds are untouched by this number;
 * it moves nothing but the artwork.
 */
const MYSTERY_TEASER_COUNT = 1;

/* Teasers are confined to the first half of the strip — the part that flies past while the reel
 * is still at speed. Nothing decorative belongs near the pointer: a gold tile beside the marker
 * as the reel settles reads as "you were one tile away", which is not true, and that specific
 * lie is the near-miss pattern regulators object to. */
const TEASER_ZONE_END = 0.5;

function goldFor(w, h, dpr) {
  const key = `gold@${w}x${h}@${dpr}`;
  if (goldTile && goldTile.key === key) return goldTile.c;

  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  const r = 4;

  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(92,62,6,.96)');
  g.addColorStop(0.5, 'rgba(46,30,4,.96)');
  g.addColorStop(1, 'rgba(22,14,2,.98)');
  x.beginPath();
  x.roundRect(1, 1, w - 2, h - 2, r);
  x.fillStyle = g;
  x.fill();

  const wash = x.createLinearGradient(0, h, 0, h * 0.3);
  wash.addColorStop(0, 'rgba(255,170,0,.4)');
  wash.addColorStop(1, 'rgba(255,170,0,0)');
  x.fillStyle = wash;
  x.fill();

  x.save();
  x.beginPath();
  x.roundRect(1, 1, w - 2, h - 2, r);
  x.clip();
  x.fillStyle = '#ffaa00';
  x.fillRect(0, 0, w, 4);
  x.restore();

  // the glyph: a question mark, because that is literally the proposition
  x.fillStyle = 'rgba(255,214,138,.92)';
  x.font = `800 ${Math.round(h * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('?', w / 2, h * 0.52);

  x.strokeStyle = 'rgba(255,170,0,.55)';
  x.lineWidth = 1.5;
  x.beginPath();
  x.roundRect(1.5, 1.5, w - 3, h - 3, r);
  x.stroke();

  goldTile = { key, c };
  return c;
}

/* ── the module ── */
let pane = null;
let assets = null;

async function build() {
  if (pane) return;
  pane = el('div', 'reel');
  pane.hidden = true;
  pane.innerHTML = `
    <div class="reel__head">
      <span class="reel__kicker mono" id="reelCrate"></span>
      <span class="reel__sub mono">rolling the published weights</span>
      <span class="reel__odds mono" id="reelOdds"></span>
    </div>
    <div class="reel__stage">
      <canvas class="reel__cv" id="reelCv"></canvas>
      <div class="reel__marker" aria-hidden="true"></div>
    </div>
    <div class="reel__copy" id="reelCopy">
      <span class="reel__tier mono" id="reelTier"></span>
      <span class="reel__name" id="reelName"></span>
      <span class="reel__val mono" id="reelVal"></span>
      <button class="btn btn--go btn--lg" id="reelBtn">Collect</button>
    </div>`;
  document.body.appendChild(pane);
  assets = {
    flare: radial([
      [0, 'rgba(255,255,255,.8)'], [0.3, 'rgba(255,190,80,.4)'],
      [0.7, 'rgba(255,150,0,.1)'], [1, 'rgba(255,140,0,0)'],
    ]),
  };
}

export function warmReel() { return build().catch(() => null); }

/**
 * Run the reel and resolve when the player dismisses it.
 *
 * `winner` is decided by the caller, before a single frame is drawn — the reel
 * is presentation, never the draw. Anything else would mean the animation could
 * disagree with the balance that has already moved.
 */
export function playReel({
  item, crate, pool: itemPool, mystery = false, mysteryOdds = 0,
}) {
  return build().then(() => new Promise((resolve) => {
    const reduce = reduceMotion();
    const canvas = $('#reelCv', pane);
    const ctx = canvas.getContext('2d');
    const copy = $('#reelCopy', pane);
    const rar = RARITY[item.rarity];

    pane.hidden = false;
    pane.dataset.rarity = item.rarity;
    pane.dataset.mystery = mystery ? '1' : '0';
    pane.style.setProperty('--rar', rar.color);
    copy.dataset.on = '0';
    pane.dataset.locked = '0';
    $('#reelCrate', pane).textContent = crate ? crate.name.toUpperCase() : 'OPENING';

    /* The real odds, on screen for the whole spin.
     *
     * The strip is padded with decorative question marks (see MYSTERY_TEASER_COUNT), so this line
     * is what keeps the padding from misleading anyone: the figure beside it is the crate's
     * actual, server-enforced mystery probability, read from the crate's own published metadata
     * rather than assumed. If the odds are unknown the line stays empty instead of guessing. */
    const oddsNode = $('#reelOdds', pane);
    const denominator = Number(mysteryOdds) || Number(crate?.metadata?.mystery?.oddsDenominator) || 0;
    oddsNode.textContent = denominator > 1
      ? `mystery slot 1 in ${Math.round(denominator).toLocaleString('en-US')}`
      : '';
    /* On a tease the copy names the TIER and nothing else. Printing the item
     * here would hand back exactly what the gold slot is withholding. */
    if (mystery) {
      $('#reelTier', pane).textContent = 'TOP TIER SECURED';
      $('#reelName', pane).textContent = 'Unidentified';
      $('#reelName', pane).style.color = '#ffaa00';
      $('#reelVal', pane).textContent = 'opening…';
    } else {
      $('#reelTier', pane).textContent = rar.name.toUpperCase();
      $('#reelName', pane).textContent = item.name;
      $('#reelName', pane).style.color = rar.color;
      $('#reelVal', pane).textContent = money(item.value);
    }

    /* Fill the strip. Every tile except the winner's slot is rolled from the
     * same weighted pool the real draw uses, so the reel you watch is made of
     * outcomes that could genuinely have happened — a strip padded with junk
     * would quietly tell you the rare tiles are decoration. */
    const strip = [];
    /* Which slots are drawn as a golden `?` rather than as their item. The winning slot is one of
     * them only on a real mystery win; the rest are the decorative padding. */
    const teaser = new Array(RUN).fill(false);
    for (let i = 0; i < RUN; i += 1) {
      strip.push(i === WIN_AT ? item : drawItem(itemPool && itemPool.length ? itemPool : [item]));
    }

    /* Place exactly MYSTERY_TEASER_COUNT of them, inside the early zone, never on the winner.
     * Drawn without replacement, so asking for more than one cannot land two on the same tile and
     * quietly produce fewer than requested. */
    const zoneEnd = Math.max(1, Math.floor(RUN * TEASER_ZONE_END));
    const candidates = [];
    for (let i = 0; i < zoneEnd; i += 1) if (i !== WIN_AT) candidates.push(i);
    for (let placed = 0; placed < MYSTERY_TEASER_COUNT && candidates.length > 0; placed += 1) {
      const pick = (Math.random() * candidates.length) | 0;
      const slot = candidates[pick];
      if (slot !== undefined) teaser[slot] = true;
      candidates.splice(pick, 1);
    }

    const sprites = new Map();
    for (const it of new Set(strip)) {
      img(it.img).then((im) => { if (im) sprites.set(it.id, deviolet(im)); });
    }

    const sparks = pool(90);
    sparks.clear();

    let W = 0, H = 0, dpr = 1, TILE = 0, GAP = 0, PITCH = 0;
    const fit = () => {
      const stage = canvas.parentElement;
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return false;
      const d = Math.min(2, devicePixelRatio || 1);
      if (w === W && h === H && d === dpr) return true;
      W = w; H = h; dpr = d;
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
      TILE = Math.round(Math.min(h * 0.82, 128));
      GAP = Math.round(TILE * 0.10);
      PITCH = TILE + GAP;
      return true;
    };

    /* ── the physics ──
     *
     * MONOTONIC. The offset only ever increases. An earlier build ended on a
     * decaying cosine about the winner, so the strip genuinely reversed two or
     * three times before dying — and a reel that spins backwards does not read
     * as momentum, it reads as a bug, because no physical wheel with friction
     * on it has ever gone back the way it came. The suspense that oscillation
     * was reaching for is now in the crawl instead, which is where it belongs.
     *
     * Three phases, all forward:
     *
     *   race    constant speed. Nothing is legible and that is the point.
     *   brake   a long bezier decel that sheds 97% of the distance.
     *   crawl   the last sliver — under a tile's width — spread over more than
     *           a second, so the strip inches past the borderline of the last
     *           few tiles at walking pace before it stops.
     *
     * `total` is the distance from tile 0 to the winner dead-centre, so the
     * motion is identical at any tile size or viewport width. */
    let total = 0;
    const plan = () => { total = WIN_AT * PITCH; };

    /* Where each phase hands over, as a fraction of the whole distance. The
     * crawl gets 1.6% of the travel and 23% of the running time, which is the
     * entire trick: a near-stop that is still visibly moving. */
    const RACE_END = 0.55;
    const BRAKE_END = 0.984;

    const offsetAt = (t) => {
      if (t <= T_RACE) {
        return total * RACE_END * (t / T_RACE);
      }
      if (t <= T_RACE + T_BRAKE) {
        const k = BRAKE(span(t, [T_RACE, T_RACE + T_BRAKE]));
        return total * (RACE_END + (BRAKE_END - RACE_END) * k);
      }
      const k = CRAWL(span(t, [T_RACE + T_BRAKE, DUR]));
      return total * (BRAKE_END + (1 - BRAKE_END) * k);
    };

    let t = 0;
    let raf = 0;
    let last = performance.now();
    let prevOffset = 0;
    let lastTickIndex = -1;
    let lockT = -1;
    const cues = new Set();

    function frame() {
      const now = performance.now();
      let dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (window.__reelSeek != null) { t = window.__reelSeek; dt = 1 / 60; }
      else t += dt;
      if (!fit()) { raf = requestAnimationFrame(frame); return; }
      plan();

      const cx = W / 2;
      const cy = H / 2;
      const offset = reduce ? total : offsetAt(Math.min(t, DUR));
      const speed = Math.abs(offset - prevOffset) / Math.max(dt, 1e-4);   // px/sec
      prevOffset = offset;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;

      /* Which tile is under the marker right now. Ticking on a change of index
       * rather than on a timer means the ticks slow down exactly as the reel
       * does, with no separate rhythm to keep in sync. Motion is monotonic, so
       * the index only ever climbs and a tick can never fire twice for the same
       * boundary. */
      const centreIndex = Math.round(offset / PITCH);
      if (centreIndex > lastTickIndex && t < DUR) {
        lastTickIndex = centreIndex;
        if (!reduce && speed < 5200) {
          // the faster it goes the quieter and higher each tick, or the race
          // phase is a machine gun
          const k = clamp01(1 - speed / 5200);
          play('click', { volume: 0.06 + k * 0.3, rate: 1.5 - k * 0.45 });
        }
      }

      /* Motion blur, as horizontal ghosting. Each tile is redrawn a few times
       * along its own travel for this frame, which is exactly what a shutter
       * integrating over the interval would capture. It is per-tile rather than
       * per-strip, so a tile near the marker at the end stays crisp while one
       * at the edge is still smeared. */
      const blur = clamp01(speed / 2600);
      const ghosts = reduce ? 0 : Math.round(blur * 5);
      const travel = speed * dt;

      const first = Math.max(0, Math.floor((offset - cx) / PITCH) - 1);
      const lastI = Math.min(strip.length - 1, Math.ceil((offset + cx) / PITCH) + 1);

      for (let i = first; i <= lastI; i++) {
        const it = strip[i];
        if (!it) continue;
        const x = cx + i * PITCH - offset;
        if (x < -PITCH || x > W + PITCH) continue;

        // tiles away from the marker sit back in depth
        const away = Math.min(1, Math.abs(x - cx) / (W * 0.5));
        const scale = 1 - away * 0.14;
        const tw = TILE * scale, th = TILE * scale;
        /* On a tease the winner's slot is the gold tile and carries no sprite
         * at all — the item is never drawn onto this canvas, so there is
         * nothing that can be glimpsed at speed or caught in a frame grab. */
        /* A gold slot carries NO sprite — not the winner's and not a teaser's. On the winning
         * slot that is a security property: the item is never drawn onto this canvas, so there is
         * nothing to glimpse as the strip decelerates and nothing to recover from a frame grab.
         * On a teaser it is what makes the padding indistinguishable from the real thing, which
         * is the entire point of padding. */
        const isPrize = mystery && i === WIN_AT;
        const isGold = isPrize || teaser[i] === true;
        const tile = isGold ? goldFor(TILE, TILE, dpr) : tileFor(it, TILE, TILE, dpr);
        const sprite = isGold ? null : sprites.get(it.id);

        for (let g = ghosts; g >= 0; g--) {
          const gx = x - (travel * g) / (ghosts + 1);
          const alpha = g === 0 ? 1 : (0.32 * blur * (1 - g / (ghosts + 1)));
          ctx.save();
          ctx.globalAlpha = alpha * (1 - away * 0.45);
          ctx.drawImage(tile, gx - tw / 2, cy - th / 2, tw, th);
          if (sprite) blit(ctx, sprite, gx, cy + th * 0.04, th * 0.62);
          ctx.restore();
        }

        /* the gold slot breathes on the strip, so it is visibly different from
         * the ordinary tiles even while it is racing past */
        if (isPrize && assets.flare) {
          const pulse = 0.45 + 0.3 * Math.sin(t * 5.5);
          const fs = tw * (1.7 + pulse * 0.35);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = pulse * (1 - away * 0.6);
          ctx.drawImage(assets.flare, x - fs / 2, cy - fs / 2, fs, fs);
          ctx.restore();
        }
      }

      /* ── the lock ── */
      if (t >= DUR && lockT < 0) {
        lockT = 0;
        pane.dataset.locked = '1';
        play('levelup', { volume: mystery ? 0.62 : 0.5 });
        play('click', { volume: 0.5, rate: 0.8 });
        copy.dataset.on = '1';
        for (let i = 0; i < (mystery ? 60 : 34); i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
          const sp = 90 + Math.random() * 260;
          sparks.spawn(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
            0.5 + Math.random() * 0.6, 2 + Math.random() * 3, i % 3 === 0 ? 1 : 0);
        }
      }

      // the winning tile's frame, struck on lock and held
      if (lockT >= 0) {
        lockT += dt;
        const pop = Math.max(0, 1 - lockT / 0.45);
        const fw = TILE * (1 + pop * 0.14);
        ctx.save();
        // the frame takes the gold of the tier, not the colour of the hidden item
        ctx.strokeStyle = mystery ? '#ffaa00' : rar.color;
        ctx.lineWidth = 2 + pop * 3;
        ctx.globalAlpha = 0.55 + pop * 0.45;
        ctx.beginPath();
        ctx.roundRect(cx - fw / 2, cy - fw / 2, fw, fw, 5);
        ctx.stroke();
        if (pop > 0 && assets.flare) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = pop * 0.7;
          const s = TILE * (2 + pop);
          ctx.drawImage(assets.flare, cx - s / 2, cy - s / 2, s, s);
        }
        ctx.restore();
      }

      sparks.step(dt, 520, 0.6);
      sparks.draw(ctx, ['#ffaa00', '#ffd700'], true);

      if (reduce && !cues.has('copy')) { cues.add('copy'); copy.dataset.on = '1'; pane.dataset.locked = '1'; }
      raf = requestAnimationFrame(frame);
    }

    const done = () => {
      cancelAnimationFrame(raf);
      $('#reelBtn', pane).removeEventListener('click', done);
      pane.hidden = true;
      resolve();
    };
    $('#reelBtn', pane).addEventListener('click', done);
    raf = requestAnimationFrame(frame);
  }));
}
