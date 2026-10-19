/**
 * blockart.js — a block, drawn the way Minecraft's own inventory draws a block.
 *
 * Crates and items whose art is a block texture (tuff, soul sand, obsidian, end stone …) arrive
 * as the flat face. Beside the item sprites, which are objects with air around them, a full square
 * reads as a hole in the card with twice the weight of anything next to it. The game never shows a
 * block that way in a slot: it draws a small cube seen from above at 30°/45°, the top at full
 * light, the left face at 0.8 and the right at 0.6.
 *
 * This does the same, once per texture. Any <img> under assets/img/block/ or assets/img/items/
 * whose picture is square and fully opaque (a face, not a sprite) has its src swapped for an SVG
 * of that cube. The SVG carries the original texture inline and samples it nearest-neighbour, so
 * it stays pixel-sharp at whatever size the img is shown — 20px in the feed, 96px on a card.
 * Nothing else about the element changes: class, size, alt and listeners stay as they were, so
 * every layout that holds an <img> holds this one. The original path is kept on data-face.
 *
 * A texture meant to be seen as a surface opts out with data-flat on its img. Animated strips
 * (lava, magma: taller than wide) and sprites (any transparent pixel) are left alone by the test.
 */

const FACE_ART = /\/assets\/img\/(?:block|items)\/[a-z0-9_-]+\.png$/;

/** texture path -> cube URL, or null for "not a face". Filled once per path. */
const ready = new Map();
/** texture path -> the pending test, so a page of twenty cards decodes a texture once. */
const pending = new Map();

/* The cube, in a 64-wide box: top rhombus T(32,0) R(64,16) B(32,32) L(0,16), sides 39.2 tall
 * (cos 30° of the edge against the top's sin-45° diagonal, as the inventory projects it). The
 * viewBox is squared around it so an img with object-fit: contain shows it centred, unstretched. */
const VIEWBOX = '-3.6 0 71.2 71.2';
const OUTLINE = '32,0 64,16 64,55.2 32,71.2 0,55.2 0,16';
const FACES = [
  { m: '2 1 -2 1 32 0', shade: null }, // top, full light
  { m: '2 1 0 2.45 0 16', shade: { points: '0,16 32,32 32,71.2 0,55.2', alpha: 0.2 } }, // left, 0.8
  { m: '2 -1 0 2.45 32 32', shade: { points: '32,32 64,16 64,55.2 32,71.2', alpha: 0.4 } }, // right, 0.6
];

export function initBlockArt(root = document.body) {
  for (const img of root.querySelectorAll('img')) swap(img);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        swap(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') swap(node);
        else for (const img of node.querySelectorAll('img')) swap(img);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
}

function swap(img) {
  if (img.tagName !== 'IMG' || img.dataset.flat !== undefined) return;
  const raw = img.getAttribute('src');
  if (!raw || raw.startsWith('data:')) return;
  let path;
  try {
    path = new URL(raw, location.href).pathname;
  } catch {
    return;
  }
  if (!FACE_ART.test(path)) return;

  /* Known already: swap now, inside the observer's microtask, so the flat face never paints. */
  if (ready.has(path)) {
    apply(img, raw, ready.get(path));
    return;
  }
  if (!pending.has(path)) {
    pending.set(
      path,
      faceOf(raw)
        .then((face) => (face ? cubeUrl(face) : null))
        .catch(() => null)
        .then((url) => {
          ready.set(path, url);
          pending.delete(path);
          return url;
        }),
    );
  }
  pending.get(path).then((url) => {
    /* Only if nobody pointed the img somewhere else while the texture was being read. */
    if (img.getAttribute('src') === raw) apply(img, raw, url);
  });
}

function apply(img, raw, url) {
  if (!url) return;
  img.dataset.face = raw;
  img.src = url;
}

/** The texture, if it is a face: square, small enough to be a texture, and opaque everywhere. */
async function faceOf(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const { naturalWidth: w, naturalHeight: h } = image;
  if (!w || w !== h || w > 512) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, w, h);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) return null;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const n = data.length / 4;
  return {
    href: canvas.toDataURL('image/png'),
    /* The cube is laid over its own average colour, so the hairline where two faces meet (the
     * anti-aliased edge of a transformed image) shows the block, not the card behind it. */
    fill: `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`,
  };
}

function cubeUrl({ href, fill }) {
  const faces = FACES.map(({ m, shade }) =>
    `<use href="#t" transform="matrix(${m})"/>` +
    (shade ? `<polygon points="${shade.points}" fill="#000" fill-opacity="${shade.alpha}"/>` : ''),
  ).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">` +
    `<defs><image id="t" width="16" height="16" preserveAspectRatio="none" image-rendering="optimizeSpeed" style="image-rendering:pixelated" href="${href}"/></defs>` +
    `<polygon points="${OUTLINE}" fill="${fill}"/>${faces}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
