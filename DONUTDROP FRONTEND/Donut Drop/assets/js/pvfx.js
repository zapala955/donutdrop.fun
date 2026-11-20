/*
 * pvfx.js — the redesign preview's effects layer, shared by the games.
 *
 * One canvas laid over a game's stage, drawing short-lived particles: Minecraft's own particle
 * sheets (the explosion, smoke, glitter, splash), item sprites (gold nuggets and ingots raining on a
 * big win), squares of colour for a burst, and a floating label for a multiplier. It only draws:
 * nothing here knows the rules or the money, the game calls it at the moment something happened.
 *
 * It idles at no cost (no frame is requested while nothing is in the air), honours the site's and the
 * device's reduced-motion setting, and is removed with the stage by destroy().
 */
import { money, reduceMotion } from './util.js';

const IMG = {};
const SHEETS = { explosion: [16, 32], smoke: [12, 16], glitter: [8, 8], generic: [8, 8], splash: [4, 8], spark: [8, 8] };
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  for (const key of Object.keys(SHEETS)) {
    const image = new Image();
    image.src = `assets/img/fx/${key}.png`;
    IMG[key] = image;
  }
  for (const key of ['gold_nugget', 'gold_ingot', 'feather', 'emerald', 'diamond']) {
    const image = new Image();
    image.src = `assets/img/items/${key}.png`;
    IMG[key] = image;
  }
}

/* A sheet recoloured once per colour, then reused. */
const tints = new Map();
function tinted(key, color) {
  const id = `${key}|${color}`;
  if (tints.has(id)) return tints.get(id);
  const image = IMG[key];
  if (!image?.complete || !image.naturalWidth) return image;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(image, 0, 0);
  tints.set(id, canvas);
  return canvas;
}

const R = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** The site's colours, read once from its tokens. */
export function fxColors() {
  const css = getComputedStyle(document.body);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--lx-ink', '#f5f3ef'),
    gold: v('--lx-gold', '#ffaa00'),
    win: v('--pv-win', '#40c786'),
    loss: v('--lx-loss', '#e5534b'),
    gem: '#8fe3f0',
    ice: '#b9e6ff',
  };
}

