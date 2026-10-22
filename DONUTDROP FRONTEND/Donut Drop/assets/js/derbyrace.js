/* derbyrace.js — how a Mob Derby race runs, worked out the same way wherever it is drawn: the 3D
 * track, the flat lanes, and the order in the page's text.
 *
 * The server says who won and hands over a track seed (sixteen bytes of the race's fairness hash).
 * From the seed every racer gets a finish time -- the winner's the earliest, the rest a little or a
 * lot behind -- and a way of running there: a fast start and a fade, a slow start and a late kick.
 * The leader can change on the way; the winner always crosses first. Nothing here decides anything.
 *
 * And the racers' faces, for the buttons, the log and the flat lanes: each cut from its skin where
 * the model's head box puts its front face, so the pig on the page is the pig on the track.
 */

/** How long the winner takes, in ms, give or take the seed's say. */
export const RACE_MS = 8400;

/** A small seeded generator over the track seed's hex. */
function seeded(hex) {
  let s = 0x9e3779b9;
  for (let i = 0; i < hex.length; i += 1) s = Math.imul(s ^ hex.charCodeAt(i), 0x85ebca6b) ^ (s >>> 13);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The race: for each of `count` racers its finish time and how far along it is at any moment.
 * `winner` is the winning racer's index.
 */
export function raceScript(trackSeed, winner, count = 6) {
  const rand = seeded(String(trackSeed || '0'));
  const winTime = RACE_MS - 500 + rand() * 1000;
  const finish = Array.from({ length: count }, (_, i) => (i === winner ? winTime : winTime + 140 + rand() * 1700));
  const shape = Array.from({ length: count }, (_, i) => {
    // A swell that is never steep enough to run backwards: |A| (2 pi f / 4 + 1) < 1.
    const f = 1 + rand();
    const limit = 0.9 / ((2 * Math.PI * f) / 4 + 1);
    const amp = (0.35 + rand() * 0.65) * limit;
    // The winner comes from behind more often than not: its swell starts below the line.
    const phase = i === winner && rand() < 0.7 ? Math.PI : rand() * Math.PI * 2;
    return { f, amp, phase, react: rand() * 220 };
  });
  /** How far racer `i` is at `ms` after the gate, 0..1 (and a little past, coasting over the line). */
  const progress = (i, ms) => {
    const { f, amp, phase, react } = shape[i];
    const t = ms - react;
    if (t <= 0) return 0;
    const u = t / (finish[i] - react);
    if (u >= 1) return 1 + Math.min(0.06, (u - 1) * 0.25);
    return u + amp * Math.sin(2 * Math.PI * f * u + phase) * u * (1 - u);
  };
  /** The racers in order, leader first, at `ms`. */
  const order = (ms) => Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const da = Math.min(progress(a, ms), 1);
    const db = Math.min(progress(b, ms), 1);
    if (da >= 1 && db >= 1) return finish[a] - finish[b];
    return db - da;
  });
  return { finish, progress, order, duration: Math.max(...finish) };
}

/** Where each racer's face is on its skin: the head box's front, [x, y, w, h], and the skin. */
export const FACES = {
  pig: { skin: 'pig', at: [8, 8, 8, 8] },
  cow: { skin: 'cow', at: [6, 6, 8, 8] },
  sheep: { skin: 'sheep', at: [8, 8, 6, 6] },
  chicken: { skin: 'chicken', at: [3, 3, 4, 6] },
  mooshroom: { skin: 'mooshroom', at: [6, 6, 8, 8] },
  black_sheep: { skin: 'sheep', at: [8, 8, 6, 6], wool: '#1d1d21' },
};

const loadSkin = (name) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = `assets/img/entity/${name}.png`;
});

/** Each racer's face as a data URL, 32 px square, pixel-sharp, for the page. */
export async function faceIcons(ids) {
  const skins = {};
  for (const id of ids) {
    const face = FACES[id];
    if (face && !skins[face.skin]) skins[face.skin] = await loadSkin(face.skin).catch(() => null);
  }
  const out = {};
  for (const id of ids) {
    const face = FACES[id];
    const skin = face && skins[face.skin];
    if (!skin) continue;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const [x, y, w, h] = face.at;
    // The black sheep's face sits a size smaller, in a frame of its black wool.
    const s = Math.floor(32 / Math.max(w, h)) - (face.wool ? 1 : 0);
    const dx = (32 - w * s) / 2;
    const dy = (32 - h * s) / 2;
    if (face.wool) {
      // The black sheep: its wool round its face, in the dye's colour.
      g.fillStyle = face.wool;
      g.fillRect(dx - s, dy - s, (w + 2) * s, (h + 2) * s);
    }
    g.drawImage(skin, x, y, w, h, dx, dy, w * s, h * s);
    out[id] = c.toDataURL();
  }
  return out;
}
