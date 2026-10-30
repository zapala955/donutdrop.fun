/* prefs-boot.js — the player's display settings, applied before the page paints.
 *
 * A classic script in <head>, not a module: modules run after the document is parsed, and a theme
 * applied then flashes the default obsidian first on every load. This file reads the settings,
 * sets them on <html> as attributes and custom properties, and leaves the rest to the sheets
 * (luxe.css, settings.css). The settings page (settings.js) changes them through `DonutPrefs`.
 *
 * Everything here lives in this browser only. Nothing is sent to the server, so the settings work
 * signed out and a theme follows the device rather than the account.
 *
 * THEMES
 * A theme recolours the obsidian ladder (--lx-0 to --lx-5) by giving it a hue and a chroma;
 * luxe.css derives every step from those two numbers at the ladder's own lightness, so text keeps
 * the contrast it was checked at on every theme. A gradient theme also paints a backdrop behind the
 * page, and every backdrop stays at or below oklch L 0.2, under the cards (--lx-2 is 0.228). A
 * brighter backdrop crossed the cards' own shade somewhere down the page, and there the cards
 * melted into it; held under them, a card is raised above the page on every theme, as it is on
 * obsidian, and grey text on the bare backdrop reads better than it does on a card. Gold is not
 * part of a theme. It is the colour that means "do this", and it stays one colour everywhere.
 */