/** Lays the effects canvas over `host` (which must be positioned) and returns its drawing calls. */
export function makeFx(host) {
  load();
  const canvas = document.createElement('canvas');
  canvas.className = 'pvfx';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const g = canvas.getContext('2d');
  const parts = [];
  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let dead = false;
  const size = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  };
  const ro = new ResizeObserver(size);
  ro.observe(host);
  size();

  function draw(p, k) {
    const s = p.size * (1 + k * (p.grow || 0));
    g.save();
    g.translate(p.x, p.y);
    if (p.rot) g.rotate(p.rot);
    if (p.kind === 'sq') {
      g.fillStyle = p.color;
      g.fillRect(-s / 2, -s / 2, s, s);
    } else if (p.kind === 'rect') {
      g.globalAlpha *= p.alpha;
      g.fillStyle = p.color;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    } else if (p.kind === 'text') {
      g.font = p.font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(8, 6, 5, .6)';
      g.fillText(p.text, 2, 2);
      g.fillStyle = p.color;
      g.fillText(p.text, 0, 0);
    } else if (p.kind === 'sheet') {
      const [frames, fs] = SHEETS[p.sheet];
      const image = p.color ? tinted(p.sheet, p.color) : IMG[p.sheet];
      const frame = p.frame ?? Math.min(frames - 1, Math.floor(k * frames));
      if (image && (image.width || image.naturalWidth)) g.drawImage(image, frame * fs, 0, fs, fs, -s / 2, -s / 2, s, s);
    } else if (p.kind === 'img') {
      const image = IMG[p.img];
      if (image?.complete && image.naturalWidth) g.drawImage(image, -s / 2, -s / 2, s, s);
    }
    g.restore();
  }

  function loop(now) {
    raf = 0;
    if (dead) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const k = p.t / p.life;
      g.globalAlpha = p.fade ? Math.min(1, (1 - k) * 2.4) : 1;
      draw(p, k);
    }
    g.globalAlpha = 1;
    if (parts.length) raf = requestAnimationFrame(loop);
    else { last = 0; g.clearRect(0, 0, W, H); }
  }

  function add(p) {
    if (dead || reduceMotion() || parts.length > 600) return;
    parts.push({ t: 0, vx: 0, vy: 0, g: 0, drag: 0, rot: 0, vr: 0, life: 1, size: 6, fade: true, delay: 0, ...p });
    if (!raf) raf = requestAnimationFrame(loop);
  }

  return {
    /** The centre of `node`, in the canvas's own coordinates. */
    at(node) {
      const r = node.getBoundingClientRect();
      const s = host.getBoundingClientRect();
      return [r.left - s.left + r.width / 2, r.top - s.top + r.height / 2];
    },
    burst(x, y, { n = 16, colors = ['#fff'], speed = 260, size = 5, g: grav = 700, life = 0.75, up = 120 } = {}) {
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const v = speed * R(0.35, 1);
        add({ kind: 'sq', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, g: grav, drag: 1.2, size: size * R(0.6, 1.3),
          color: colors[i % colors.length], life: life * R(0.6, 1.2), rot: R(0, 3), vr: R(-8, 8) });
      }
    },
    sparkle(x, y, { n = 10, color = '#bdf', spread = 24, size = 14 } = {}) {
      for (let i = 0; i < n; i += 1) {
        add({ kind: 'sheet', sheet: 'glitter', color, x: x + R(-spread, spread), y: y + R(-spread, spread), vy: R(-60, -15),
          size: size * R(0.6, 1.2), life: R(0.45, 0.9), delay: R(0, 0.15), fade: false });
      }
    },
    explode(x, y, { scale = 1 } = {}) {
      for (let i = 0; i < 8; i += 1) {
        add({ kind: 'sheet', sheet: 'explosion', color: pick(['#f2ede6', '#d6cfc6', '#b8b0a6']), x: x + R(-34, 34) * scale,
          y: y + R(-34, 34) * scale, size: R(46, 92) * scale, life: R(0.42, 0.7), delay: i ? R(0, 0.2) : 0, fade: false });
      }
      for (let i = 0; i < 10; i += 1) {
        add({ kind: 'sheet', sheet: 'smoke', color: '#77706a', x: x + R(-30, 30) * scale, y: y + R(-24, 24) * scale,
          vx: R(-30, 30), vy: R(-80, -30), drag: 0.6, size: R(22, 44) * scale, life: R(0.9, 1.6), delay: R(0.1, 0.35) });
      }
      for (let i = 0; i < 14; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const v = R(160, 420) * scale;
        add({ kind: 'sq', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, g: 900, drag: 0.8, size: R(3, 7),
          color: pick(['#3b2a20', '#5a4436', '#8a2e22']), life: R(0.5, 0.9), rot: R(0, 3), vr: R(-10, 10) });
      }
    },
    splash(x, y, { color = '#9bd', n = 14 } = {}) {
      for (let i = 0; i < n; i += 1) {
        const a = R(-Math.PI * 0.9, -Math.PI * 0.1);
        const v = R(120, 300);
        add({ kind: 'sheet', sheet: 'splash', color, x: x + R(-10, 10), y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 900,
          size: R(10, 18), life: R(0.5, 0.8) });
      }
    },
    feathers(x, y, n = 12) {
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const v = R(80, 260);
        add({ kind: 'img', img: 'feather', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, g: 160, drag: 2.2,
          size: R(14, 24), life: R(1, 1.7), rot: R(0, 6), vr: R(-5, 5) });
      }
    },
    puff(x, y, { color = '#8a8580', n = 1, size = 12, vx = 0, vy = -20, life = 0.6 } = {}) {
      for (let i = 0; i < n; i += 1) {
        add({ kind: 'sheet', sheet: 'generic', color, x: x + R(-3, 3), y: y + R(-3, 3), vx: vx + R(-15, 15), vy: vy + R(-10, 10),
          drag: 1.5, size: size * R(0.7, 1.3), life: life * R(0.7, 1.2) });
      }
    },
    /** Gold falling from the top of the stage: a big win. */
    coins(n = 30) {
      for (let i = 0; i < n; i += 1) {
        add({ kind: 'img', img: Math.random() < 0.3 ? 'gold_ingot' : 'gold_nugget', x: R(0.05, 0.95) * W, y: R(-80, -10),
          vx: R(-40, 40), vy: R(60, 220), g: 900, size: R(18, 30), life: R(1.2, 1.8), rot: R(0, 6), vr: R(-6, 6), delay: R(0, 0.5) });
      }
    },
    pop(x, y, img = 'gold_nugget', size = 22) {
      add({ kind: 'img', img, x, y, vy: -260, g: 700, size, life: 0.75 });
    },
    /** A label that rises from a point and fades: a multiplier, a profit. */
    text(x, y, text, { color = '#fff', size = 16, life = 0.9 } = {}) {
      add({ kind: 'text', text, x, y, vy: -110, drag: 2.6, font: `900 ${size}px Archivo, Figtree, sans-serif`, color, life, size: 1 });
    },
    /** A thin line falling past: speed, while a number climbs. `chance` thins them out (0 to 1). */
    streak(color = '#fff', chance = 1) {
      if (W && Math.random() < chance) add({ kind: 'rect', x: R(0, W), y: -60, vy: R(900, 1600), w: R(1.5, 3), h: R(30, 90), color, alpha: R(0.08, 0.22), life: 0.9 });
    },
    shake(node, mag = 7, ms = 420) {
      if (reduceMotion() || !node?.animate) return;
      node.animate(Array.from({ length: 9 }, (_, i) => ({
        transform: i === 8 ? 'none' : `translate(${R(-1, 1) * mag * (1 - i / 9)}px, ${R(-1, 1) * mag * (1 - i / 9)}px)`,
      })), { duration: ms, easing: 'linear' });
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    },
  };
}

