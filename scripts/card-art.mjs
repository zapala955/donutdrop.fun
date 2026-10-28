#!/usr/bin/env node
/* card-art.mjs — writes the pixel art the API draws win cards with, from the frontend's own files.
 *
 * The win card (services/api-gateway/src/lib/win-card.ts) is drawn on the server, so a card can
 * only ever show a round the database holds. The server has no canvas and no fonts, and needs
 * neither: the card is pixel art, as the site is. This reads the game's bitmap font
 * (assets/img/gui/ascii.png, the sheet mcfont.js draws with) and the donut and wordmark sprites
 * (assets/img/brand/*.svg) and writes them out as plain data the API can paint from.
 *
 *   node scripts/card-art.mjs           rewrite services/api-gateway/src/lib/card-art.ts
 *   node scripts/card-art.mjs --check   exit 1 if it is out of date
 *
 * services/api-gateway/tests/win-card.test.ts runs the same check.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets');
export const OUTPUT = path.join(repo, 'services/api-gateway/src/lib/card-art.ts');

/** Every pixel of a PNG as [r, g, b, a], row by row. Only what the font sheet needs: no interlace. */
function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let header;
  let palette = [];
  let alpha = [];
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i < body.length; i += 3) palette.push([body[i], body[i + 1], body[i + 2]]);
    } else if (type === 'tRNS') {
      alpha = [...body];
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  if (!header || header.interlace !== 0) throw new Error('unsupported PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colour];
  const bitsPerPixel = channels * header.depth;
  const stride = Math.ceil((header.width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel / 8);
  const raw = inflateSync(Buffer.concat(data));
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= step ? line[x - step] : 0;
      const up = previous[x];
      const corner = x >= step ? previous[x - step] : 0;
      const p = left + up - corner;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - corner);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const add = [0, left, up, (left + up) >> 1, paeth][filter];
      line[x] = (line[x] + add) & 0xff;
    }
    rows.push(line);
    previous = line;
  }
  const sample = (line, index) => {
    if (header.depth === 8) return line[index];
    const perByte = 8 / header.depth;
    const shift = 8 - header.depth * ((index % perByte) + 1);
    return (line[Math.floor(index / perByte)] >> shift) & ((1 << header.depth) - 1);
  };
  const pixels = [];
  for (const line of rows) {
    const out = [];
    for (let x = 0; x < header.width; x += 1) {
      if (header.colour === 3) {
        const index = sample(line, x);
        out.push([...(palette[index] ?? [0, 0, 0]), alpha[index] ?? 255]);
      } else if (header.colour === 6) {
        out.push([line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]]);
      } else {
        throw new Error('unsupported PNG colour type');
      }
    }
    pixels.push(out);
  }
  return { width: header.width, height: header.height, pixels };
}

/** Printable ASCII out of the font sheet: each glyph's rows as strings of '#' and '.', as wide as
 * its inked columns, exactly as mcfont.js measures them (a space is four pixels). */
export function glyphs() {
  const sheet = decodePng(readFileSync(path.join(assets, 'img/gui/ascii.png')));
  const cell = sheet.width / 16;
  const out = {};
  for (let code = 32; code < 127; code += 1) {
    const x0 = (code % 16) * cell;
    const y0 = Math.floor(code / 16) * cell;
    let right = -1;
    for (let x = 0; x < cell; x += 1) {
      for (let y = 0; y < cell; y += 1) if (sheet.pixels[y0 + y][x0 + x][3] > 0) right = Math.max(right, x);
    }
    const width = code === 32 ? 4 : right + 1;
    const rows = [];
    for (let y = 0; y < cell; y += 1) {
      let row = '';
      for (let x = 0; x < width; x += 1) row += sheet.pixels[y0 + y][x0 + x][3] > 0 ? '#' : '.';
      rows.push(row);
    }
    out[String.fromCharCode(code)] = rows;
  }
  return { cell, glyphs: out };
}

/** A pixel-art SVG's rects: its grid size and every rect as [x, y, width, height, colour]. */
export function sprite(file) {
  const svg = readFileSync(path.join(assets, 'img/brand', file), 'utf8');
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!box) throw new Error(`${file} has no viewBox`);
  const rects = [];
  for (const match of svg.matchAll(/<rect ([^>]*)\/>/g)) {
    const attr = (name) => new RegExp(`\\b${name}="([^"]+)"`).exec(match[1])?.[1];
    const fill = attr('fill');
    if (!fill || !/^#[0-9a-f]{6}$/i.test(fill)) throw new Error(`${file}: a rect without a plain fill`);
    rects.push([Number(attr('x') ?? 0), Number(attr('y') ?? 0), Number(attr('width')), Number(attr('height')), fill.toLowerCase()]);
  }
  return { width: Number(box[1]), height: Number(box[2]), rects };
}

export function build() {
  const font = glyphs();
  const donut = sprite('donut.svg');
  const wordmark = sprite('wordmark.svg');
  const lines = [
    '/* Generated by scripts/card-art.mjs from the frontend\'s font sheet and brand sprites. Do not edit',
    ' * by hand: change the art there and run `node scripts/card-art.mjs`. */',
    '',
    '/** One rect of a sprite: x, y, width, height on its grid, and its colour. */',
    'export type SpriteRect = readonly [number, number, number, number, string];',
    '',
    'export interface Sprite {',
    '  readonly width: number;',
    '  readonly height: number;',
    '  readonly rects: readonly SpriteRect[];',
    '}',
    '',
    `/** The game's font: each printable ASCII glyph as rows of '#' (ink) and '.', ${font.cell} rows tall. */`,
    `export const GLYPH_HEIGHT = ${font.cell};`,
    `export const GLYPHS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(font.glyphs)};`,
    '',
    `export const DONUT: Sprite = ${JSON.stringify(donut)};`,
    '',
    `export const WORDMARK: Sprite = ${JSON.stringify(wordmark)};`,
    '',
  ];
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const next = build();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8');
    if (current !== next) {
      console.error('services/api-gateway/src/lib/card-art.ts is out of date: run node scripts/card-art.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, next);
  }
}