(function () {
  'use strict';

  var KEY = 'lx:prefs';

  /* Named after the places they borrow from. `h` and `c` tint the surfaces; `from`, `to` and
   * `angle` draw the backdrop of a gradient theme as [lightness, chroma, hue]. */
  var THEMES = [
    { id: 'obsidian', name: 'Obsidian' },
    { id: 'deepslate', name: 'Deepslate', h: 255, c: 0.02 },
    { id: 'sculk', name: 'Sculk', h: 210, c: 0.03 },
    { id: 'warped', name: 'Warped', h: 182, c: 0.035 },
    { id: 'moss', name: 'Moss', h: 140, c: 0.03 },
    { id: 'mangrove', name: 'Mangrove', h: 45, c: 0.03 },
    { id: 'crimson', name: 'Crimson', h: 18, c: 0.04 },
    { id: 'amethyst', name: 'Amethyst', h: 305, c: 0.04 },
    { id: 'lapis', name: 'Lapis', h: 268, c: 0.05 },
    { id: 'end', name: 'The End', h: 295, c: 0.04, from: [0.2, 0.11, 305], to: [0.13, 0.05, 275], angle: 160 },
    { id: 'nether', name: 'Nether', h: 22, c: 0.035, from: [0.2, 0.11, 27], to: [0.12, 0.03, 20], angle: 165 },
    { id: 'beacon', name: 'Beacon', h: 285, c: 0.045, from: [0.2, 0.13, 262], to: [0.19, 0.12, 330], angle: 135 },
    { id: 'aurora', name: 'Aurora', h: 240, c: 0.03, from: [0.2, 0.08, 185], to: [0.16, 0.1, 305], angle: 150 },
    { id: 'cherry', name: 'Cherry Grove', h: 10, c: 0.035, from: [0.19, 0.1, 350], to: [0.2, 0.08, 60], angle: 160 },
    { id: 'prismarine', name: 'Prismarine', h: 220, c: 0.035, from: [0.2, 0.08, 195], to: [0.15, 0.1, 262], angle: 145 },
    { id: 'jungle', name: 'Jungle', h: 155, c: 0.03, from: [0.2, 0.08, 150], to: [0.12, 0.03, 170], angle: 170 },
    { id: 'blaze', name: 'Blaze', h: 55, c: 0.03, from: [0.2, 0.07, 70], to: [0.12, 0.03, 40], angle: 165 },
    { id: 'ocean', name: 'Deep Ocean', h: 262, c: 0.04, from: [0.19, 0.11, 262], to: [0.11, 0.03, 262], angle: 180 },
  ];
  var HEX = /^#[0-9a-f]{6}$/i;
  var SIZES = { s: 1, l: 1 };

  function read() {
    try {
      var value = JSON.parse(localStorage.getItem(KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      // A private window, blocked storage or a hand-edited value: start from the defaults.
      return {};
    }
  }

  var current = read();

  /* 3D is every game's default. A 2D choice saved before that was settled (30 October 2026) -- the
   * site's switch, or blackjack's own older one -- is cleared once, so every player starts in 3D
   * again; a 2D chosen after it is kept. */
  if (current.view3dDefault !== 1) {
    delete current.view;
    delete current.bjView;
    current.view3dDefault = 1;
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch (error) {
      /* storage refused: this tab starts in 3D all the same */
    }
  }

  /* sRGB to OKLCH (Björn Ottosson's OKLab), so a picked colour can be held to the ladder's
   * lightness and keep only its hue and chroma. */
  function hexToOklch(hex) {
    if (!HEX.test(String(hex))) return null;
    var n = parseInt(hex.slice(1), 16);
    var lin = function (v) {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    var r = lin((n >> 16) & 255);
    var g = lin((n >> 8) & 255);
    var b = lin(n & 255);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    var c = Math.hypot(A, B);
    // A grey has no hue to speak of; calling it 0 keeps the output a valid colour.
    var h = c < 0.01 ? 0 : (Math.atan2(B, A) * 180) / Math.PI;
    return { l: L, c: c < 0.01 ? 0 : c, h: Math.round((h + 360) % 360) };
  }

  function round(x) {
    return Math.round(x * 1000) / 1000;
  }

  /* A custom theme from one or two picked colours. Only their hue and chroma survive: lightness
   * is the ladder's, so a picked white or neon still gives a dark site with readable text. */
  function customTheme(custom) {
    var a = custom && hexToOklch(custom.a);
    if (!a) return null;
    var theme = { id: 'custom', name: 'Custom', h: a.h, c: round(Math.min(a.c * 0.35, 0.05)) };
    var b = custom.gradient ? hexToOklch(custom.b) : null;
    if (b) {
      theme.from = [0.2, round(Math.min(a.c, 0.12)), a.h];
      theme.to = [0.14, round(Math.min(b.c, 0.1)), b.h];
      theme.angle = 160;
    }
    return theme;
  }

  function oklch(stop) {
    return 'oklch(' + stop[0] + ' ' + stop[1] + ' ' + stop[2] + ')';
  }

  function backdrop(theme) {
    return theme && theme.from
      ? 'linear-gradient(' + theme.angle + 'deg, ' + oklch(theme.from) + ', ' + oklch(theme.to) + ')'
      : '';
  }

  /** The theme the settings name, or null for the default obsidian. */
  function themeOf(prefs) {
    if (prefs.theme === 'custom') return customTheme(prefs.custom);
    for (var i = 0; i < THEMES.length; i += 1) {
      if (THEMES[i].id === prefs.theme && THEMES[i].h !== undefined) return THEMES[i];
    }
    return null;
  }

  function flag(root, name, on, value) {
    if (on) root.setAttribute(name, value);
    else root.removeAttribute(name);
  }

  function apply(prefs) {
    var root = document.documentElement;
    var theme = themeOf(prefs);
    flag(root, 'data-lxtheme', theme, theme ? theme.id : '');
    if (theme) {
      root.style.setProperty('--lx-h', String(theme.h));
      root.style.setProperty('--lx-c', String(theme.c));
    } else {
      root.style.removeProperty('--lx-h');
      root.style.removeProperty('--lx-c');
    }
    var art = backdrop(theme);
    if (art) root.style.setProperty('--lx-backdrop', art);
    else root.style.removeProperty('--lx-backdrop');
    // The phone's browser bar takes the top bar's colour.
    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', theme ? oklch([0.183, theme.c, theme.h]) : '#0a0a0c');

    flag(root, 'data-motion', prefs.motion === 'reduce', 'reduce');
    flag(root, 'data-chat-size', SIZES[prefs.chatSize] === 1, prefs.chatSize);
    flag(root, 'data-chat-wins', prefs.chatWins === false, 'off');
    flag(root, 'data-hide-balance', prefs.hideBalance === true, '1');
  }

  /** Applies a change at once and keeps it if the browser lets it. False: it lasts this tab only. */
  function update(patch) {
    var next = {};
    var key;
    for (key in current) if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
    for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
    current = next;
    apply(current);
    var saved = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch (error) {
      saved = false;
    }
    try {
      window.dispatchEvent(new CustomEvent('lx:prefs', { detail: current }));
    } catch (error) {
      /* an old browser without CustomEvent still gets the change applied */
    }
    return saved;
  }

  window.DonutPrefs = {
    THEMES: THEMES,
    get: function () {
      return current;
    },
    update: update,
    themeOf: themeOf,
    backdrop: backdrop,
    hexToOklch: hexToOklch,
  };

  apply(current);

  // Another tab changed them: follow it, so two open tabs never disagree about the theme.
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    current = read();
    apply(current);
    try {
      window.dispatchEvent(new CustomEvent('lx:prefs', { detail: current }));
    } catch (error) {
      /* as above */
    }
  });
})();
