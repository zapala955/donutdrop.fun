/*
 * slither-renderer.js — a deliberately small 2D WebGL renderer.
 *
 * The arena is made from instanced quads. A tiny signed-distance fragment shader turns one quad
 * into a flat circle, so every body segment, head, eye, boost trail and arena marker shares one
 * GPU buffer and one draw call. Orbs use a second instanced buffer and a texture atlas painted once
 * at startup. The matte hex floor is one static repeating texture. A populated frame therefore
 * costs three draw calls, independent of the number of snakes or pickups on screen.
 */

const TAU = Math.PI * 2;
const DPR_CAP = 1.5;
const MAX_SEGMENTS_PER_RUN = 72;
const CULL_GUARD = 96;
const VIEW_HALF_WIDTH_MIN = 620;
const VIEW_HALF_WIDTH_MAX = 880;
const DEFAULT_MIN_STAKE = 1_000_000;
const DEFAULT_MAX_STAKE = 100_000_000;
const BASE_RADIUS = 13;
const RADIUS_SPAN = 31;

/** How far back the boost glow reaches, in resampled segments. A tail, not a second body. */
const BOOST_TRAIL_SEGMENTS = 18;

const ITEM_SNAKE = 0;
const ITEM_ORB = 1;
const ITEM_NAME = 2;

const OBSIDIAN = [10 / 255, 10 / 255, 12 / 255];
const CHARCOAL = [18 / 255, 18 / 255, 22 / 255];
const GOLD = [1, 170 / 255, 0];
const GOLD_BRIGHT = [1, 215 / 255, 0];
const WALL_RED = [192 / 255, 57 / 255, 43 / 255];

/**
 * Constant-cost logarithmic stake sizing used when an older snapshot has no authoritative radius.
 * Current servers send the same logarithmically-derived radius with every snake, so the visual and
 * collision silhouettes remain identical.
 */
export function logStakeRadius(
  valueMinor,
  minMinor = DEFAULT_MIN_STAKE,
  maxMinor = DEFAULT_MAX_STAKE,
) {
  const min = Math.max(2, Number(minMinor) || DEFAULT_MIN_STAKE);
  const max = Math.max(min + 1, Number(maxMinor) || DEFAULT_MAX_STAKE);
  const value = Math.max(1, Number(valueMinor) || min);
  const t = (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return BASE_RADIUS + RADIUS_SPAN * Math.max(0, Math.min(1.35, t));
}

function overlaps(a, b) {
  return !(
    a.maxX < b.minX ||
    a.minX > b.maxX ||
    a.maxY < b.minY ||
    a.minY > b.maxY
  );
}

/** A compact loose quadtree rebuilt once per 20 Hz network snapshot, never once per render frame. */
export class QuadTree {
  constructor(bounds, capacity = 16, maxDepth = 7, depth = 0) {
    this.bounds = bounds;
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.items = [];
    this.children = null;
  }

  insert(item) {
    if (!overlaps(this.bounds, item)) return false;
    if (this.children) {
      const child = this.childFor(item);
      if (child) return child.insert(item);
    }
    this.items.push(item);
    if (!this.children && this.items.length > this.capacity && this.depth < this.maxDepth) {
      this.split();
    }
    return true;
  }

  query(range, output) {
    if (!overlaps(this.bounds, range)) return output;
    for (const item of this.items) if (overlaps(item, range)) output.push(item);
    if (this.children) for (const child of this.children) child.query(range, output);
    return output;
  }

  childFor(item) {
    const midX = (this.bounds.minX + this.bounds.maxX) * 0.5;
    const midY = (this.bounds.minY + this.bounds.maxY) * 0.5;
    const left = item.maxX <= midX;
    const right = item.minX >= midX;
    const top = item.maxY <= midY;
    const bottom = item.minY >= midY;
    if ((!left && !right) || (!top && !bottom)) return null;
    return this.children[(bottom ? 2 : 0) + (right ? 1 : 0)];
  }

  split() {
    const { minX, minY, maxX, maxY } = this.bounds;
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;
    this.children = [
      new QuadTree({ minX, minY, maxX: midX, maxY: midY }, this.capacity, this.maxDepth, this.depth + 1),
      new QuadTree({ minX: midX, minY, maxX, maxY: midY }, this.capacity, this.maxDepth, this.depth + 1),
      new QuadTree({ minX, minY: midY, maxX: midX, maxY }, this.capacity, this.maxDepth, this.depth + 1),
      new QuadTree({ minX: midX, minY: midY, maxX, maxY }, this.capacity, this.maxDepth, this.depth + 1),
    ];
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      const child = this.childFor(item);
      if (!child) continue;
      this.items.splice(index, 1);
      child.insert(item);
    }
  }
}

const GRID_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner, 0.0, 1.0);
}`;

const GRID_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_grid;
uniform vec2 u_viewport;
uniform vec2 u_focus;
uniform float u_unit;
uniform vec2 u_tile_world;
out vec4 out_color;
void main() {
  vec2 pixel = gl_FragCoord.xy - u_viewport * 0.5;
  vec2 world = u_focus + vec2(pixel.x, -pixel.y) / u_unit;
  out_color = texture(u_grid, world / u_tile_world);
}`;