/** The stage washes red for a moment: a loss. */
export function hitFlash(node) {
  if (!node || reduceMotion()) return;
  node.classList.remove('pv-hit');
  void node.offsetWidth;
  node.classList.add('pv-hit');
}

/** Counts a figure up from `from` to `to` in `node`, formatted by `format`. */
export function tick(node, from, to, format, ms) {
  if (reduceMotion()) { node.textContent = format(to); return; }
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / ms);
    node.textContent = format(from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  node.textContent = format(from);
  requestAnimationFrame(step);
}

const xLabel = (x) => (x >= 1000 ? `${Math.floor(x).toLocaleString('en-US')}×` : `${x.toFixed(2)}×`);

/**
 * The preview's result card over the middle of `host`: the multiplier counting up from 1.00×, the
 * payout under it, a burst of colour from behind it, and gold raining down on a 10× or better.
 * Returns the card; the caller removes it when the next round starts (or leaves it to clearWin).
 */
export function winCard(host, fx, multiplier, payout) {
  clearWin(host);
  const big = multiplier >= 10;
  const card = document.createElement('div');
  card.className = `pvwin${big ? ' pvwin--big' : ''}`;
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML = '<b></b><span></span>';
  host.append(card);
  tick(card.querySelector('b'), 1, multiplier, xLabel, 560);
  tick(card.querySelector('span'), 0, payout, (v) => money(Math.round(v)), 700);
  if (fx) {
    const c = fxColors();
    const [x, y] = fx.at(card);
    fx.burst(x, y, { n: big ? 48 : 26, colors: [c.win, c.ink, c.gold], speed: big ? 480 : 330, size: 6, g: 800, life: 0.95 });
    if (big) fx.coins(36);
  }
  return card;
}

export function clearWin(host) {
  for (const card of host?.querySelectorAll('.pvwin') ?? []) card.remove();
}

export { xLabel };
