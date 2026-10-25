/* mcfont.js — the game's own bitmap font (font/ascii.png, here gui/ascii.png): 16 x 16 glyphs, each
 * as wide as its inked columns, a pixel between them, and the shadow a pixel down and right at a
 * quarter of the colour, as the game draws chat, item counts and name tags.
 */

/** The font out of its sheet: the glyph cell size and every glyph's width in font pixels. */
export function fontFromImage(image) {
  const c = document.createElement('canvas');
  c.width = image.naturalWidth || image.width;
  c.height = image.naturalHeight || image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const cell = c.width / 16;
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const widths = new Array(256).fill(0);
  for (let code = 0; code < 256; code += 1) {
    const x0 = (code % 16) * cell;
    const y0 = Math.floor(code / 16) * cell;
    let right = -1;
    for (let x = 0; x < cell; x += 1) {
      for (let y = 0; y < cell; y += 1) if (data[((y0 + y) * c.width + x0 + x) * 4 + 3] > 0) right = Math.max(right, x);
    }
    widths[code] = code === 32 ? 4 : right + 1;
  }
  return { image: c, cell, widths, tints: new Map() };
}

/** How wide `text` is in font pixels. */
export function textWidth(font, text) {
  let w = 0;
  for (const ch of text) w += font.widths[ch.charCodeAt(0) & 255] + 1;
  return Math.max(0, w - 1);
}

/** The game's text shadow: the colour at a quarter of its brightness. */
function shadowOf(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const q = (v) => Math.floor(v / 4).toString(16).padStart(2, '0');
  return `#${q((n >> 16) & 255)}${q((n >> 8) & 255)}${q(n & 255)}`;
}

/** Draws `text` at `px` canvas pixels a font pixel, with the game's shadow unless asked not to. */
export function drawText(g, font, text, x, y, px, color = '#ffffff', shadow = true) {
  const sheet = (fill) => {
    if (!font.tints.has(fill)) {
      const t = document.createElement('canvas');
      t.width = font.image.width;
      t.height = font.image.height;
      const tg = t.getContext('2d');
      tg.drawImage(font.image, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = fill;
      tg.fillRect(0, 0, t.width, t.height);
      font.tints.set(fill, t);
    }
    return font.tints.get(fill);
  };
  const size = 8 * px;
  const run = (sheetCanvas, ox, oy) => {
    let at = x;
    for (const ch of text) {
      const code = ch.charCodeAt(0) & 255;
      g.drawImage(sheetCanvas, (code % 16) * font.cell, Math.floor(code / 16) * font.cell, font.cell, font.cell, at + ox, y + oy, size, size);
      at += (font.widths[code] + 1) * px;
    }
  };
  g.imageSmoothingEnabled = false;
  if (shadow) run(sheet(shadowOf(color)), px, px);
  run(sheet(color), 0, 0);
}