const CIRCLE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 i_center;
layout(location = 2) in float i_radius;
layout(location = 3) in vec4 i_fill;
layout(location = 4) in vec4 i_stroke;
layout(location = 5) in float i_stroke_px;
uniform vec2 u_viewport;
uniform vec2 u_focus;
uniform float u_unit;
out vec2 v_local;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out float v_stroke_ratio;
void main() {
  vec2 pixel = (i_center + a_corner * i_radius - u_focus) * u_unit;
  gl_Position = vec4(pixel.x / (u_viewport.x * 0.5), -pixel.y / (u_viewport.y * 0.5), 0.0, 1.0);
  v_local = a_corner;
  v_fill = i_fill;
  v_stroke = i_stroke;
  v_stroke_ratio = clamp(i_stroke_px / max(1.0, i_radius * u_unit), 0.0, 1.0);
}`;

const CIRCLE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_local;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in float v_stroke_ratio;
out vec4 out_color;
void main() {
  float distance_to_center = length(v_local);
  float aa = max(fwidth(distance_to_center), 0.0015);
  float coverage = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, distance_to_center);
  float fill_edge = 1.0 - v_stroke_ratio;
  float fill_mix = 1.0 - smoothstep(fill_edge - aa, fill_edge + aa, distance_to_center);
  vec4 color = mix(v_stroke, v_fill, fill_mix);
  color.a *= coverage;
  if (color.a < 0.002) discard;
  out_color = color;
}`;

const SPRITE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 i_center;
layout(location = 2) in float i_size;
layout(location = 3) in float i_kind;
uniform vec2 u_viewport;
uniform vec2 u_focus;
uniform float u_unit;
out vec2 v_uv;
void main() {
  vec2 pixel = (i_center + a_corner * i_size * 0.5 - u_focus) * u_unit;
  gl_Position = vec4(pixel.x / (u_viewport.x * 0.5), -pixel.y / (u_viewport.y * 0.5), 0.0, 1.0);
  vec2 local_uv = a_corner * 0.5 + 0.5;
  v_uv = vec2((local_uv.x + i_kind) * 0.5, local_uv.y);
}`;

const SPRITE_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
out vec4 out_color;
void main() {
  vec4 color = texture(u_atlas, v_uv);
  if (color.a < 0.01) discard;
  out_color = color;
}`;

function shader(webgl, type, source) {
  const compiled = webgl.createShader(type);
  webgl.shaderSource(compiled, source);
  webgl.compileShader(compiled);
  if (!webgl.getShaderParameter(compiled, webgl.COMPILE_STATUS)) {
    const detail = webgl.getShaderInfoLog(compiled) || 'unknown shader error';
    webgl.deleteShader(compiled);
    throw new Error(detail);
  }
  return compiled;
}

function program(webgl, vertexSource, fragmentSource) {
  const vertex = shader(webgl, webgl.VERTEX_SHADER, vertexSource);
  const fragment = shader(webgl, webgl.FRAGMENT_SHADER, fragmentSource);
  const linked = webgl.createProgram();
  webgl.attachShader(linked, vertex);
  webgl.attachShader(linked, fragment);
  webgl.linkProgram(linked);
  webgl.deleteShader(vertex);
  webgl.deleteShader(fragment);
  if (!webgl.getProgramParameter(linked, webgl.LINK_STATUS)) {
    const detail = webgl.getProgramInfoLog(linked) || 'unknown program link error';
    webgl.deleteProgram(linked);
    throw new Error(detail);
  }
  return linked;
}

/**
 * Resolves a program's uniform locations once.
 *
 * `getUniformLocation` is a synchronous query into the driver and its answer cannot change after a
 * link, so asking for it inside the draw path — which is where these lookups used to live — bought
 * nothing and cost ten round trips a frame.
 */
function uniformLocations(webgl, linked, names) {
  const map = {};
  for (const name of names) map[name] = webgl.getUniformLocation(linked, name);
  return map;
}

function createBatch(webgl, stride, initialCapacity) {
  const buffer = webgl.createBuffer();
  const batch = {
    buffer,
    stride,
    capacity: initialCapacity,
    count: 0,
    data: new Float32Array(stride * initialCapacity),
  };
  webgl.bindBuffer(webgl.ARRAY_BUFFER, buffer);
  webgl.bufferData(webgl.ARRAY_BUFFER, batch.data.byteLength, webgl.DYNAMIC_DRAW);
  return batch;
}

function reserve(webgl, batch, additional = 1) {
  const required = batch.count + additional;
  if (required <= batch.capacity) return;
  let capacity = batch.capacity;
  while (capacity < required) capacity *= 2;
  const data = new Float32Array(capacity * batch.stride);
  data.set(batch.data);
  batch.data = data;
  batch.capacity = capacity;
  webgl.bindBuffer(webgl.ARRAY_BUFFER, batch.buffer);
  webgl.bufferData(webgl.ARRAY_BUFFER, data.byteLength, webgl.DYNAMIC_DRAW);
}

function attribute(webgl, location, size, stride, offset, divisor = 0) {
  webgl.enableVertexAttribArray(location);
  webgl.vertexAttribPointer(location, size, webgl.FLOAT, false, stride * 4, offset * 4);
  webgl.vertexAttribDivisor(location, divisor);
}

function textureFromCanvas(webgl, canvas, { repeat = false, mipmap = false } = {}) {
  const texture = webgl.createTexture();
  webgl.bindTexture(webgl.TEXTURE_2D, texture);
  webgl.pixelStorei(webgl.UNPACK_FLIP_Y_WEBGL, true);
  webgl.texImage2D(webgl.TEXTURE_2D, 0, webgl.RGBA, webgl.RGBA, webgl.UNSIGNED_BYTE, canvas);
  webgl.texParameteri(
    webgl.TEXTURE_2D,
    webgl.TEXTURE_WRAP_S,
    repeat ? webgl.REPEAT : webgl.CLAMP_TO_EDGE,
  );
  webgl.texParameteri(
    webgl.TEXTURE_2D,
    webgl.TEXTURE_WRAP_T,
    repeat ? webgl.REPEAT : webgl.CLAMP_TO_EDGE,
  );
  webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_MAG_FILTER, webgl.LINEAR);
  webgl.texParameteri(
    webgl.TEXTURE_2D,
    webgl.TEXTURE_MIN_FILTER,
    mipmap ? webgl.LINEAR_MIPMAP_LINEAR : webgl.LINEAR,
  );
  if (mipmap) webgl.generateMipmap(webgl.TEXTURE_2D);
  webgl.pixelStorei(webgl.UNPACK_FLIP_Y_WEBGL, false);
  return texture;
}

