/* quality3d.js — how much a 3D game asks of the machine it runs on.
 *
 * Three tiers, chosen once before the renderer is made (some things, antialiasing among them, can
 * only be decided then):
 *
 *   low     a phone, a laptop's integrated graphics, a software renderer: the screen's resolution
 *           at most 1 (less on a dense phone screen), no antialiasing, no glow, no post-processing,
 *           a third of the particles, fewer creatures, a shorter view into the fog, and a steady
 *           thirty frames a second -- the whole scene stepped thirty times, not only drawn.
 *   medium  most laptops: resolution up to 1.5, glow at half resolution, most of the effects, sixty
 *           frames a second at most (a fast screen gets no more, and the machine keeps its breath).
 *   high    a real graphics card: resolution up to 2, multisampling, full glow, everything, as many
 *           frames as the screen shows.
 *
 * The guess comes from the GPU's own name where the browser gives it (WEBGL_debug_renderer_info),
 * the device's memory and cores, and whether it is a phone. A player can overrule it from the game's
 * panel ("Graphics: Auto / Low / High"), which is kept with the other display settings. While
 * playing, a machine that cannot keep up steps down on its own (see `createGovernor`).
 */

export const TIERS = {
  low: { name: 'low', ratio: 1, mobileRatio: 0.75, antialias: false, bloom: false, composer: false, particles: 0.35, creatures: 0.5, view: 0.7, waves: 40, fps: 30, mirror: false, lights: 1 },
  medium: { name: 'medium', ratio: 1.5, mobileRatio: 1, antialias: false, bloom: true, bloomScale: 0.5, composer: true, particles: 0.7, creatures: 0.8, view: 0.85, waves: 72, fps: 60, mirror: true, lights: 2 },
  high: { name: 'high', ratio: 2, mobileRatio: 1.5, antialias: true, bloom: true, bloomScale: 1, composer: true, particles: 1, creatures: 1, view: 1, waves: 128, fps: 0, mirror: true, lights: 4 },
};
const ORDER = ['low', 'medium', 'high'];

const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent || ''));

/** The GPU's name, if the browser says. */
export function gpuName(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

/** The tier this machine is likely to manage, from its GPU, memory, cores and form. */
export function guessTier(gl) {
  const gpu = gpuName(gl);
  // Only Chromium says how much memory there is (and never more than 8); elsewhere it is no reason to hold back.
  const memory = Number(navigator.deviceMemory) || 8;
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const mobile = isMobile();
  // Software rendering, and the weakest integrated and mobile GPUs still about.
  if (/SwiftShader|llvmpipe|softpipe|Software|Microsoft Basic/i.test(gpu)) return 'low';
  if (/Mali-(4|T[0-9]|G[357]\d)|Adreno.*\b[2-5]\d\d\b|PowerVR|Intel.*HD Graphics( [2-5]\d\d)?\b|Intel\(R\) (HD|UHD) Graphics(?! [67]\d\d)/i.test(gpu)) return 'low';
  if (memory <= 2 || cores <= 2) return 'low';
  if (mobile) return memory >= 6 && /Apple|Adreno.*\b[7-9]\d\d\b|Mali-G7[1-9]\d?|Immortalis/i.test(gpu) ? 'medium' : 'low';
  if (/Intel|Iris|UHD|Radeon\(TM\) Graphics|Vega [3-8]\b/i.test(gpu) || memory <= 4) return 'medium';
  return 'high';
}

/** What the player has asked for: 'auto', 'low', 'medium' or 'high'. */
export function graphicsPref() {
  const value = globalThis.DonutPrefs?.get?.().gfx;
  return ORDER.includes(value) ? value : 'auto';
}
export function setGraphicsPref(value) {
  globalThis.DonutPrefs?.update?.({ gfx: ORDER.includes(value) ? value : undefined });
}

/** The tier to build with: the player's choice, or the guess. */
export function chooseTier(gl) {
  const pref = graphicsPref();
  return TIERS[pref === 'auto' ? guessTier(gl) : pref];
}

/** How long a frame of this tier is, in ms (0: as fast as the screen), and the governor's floor. */
export const frameMs = (tier) => (tier.fps ? 1000 / tier.fps : 0);
export const minFpsFor = (tier) => (tier.fps === 30 ? 22 : 28);

/** The pixel ratio a tier allows on this screen. */
export function ratioFor(tier) {
  const cap = isMobile() ? tier.mobileRatio : tier.ratio;
  return Math.max(0.5, Math.min(cap, globalThis.devicePixelRatio || 1));
}

/**
 * Watches the frame time and steps the scene down when the machine cannot keep up: under `minFps`
 * (28, or 22 for a scene held to thirty) for two and a half seconds is too slow. Each step is one of
 * `steps`, in order, cheapest loss first; it returns how many it has taken. A machine with room again
 * is not stepped back up -- a scene that keeps flipping between two looks is worse than one that
 * settles.
 */
export function createGovernor(steps, { minFps = 28 } = {}) {
  let slowFor = 0;
  let taken = 0;
  return {
    get taken() { return taken; },
    frame(elapsed) {
      if (elapsed > 0.5 || taken >= steps.length) return;
      if (elapsed > 1 / minFps) slowFor += elapsed;
      else slowFor = Math.max(0, slowFor - elapsed * 0.5);
      if (slowFor > 2.5) {
        slowFor = 0;
        steps[taken]();
        taken += 1;
      }
    },
  };
}