function gridCanvas() {
  const height = 56;
  const side = height / Math.sqrt(3);
  const width = Math.round(side * 3);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const paint = canvas.getContext('2d', { alpha: false });
  paint.fillStyle = '#0a0a0c';
  paint.fillRect(0, 0, width, height);
  paint.strokeStyle = 'rgba(255, 215, 0, .055)';
  paint.lineWidth = 1;
  paint.beginPath();
  for (const [cx, cy] of [
    [0, 0],
    [0, height],
    [width, 0],
    [width, height],
    [width * 0.5, height * 0.5],
  ]) {
    for (let corner = 0; corner <= 6; corner += 1) {
      const angle = (corner * Math.PI) / 3;
      const x = cx + Math.cos(angle) * side;
      const y = cy + Math.sin(angle) * side;
      if (corner === 0) paint.moveTo(x, y);
      else paint.lineTo(x, y);
    }
  }
  paint.stroke();
  return canvas;
}

function orbAtlasCanvas() {
  const cell = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cell * 2;
  canvas.height = cell;
  const paint = canvas.getContext('2d');

  const halo = (x, color) => {
    const gradient = paint.createRadialGradient(x, 32, 3, x, 32, 30);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(255, 170, 0, 0)');
    paint.fillStyle = gradient;
    paint.fillRect(x - 32, 0, 64, 64);
  };

  // Boost coin.
  halo(32, 'rgba(255, 170, 0, .48)');
  const coin = paint.createRadialGradient(27, 25, 2, 32, 32, 17);
  coin.addColorStop(0, '#fff4c2');
  coin.addColorStop(0.35, '#ffd700');
  coin.addColorStop(1, '#b97800');
  paint.fillStyle = coin;
  paint.beginPath();
  paint.arc(32, 32, 15, 0, TAU);
  paint.fill();
  paint.strokeStyle = '#6f4900';
  paint.lineWidth = 2;
  paint.stroke();
  paint.strokeStyle = 'rgba(86, 55, 0, .72)';
  paint.lineWidth = 2;
  paint.beginPath();
  paint.moveTo(27, 32);
  paint.lineTo(37, 32);
  paint.moveTo(32, 27);
  paint.lineTo(32, 37);
  paint.stroke();

  // Death-value gem.
  halo(96, 'rgba(255, 215, 0, .58)');
  const gem = paint.createLinearGradient(84, 20, 107, 45);
  gem.addColorStop(0, '#fff7cf');
  gem.addColorStop(0.42, '#ffd700');
  gem.addColorStop(1, '#cf8500');
  paint.fillStyle = gem;
  paint.beginPath();
  paint.moveTo(96, 15);
  paint.lineTo(113, 29);
  paint.lineTo(104, 49);
  paint.lineTo(88, 49);
  paint.lineTo(79, 29);
  paint.closePath();
  paint.fill();
  paint.strokeStyle = '#704900';
  paint.lineWidth = 2;
  paint.stroke();
  paint.strokeStyle = 'rgba(255, 255, 255, .58)';
  paint.lineWidth = 1;
  paint.beginPath();
  paint.moveTo(81, 29);
  paint.lineTo(111, 29);
  paint.moveTo(96, 16);
  paint.lineTo(88, 48);
  paint.moveTo(96, 16);
  paint.lineTo(104, 48);
  paint.stroke();
  return canvas;
}

function resampleInto(flat, output) {
  const sourceCount = Math.floor(flat.length / 2);
  const targetCount = Math.floor(output.length / 2);
  if (!sourceCount || !targetCount) return output;
  if (sourceCount === 1) {
    for (let index = 0; index < targetCount; index += 1) {
      output[index * 2] = flat[0];
      output[index * 2 + 1] = flat[1];
    }
    return output;
  }

  let total = 0;
  for (let index = 1; index < sourceCount; index += 1) {
    total += Math.hypot(
      flat[index * 2] - flat[(index - 1) * 2],
      flat[index * 2 + 1] - flat[(index - 1) * 2 + 1],
    );
  }
  if (total <= 0) {
    for (let index = 0; index < targetCount; index += 1) {
      output[index * 2] = flat[0];
      output[index * 2 + 1] = flat[1];
    }
    return output;
  }

  let segment = 0;
  let walked = 0;
  let segmentLength = Math.hypot(flat[2] - flat[0], flat[3] - flat[1]);
  for (let index = 0; index < targetCount; index += 1) {
    const target = targetCount === 1 ? 0 : (index / (targetCount - 1)) * total;
    while (segment < sourceCount - 2 && walked + segmentLength < target) {
      walked += segmentLength;
      segment += 1;
      segmentLength = Math.hypot(
        flat[(segment + 1) * 2] - flat[segment * 2],
        flat[(segment + 1) * 2 + 1] - flat[segment * 2 + 1],
      );
    }
    const t = segmentLength <= 0 ? 0 : (target - walked) / segmentLength;
    output[index * 2] = flat[segment * 2] + (flat[(segment + 1) * 2] - flat[segment * 2]) * t;
    output[index * 2 + 1] =
      flat[segment * 2 + 1] + (flat[(segment + 1) * 2 + 1] - flat[segment * 2 + 1]) * t;
  }
  return output;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function snakeRadius(snake, options) {
  const radius = Number(snake.radius);
  if (Number.isFinite(radius) && radius > 0) return radius;
  return logStakeRadius(snake.valueMinor, options.minStakeMinor, options.maxStakeMinor);
}

function pointInViewport(x, y, radius, viewport) {
  return !(
    x + radius < viewport.minX ||
    x - radius > viewport.maxX ||
    y + radius < viewport.minY ||
    y - radius > viewport.maxY
  );
}

function wallIntersectsViewport(radius, viewport, margin) {
  const nearestX = 0 < viewport.minX ? viewport.minX : 0 > viewport.maxX ? viewport.maxX : 0;
  const nearestY = 0 < viewport.minY ? viewport.minY : 0 > viewport.maxY ? viewport.maxY : 0;
  const nearest = Math.hypot(nearestX, nearestY);
  const farthest = Math.max(
    Math.hypot(viewport.minX, viewport.minY),
    Math.hypot(viewport.maxX, viewport.minY),
    Math.hypot(viewport.minX, viewport.maxY),
    Math.hypot(viewport.maxX, viewport.maxY),
  );
  return nearest <= radius + margin && farthest >= radius - margin;
}

function configureVertexArrays(webgl, quadBuffer, circleBatch, orbBatch) {
  const grid = webgl.createVertexArray();
  webgl.bindVertexArray(grid);
  webgl.bindBuffer(webgl.ARRAY_BUFFER, quadBuffer);
  attribute(webgl, 0, 2, 2, 0);

  const circles = webgl.createVertexArray();
  webgl.bindVertexArray(circles);
  webgl.bindBuffer(webgl.ARRAY_BUFFER, quadBuffer);
  attribute(webgl, 0, 2, 2, 0);
  webgl.bindBuffer(webgl.ARRAY_BUFFER, circleBatch.buffer);
  attribute(webgl, 1, 2, circleBatch.stride, 0, 1);
  attribute(webgl, 2, 1, circleBatch.stride, 2, 1);
  attribute(webgl, 3, 4, circleBatch.stride, 3, 1);
  attribute(webgl, 4, 4, circleBatch.stride, 7, 1);
  attribute(webgl, 5, 1, circleBatch.stride, 11, 1);

  const orbs = webgl.createVertexArray();
  webgl.bindVertexArray(orbs);
  webgl.bindBuffer(webgl.ARRAY_BUFFER, quadBuffer);
  attribute(webgl, 0, 2, 2, 0);
  webgl.bindBuffer(webgl.ARRAY_BUFFER, orbBatch.buffer);
  attribute(webgl, 1, 2, orbBatch.stride, 0, 1);
  attribute(webgl, 2, 1, orbBatch.stride, 2, 1);
  attribute(webgl, 3, 1, orbBatch.stride, 3, 1);

  webgl.bindVertexArray(null);
  return { grid, circles, orbs };
}

/**
 * Starts the renderer and returns its lifecycle handle.
 *
 * `getStep` supplies `{ from, to, t }`; snapshots stay owned by the networking module and this
 * renderer remains a read-only view of server-authoritative state.
 */
export function createSlitherRenderer(canvas, options) {
  const webgl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!webgl) throw new Error('WebGL2 is unavailable');

  const gridProgram = program(webgl, GRID_VERTEX, GRID_FRAGMENT);
  const circleProgram = program(webgl, CIRCLE_VERTEX, CIRCLE_FRAGMENT);
  const spriteProgram = program(webgl, SPRITE_VERTEX, SPRITE_FRAGMENT);
  const quadBuffer = webgl.createBuffer();
  webgl.bindBuffer(webgl.ARRAY_BUFFER, quadBuffer);
  webgl.bufferData(
    webgl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    webgl.STATIC_DRAW,
  );

  const circleBatch = createBatch(webgl, 12, 16_384);
  const orbBatch = createBatch(webgl, 4, 512);
  const vaos = configureVertexArrays(webgl, quadBuffer, circleBatch, orbBatch);
  const gridArt = gridCanvas();
  const gridTexture = textureFromCanvas(webgl, gridArt, { repeat: true, mipmap: true });
  const orbTexture = textureFromCanvas(webgl, orbAtlasCanvas(), { mipmap: true });

  webgl.disable(webgl.DEPTH_TEST);
  webgl.disable(webgl.CULL_FACE);
  webgl.enable(webgl.BLEND);
  webgl.blendFunc(webgl.SRC_ALPHA, webgl.ONE_MINUS_SRC_ALPHA);

  const gridUniforms = uniformLocations(webgl, gridProgram, [
    'u_grid',
    'u_viewport',
    'u_focus',
    'u_unit',
    'u_tile_world',
  ]);
  const circleUniforms = uniformLocations(webgl, circleProgram, [
    'u_viewport',
    'u_focus',
    'u_unit',
  ]);
  const spriteUniforms = uniformLocations(webgl, spriteProgram, [
    'u_atlas',
    'u_viewport',
    'u_focus',
    'u_unit',
  ]);

  /* Sampler bindings and the grid tile size are per-program state that survives every later
   * `useProgram`, so they are uploaded here once instead of on every frame. */
  webgl.useProgram(gridProgram);
  webgl.uniform1i(gridUniforms.u_grid, 0);
  webgl.uniform2f(gridUniforms.u_tile_world, gridArt.width, gridArt.height);
  webgl.useProgram(spriteProgram);
  webgl.uniform1i(spriteUniforms.u_atlas, 0);

  const state = {
    running: true,
    raf: 0,
    width: 1,
    height: 1,
    dpr: 1,
    focusX: 0,
    focusY: 0,
    lastFrameAt: performance.now(),
    lastIndexedTick: -1,
    frameIndexes: new WeakMap(),
    sampleCache: new Map(),
    queryResults: [],
    visibleSnakes: new Map(),
    visibleNames: new Map(),
    visibleGeometry: [],
    activeLabels: new Set(),
    labelNodes: new Map(),
    labelHost: canvas.parentElement?.querySelector('.pit__names') ?? null,
    stats: {
      fps: 60,
      frameMs: 0,
      drawCalls: 0,
      visibleSegments: 0,
      visibleOrbs: 0,
      visibleNames: 0,
    },
  };
  canvas.slitherRenderStats = state.stats;

  const addCircle = (
    x,
    y,
    radius,
    fill,
    fillAlpha,
    stroke,
    strokeAlpha,
    strokePx,
  ) => {
    if (!(radius > 0) || (fillAlpha <= 0 && strokeAlpha <= 0)) return;
    reserve(webgl, circleBatch);
    let offset = circleBatch.count * circleBatch.stride;
    const data = circleBatch.data;
    data[offset++] = x;
    data[offset++] = y;
    data[offset++] = radius;
    data[offset++] = fill[0];
    data[offset++] = fill[1];
    data[offset++] = fill[2];
    data[offset++] = fillAlpha;
    data[offset++] = stroke[0];
    data[offset++] = stroke[1];
    data[offset++] = stroke[2];
    data[offset++] = strokeAlpha;
    data[offset] = strokePx;
    circleBatch.count += 1;
  };

  const addOrb = (x, y, size, kind) => {
    reserve(webgl, orbBatch);
    let offset = orbBatch.count * orbBatch.stride;
    const data = orbBatch.data;
    data[offset++] = x;
    data[offset++] = y;
    data[offset++] = size;
    data[offset] = kind;
    orbBatch.count += 1;
  };

  /**
   * Adopts a new canvas size from a box somebody else already measured.
   *
   * The draw loop deliberately never calls this. `getBoundingClientRect` forces a synchronous
   * layout, and `renderLabels` writes a fresh transform onto every visible name at the END of each
   * frame — so reading a rect at the TOP of the next frame flushed all of those pending writes and
   * made the renderer pay for a full reflow every frame, scaling with the number of snakes on
   * screen. The observer below already reports the box we would have measured, so the measurement
   * is gone and a frame now only reads numbers this function has already stored.
   */
  const adoptSize = (width, height) => {
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    const cssWidth = Math.max(1, Math.round(width));
    const cssHeight = Math.max(1, Math.round(height));
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    state.width = cssWidth;
    state.height = cssHeight;
    state.dpr = dpr;
  };

  /** The only sanctioned layout read: mount, and any time the observer cannot supply a box. */
  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    adoptSize(rect.width, rect.height);
  };

  const indexFrame = (frame) => {
    let cached = state.frameIndexes.get(frame);
    if (cached) return cached;
    const arenaRadius = Math.max(100, Number(options.getArenaRadius?.()) || 3600);
    const extent = arenaRadius + 512;
    const tree = new QuadTree({ minX: -extent, minY: -extent, maxX: extent, maxY: extent });
    const snakes = new Map();
    const orbs = new Map();

    const indexSnake = (snake) => {
      if (!snake || snakes.has(snake.id)) return;
      const radius = snakeRadius(snake, options);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const path of snake.paths ?? []) {
        for (let index = 0; index + 1 < path.length; index += 2) {
          const x = Number(path[index]);
          const y = Number(path[index + 1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (!Number.isFinite(minX)) return;
      snakes.set(snake.id, snake);
      tree.insert({
        type: ITEM_SNAKE,
        snake,
        minX: minX - radius,
        minY: minY - radius,
        maxX: maxX + radius,
        maxY: maxY + radius,
      });
      const head = snake.paths?.[0];
      if (head?.length >= 2) {
        tree.insert({
          type: ITEM_NAME,
          snake,
          minX: Number(head[0]) - radius,
          minY: Number(head[1]) - radius - 32,
          maxX: Number(head[0]) + radius,
          maxY: Number(head[1]) + radius,
        });
      }
    };

    indexSnake(frame.you);
    for (const snake of frame.snakes ?? []) indexSnake(snake);
    for (const orb of frame.orbs ?? []) {
      const x = Number(orb.x);
      const y = Number(orb.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      orbs.set(orb.id, orb);
      tree.insert({
        type: ITEM_ORB,
        orb,
        minX: x - 40,
        minY: y - 40,
        maxX: x + 40,
        maxY: y + 40,
      });
    }
    cached = { tree, snakes, orbs };
    state.frameIndexes.set(frame, cached);
    return cached;
  };

  const samplesFor = (snake, tick) => {
    let cache = state.sampleCache.get(snake.id);
    if (!cache) {
      cache = {
        slots: [
          { tick: -1, runs: [] },
          { tick: -1, runs: [] },
        ],
        nextSlot: 0,
        blendRuns: [],
        lastSeen: tick,
        snake,
        radius: 0,
        headX: 0,
        headY: 0,
      };
      state.sampleCache.set(snake.id, cache);
    }
    cache.lastSeen = tick;
    cache.snake = snake;
    for (const slot of cache.slots) if (slot.tick === tick) return { cache, slot };

    const slot = cache.slots[cache.nextSlot];
    cache.nextSlot = (cache.nextSlot + 1) % cache.slots.length;
    slot.tick = tick;
    const paths = snake.paths ?? [];
    slot.runs.length = paths.length;
    for (let runIndex = 0; runIndex < paths.length; runIndex += 1) {
      const path = paths[runIndex];
      const sourceCount = Math.floor(path.length / 2);
      const count = Math.min(MAX_SEGMENTS_PER_RUN, Math.max(2, sourceCount));
      let output = slot.runs[runIndex];
      if (!output || output.length !== count * 2) output = new Float32Array(count * 2);
      slot.runs[runIndex] = resampleInto(path, output);
    }
    return { cache, slot };
  };

  const blendSnake = (snake, fromSnake, toTick, fromTick, amount) => {
    const { cache, slot: current } = samplesFor(snake, toTick);
    const previous = fromSnake ? samplesFor(fromSnake, fromTick).slot : current;
    cache.blendRuns.length = current.runs.length;
    for (let runIndex = 0; runIndex < current.runs.length; runIndex += 1) {
      const now = current.runs[runIndex];
      const before = previous.runs[runIndex] ?? now;
      let blend = cache.blendRuns[runIndex];
      if (!blend || blend.length !== now.length) blend = new Float32Array(now.length);
      cache.blendRuns[runIndex] = blend;
      const nowCount = now.length / 2;
      const beforeCount = before.length / 2;
      for (let index = 0; index < nowCount; index += 1) {
        const priorPosition = nowCount <= 1 ? 0 : (index / (nowCount - 1)) * (beforeCount - 1);
        const lower = Math.max(0, Math.min(beforeCount - 1, Math.floor(priorPosition)));
        const upper = Math.min(beforeCount - 1, lower + 1);
        const fraction = priorPosition - lower;
        const oldX = lerp(before[lower * 2], before[upper * 2], fraction);
        const oldY = lerp(before[lower * 2 + 1], before[upper * 2 + 1], fraction);
        blend[index * 2] = lerp(oldX, now[index * 2], amount);
        blend[index * 2 + 1] = lerp(oldY, now[index * 2 + 1], amount);
      }
    }
    cache.radius = snakeRadius(snake, options);
    cache.headX = cache.blendRuns[0]?.[0] ?? 0;
    cache.headY = cache.blendRuns[0]?.[1] ?? 0;
    return cache;
  };

  const prepareVisibleGeometry = (step, toIndex) => {
    state.visibleGeometry.length = 0;
    const fromIndex = step.from === step.to ? toIndex : indexFrame(step.from);
    for (const [id, item] of state.visibleSnakes) {
      const snake = item.snake;
      const before = fromIndex.snakes.get(id) ?? snake;
      state.visibleGeometry.push(
        blendSnake(snake, before, Number(step.to.tick), Number(step.from.tick), step.t),
      );
    }
    if (state.lastIndexedTick !== Number(step.to.tick)) {
      state.lastIndexedTick = Number(step.to.tick);
      if (state.lastIndexedTick % 40 === 0) {
        for (const [id, cache] of state.sampleCache) {
          if (cache.lastSeen < state.lastIndexedTick - 4) state.sampleCache.delete(id);
        }
      }
    }
    return fromIndex;
  };

  const addArena = (frame, viewport, time, scale) => {
    const arenaRadius = Math.max(100, Number(options.getArenaRadius?.()) || 3600);
    if (wallIntersectsViewport(arenaRadius, viewport, 20 / scale)) {
      addCircle(0, 0, arenaRadius, OBSIDIAN, 0, WALL_RED, 0.62, 6);
    }
    const pulse = 0.72 + Math.sin(time * 3) * 0.18;
    for (const angle of frame.gates ?? []) {
      const x = Math.cos(angle) * arenaRadius;
      const y = Math.sin(angle) * arenaRadius;
      const markerRadius = 14 / scale;
      if (!pointInViewport(x, y, markerRadius, viewport)) continue;
      addCircle(x, y, markerRadius, GOLD_BRIGHT, pulse, GOLD, 1, 1);
    }
  };

  /**
   * The boost tail: a short run of fading circles behind the head.
   *
   * This used to emit one circle per segment of every run, which doubled the instance count of a
   * boosting snake — and in a crowded pit nearly everybody is boosting at once, so the batch grew
   * worst exactly when it could least afford to. It also lit the tip of a tail that is meant to be
   * trailing away. Capping the run at `BOOST_TRAIL_SEGMENTS` makes a boost cost a fixed number of
   * instances however long the snake has grown, and the squared falloff reads as motion rather
   * than as a second, brighter body.
   */
  const addBoostTrails = (viewport) => {
    for (const geometry of state.visibleGeometry) {
      if (!geometry.snake.boosting) continue;
      const run = geometry.blendRuns[0];
      if (!run?.length) continue;
      const radius = geometry.radius + 7;
      const count = Math.min(BOOST_TRAIL_SEGMENTS, run.length / 2);
      for (let index = 0; index < count; index += 1) {
        const x = run[index * 2];
        const y = run[index * 2 + 1];
        if (!pointInViewport(x, y, radius, viewport)) continue;
        const decay = 1 - index / count;
        addCircle(x, y, radius, GOLD, 0.05 + decay * decay * 0.19, GOLD, 0, 0);
      }
    }
  };

  const addBodies = (viewport) => {
    let visibleSegments = 0;
    for (const geometry of state.visibleGeometry) {
      const radius = geometry.radius;
      for (let runIndex = 0; runIndex < geometry.blendRuns.length; runIndex += 1) {
        const run = geometry.blendRuns[runIndex];
        for (let index = 0; index < run.length / 2; index += 1) {
          const x = run[index * 2];
          const y = run[index * 2 + 1];
          if (!pointInViewport(x, y, radius, viewport)) continue;
          const fill = (index + runIndex) % 2 === 0 ? OBSIDIAN : CHARCOAL;
          addCircle(x, y, radius, fill, 1, GOLD, 1, 1);
          visibleSegments += 1;
        }
      }
    }
    state.stats.visibleSegments = visibleSegments;
  };

  const addHeads = (viewport, time) => {
    for (const geometry of state.visibleGeometry) {
      const run = geometry.blendRuns[0];
      if (!run?.length) continue;
      const snake = geometry.snake;
      const radius = geometry.radius;
      const x = run[0];
      const y = run[1];
      if (!pointInViewport(x, y, radius * 2.8, viewport)) continue;
      const nextX = run[2] ?? x - 1;
      const nextY = run[3] ?? y;
      const angle = Math.atan2(y - nextY, x - nextX);
      addCircle(x, y, radius * 1.07, CHARCOAL, 1, GOLD, 1, 1.25);

      const eyeRadius = Math.max(1.8, radius * 0.22);
      const side = radius * 0.45;
      const forward = radius * 0.44;
      for (const flank of [-1, 1]) {
        const eyeX = x + Math.cos(angle) * forward - Math.sin(angle) * side * flank;
        const eyeY = y + Math.sin(angle) * forward + Math.cos(angle) * side * flank;
        addCircle(eyeX, eyeY, eyeRadius, GOLD_BRIGHT, 1, GOLD_BRIGHT, 0, 0);
      }

      const extracting = Math.max(0, Math.min(1, Number(snake.extracting) || 0));
      if (extracting > 0) {
        const ringRadius = radius * (2.4 + 1.8 * (1 - extracting));
        const alpha = 0.58 + Math.abs(Math.sin(time * 6)) * 0.32;
        addCircle(x, y, ringRadius, GOLD_BRIGHT, 0, GOLD_BRIGHT, alpha, 3);
      }
    }
  };

  const addVisibleOrbs = (step, fromIndex, viewport) => {
    let visible = 0;
    for (const item of state.queryResults) {
      if (item.type !== ITEM_ORB) continue;
      const orb = item.orb;
      const before = fromIndex.orbs.get(orb.id) ?? orb;
      const x = lerp(Number(before.x), Number(orb.x), step.t);
      const y = lerp(Number(before.y), Number(orb.y), step.t);
      const size = 22 + Math.min(52, Math.cbrt(Math.max(0, Number(orb.valueMinor))) * 0.9);
      if (!pointInViewport(x, y, size * 0.5, viewport)) continue;
      addOrb(x, y, size, orb.kind === 'death' ? 1 : 0);
      visible += 1;
    }
    state.stats.visibleOrbs = visible;
  };

  const renderLabels = (viewport, focus, scale) => {
    const host = state.labelHost;
    if (!host) return;
    state.activeLabels.clear();
    let visible = 0;
    for (const [id, item] of state.visibleNames) {
      const geometry = state.sampleCache.get(id);
      if (!geometry || !pointInViewport(geometry.headX, geometry.headY, geometry.radius, viewport)) {
        continue;
      }
      let node = state.labelNodes.get(id);
      if (!node) {
        node = document.createElement('span');
        node.className = 'pit__name';
        node.textContent = item.snake.name;
        node.dataset.you = item.snake.isYou ? '1' : '0';
        host.append(node);
        state.labelNodes.set(id, node);
      } else if (node.textContent !== item.snake.name) {
        node.textContent = item.snake.name;
      }
      const screenX = (geometry.headX - focus.x) * scale + state.width * 0.5;
      const screenY = (geometry.headY - focus.y) * scale + state.height * 0.5;
      node.style.transform = `translate3d(${Math.round(screenX)}px, ${Math.round(
        screenY - geometry.radius * scale - 7,
      )}px, 0) translate(-50%, -100%)`;
      if (node.hidden) node.hidden = false;
      state.activeLabels.add(id);
      visible += 1;
    }
    for (const [id, node] of state.labelNodes) {
      if (!state.activeLabels.has(id) && !node.hidden) node.hidden = true;
      const cache = state.sampleCache.get(id);
      if (cache && cache.lastSeen >= state.lastIndexedTick - 4) continue;
      node.remove();
      state.labelNodes.delete(id);
    }
    state.stats.visibleNames = visible;
  };

  const drawGrid = (focus, unit) => {
    webgl.useProgram(gridProgram);
    webgl.bindVertexArray(vaos.grid);
    webgl.activeTexture(webgl.TEXTURE0);
    webgl.bindTexture(webgl.TEXTURE_2D, gridTexture);
    webgl.uniform2f(gridUniforms.u_viewport, canvas.width, canvas.height);
    webgl.uniform2f(gridUniforms.u_focus, focus.x, focus.y);
    webgl.uniform1f(gridUniforms.u_unit, unit);
    webgl.drawArrays(webgl.TRIANGLE_STRIP, 0, 4);
  };

  const drawOrbs = (focus, unit) => {
    if (!orbBatch.count) return 0;
    webgl.useProgram(spriteProgram);
    webgl.bindVertexArray(vaos.orbs);
    webgl.bindBuffer(webgl.ARRAY_BUFFER, orbBatch.buffer);
    /* The five-argument form uploads a window of the batch in place. The `subarray` it replaces
     * built a throwaway view object on every batch on every frame, which is garbage a loop with a
     * 16ms budget should not be generating. */
    webgl.bufferSubData(webgl.ARRAY_BUFFER, 0, orbBatch.data, 0, orbBatch.count * orbBatch.stride);
    webgl.activeTexture(webgl.TEXTURE0);
    webgl.bindTexture(webgl.TEXTURE_2D, orbTexture);
    webgl.uniform2f(spriteUniforms.u_viewport, canvas.width, canvas.height);
    webgl.uniform2f(spriteUniforms.u_focus, focus.x, focus.y);
    webgl.uniform1f(spriteUniforms.u_unit, unit);
    webgl.drawArraysInstanced(webgl.TRIANGLE_STRIP, 0, 4, orbBatch.count);
    return 1;
  };

  const drawCircles = (focus, unit) => {
    if (!circleBatch.count) return 0;
    webgl.useProgram(circleProgram);
    webgl.bindVertexArray(vaos.circles);
    webgl.bindBuffer(webgl.ARRAY_BUFFER, circleBatch.buffer);
    webgl.bufferSubData(
      webgl.ARRAY_BUFFER,
      0,
      circleBatch.data,
      0,
      circleBatch.count * circleBatch.stride,
    );
    webgl.uniform2f(circleUniforms.u_viewport, canvas.width, canvas.height);
    webgl.uniform2f(circleUniforms.u_focus, focus.x, focus.y);
    webgl.uniform1f(circleUniforms.u_unit, unit);
    webgl.drawArraysInstanced(webgl.TRIANGLE_STRIP, 0, 4, circleBatch.count);
    return 1;
  };

  const camera = (step, deltaSeconds) => {
    let x = state.focusX;
    let y = state.focusY;
    let rate = 3;
    const playerPath = step?.to?.you?.paths?.[0];
    if (playerPath?.length >= 2) {
      x = Number(playerPath[0]);
      y = Number(playerPath[1]);
      rate = 12;
    } else if (step?.to?.focus) {
      x = Number(step.to.focus[0]) || 0;
      y = Number(step.to.focus[1]) || 0;
    }
    const amount = 1 - Math.exp(-rate * Math.min(0.1, deltaSeconds));
    state.focusX = lerp(state.focusX, x, amount);
    state.focusY = lerp(state.focusY, y, amount);
    return { x: state.focusX, y: state.focusY };
  };

  const cameraScale = (step) => {
    const player = step?.to?.you;
    const aura = Math.max(0, Math.min(1, Number(player?.aura) || 0));
    const halfWidth = player
      ? lerp(VIEW_HALF_WIDTH_MIN, VIEW_HALF_WIDTH_MAX, aura)
      : 1150;
    return state.width * 0.5 / halfWidth;
  };

  const drawFrame = (now) => {
    const started = performance.now();
    const deltaMs = Math.max(1, now - state.lastFrameAt);
    state.lastFrameAt = now;
    webgl.viewport(0, 0, canvas.width, canvas.height);
    const step = options.getStep?.() ?? null;
    const focus = camera(step, deltaMs / 1000);
    const scale = cameraScale(step);
    const unit = scale * state.dpr;
    const viewport = {
      minX: focus.x - state.width * 0.5 / scale,
      minY: focus.y - state.height * 0.5 / scale,
      maxX: focus.x + state.width * 0.5 / scale,
      maxY: focus.y + state.height * 0.5 / scale,
    };

    circleBatch.count = 0;
    orbBatch.count = 0;
    state.visibleSnakes.clear();
    state.visibleNames.clear();
    state.queryResults.length = 0;

    drawGrid(focus, unit);
    let drawCalls = 1;
    if (step) {
      const toIndex = indexFrame(step.to);
      const query = {
        minX: viewport.minX - CULL_GUARD,
        minY: viewport.minY - CULL_GUARD,
        maxX: viewport.maxX + CULL_GUARD,
        maxY: viewport.maxY + CULL_GUARD,
      };
      toIndex.tree.query(query, state.queryResults);
      for (const item of state.queryResults) {
        if (item.type === ITEM_SNAKE) state.visibleSnakes.set(item.snake.id, item);
        else if (item.type === ITEM_NAME) state.visibleNames.set(item.snake.id, item);
      }
      const fromIndex = prepareVisibleGeometry(step, toIndex);
      addVisibleOrbs(step, fromIndex, viewport);
      addArena(step.to, viewport, now / 1000, scale);
      addBoostTrails(viewport);
      addBodies(viewport);
      addHeads(viewport, now / 1000);
      drawCalls += drawOrbs(focus, unit);
      drawCalls += drawCircles(focus, unit);
      renderLabels(viewport, focus, scale);
    } else {
      state.stats.visibleSegments = 0;
      state.stats.visibleOrbs = 0;
      state.stats.visibleNames = 0;
      if (state.labelHost) {
        for (const node of state.labelNodes.values()) node.hidden = true;
      }
    }
    webgl.bindVertexArray(null);

    const elapsed = performance.now() - started;
    state.stats.frameMs = state.stats.frameMs * 0.9 + elapsed * 0.1;
    state.stats.fps = state.stats.fps * 0.9 + (1000 / deltaMs) * 0.1;
    state.stats.drawCalls = drawCalls;
  };

  const loop = (now) => {
    if (!state.running) return;
    drawFrame(now);
    state.raf = window.requestAnimationFrame(loop);
  };

  const onContextLost = (event) => {
    event.preventDefault();
    state.running = false;
    window.cancelAnimationFrame(state.raf);
    options.onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  /* `contentBoxSize` is the box the engine computed during the layout that triggered this
   * callback, handed over without a second pass. `contentRect` covers engines that predate it, and
   * `measure` covers a zero-sized report — which is what arrives when the pit is built inside a
   * route that is still hidden and revealed a moment later. */
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const reported = entry?.contentBoxSize;
    const box = Array.isArray(reported) ? reported[0] : reported;
    if (box && box.inlineSize > 0 && box.blockSize > 0) adoptSize(box.inlineSize, box.blockSize);
    else if (entry?.contentRect?.width > 0) {
      adoptSize(entry.contentRect.width, entry.contentRect.height);
    } else measure();
  });
  observer.observe(canvas);
  measure();
  state.raf = window.requestAnimationFrame(loop);

  return {
    stats: state.stats,
    destroy() {
      if (!state.running && !state.raf) return;
      state.running = false;
      window.cancelAnimationFrame(state.raf);
      state.raf = 0;
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      for (const node of state.labelNodes.values()) node.remove();
      state.labelNodes.clear();
      webgl.deleteTexture(gridTexture);
      webgl.deleteTexture(orbTexture);
      webgl.deleteBuffer(quadBuffer);
      webgl.deleteBuffer(circleBatch.buffer);
      webgl.deleteBuffer(orbBatch.buffer);
      webgl.deleteVertexArray(vaos.grid);
      webgl.deleteVertexArray(vaos.circles);
      webgl.deleteVertexArray(vaos.orbs);
      webgl.deleteProgram(gridProgram);
      webgl.deleteProgram(circleProgram);
      webgl.deleteProgram(spriteProgram);
      delete canvas.slitherRenderStats;
    },
  };
}
