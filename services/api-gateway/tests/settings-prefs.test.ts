import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';

/* The settings page: a theme picker and the switches beside it. prefs-boot.js is run for real in a
 * stand-in browser (a <html> element, a theme-color meta, localStorage), so what it writes onto the
 * page is what a player's browser gets before the first paint. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const source = async (relative: string) =>
  (await readFile(path.join(frontend, relative), 'utf8')).replace(/\r\n/g, '\n');

type Theme = { id: string; name: string; h?: number; c?: number; from?: number[]; to?: number[]; angle?: number };
type Prefs = {
  THEMES: Theme[];
  get(): Record<string, unknown>;
  update(patch: Record<string, unknown>): boolean;
  themeOf(prefs: Record<string, unknown>): Theme | null;
  backdrop(theme: Theme): string;
  hexToOklch(hex: string): { l: number; c: number; h: number } | null;
};

/** prefs-boot.js in a fresh stand-in browser, with `stored` already in localStorage. */
async function boot(stored?: unknown, { storageWorks = true } = {}) {
  const attrs = new Map<string, string>();
  const style = new Map<string, string>();
  const meta = { content: '#0a0a0c', setAttribute: (_: string, value: string) => (meta.content = value) };
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('lx:prefs', JSON.stringify(stored));
  const events: string[] = [];
  const window: Record<string, unknown> = {
    addEventListener: () => undefined,
    dispatchEvent: (event: { type: string }) => events.push(event.type),
  };
  const context = vm.createContext({
    window,
    CustomEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!storageWorks) throw new Error('QuotaExceededError');
        store.set(key, value);
      },
    },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => attrs.set(name, value),
        removeAttribute: (name: string) => attrs.delete(name),
        style: {
          setProperty: (name: string, value: string) => style.set(name, value),
          removeProperty: (name: string) => style.delete(name),
        },
      },
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
    },
    Math,
    JSON,
    Object,
    String,
    parseInt,
  });
  vm.runInContext(await source('assets/js/prefs-boot.js'), context);
  return { prefs: window['DonutPrefs'] as Prefs, attrs, style, meta, store, events };
}

describe('settings: themes', () => {
  it('paints a saved theme onto <html> before anything else runs', async () => {
    const { attrs, style, meta } = await boot({ theme: 'end' });
    assert.equal(attrs.get('data-lxtheme'), 'end');
    assert.equal(style.get('--lx-h'), '295');
    assert.equal(style.get('--lx-c'), '0.04');
    assert.match(style.get('--lx-backdrop') ?? '', /^linear-gradient\(160deg, oklch\(0\.2 0\.11 305\), oklch\(0\.13 0\.05 275\)\)$/);
    assert.equal(meta.content, 'oklch(0.183 0.04 295)');
  });

  it('leaves obsidian alone: no theme, an unknown one, or a broken value', async () => {
    for (const stored of [undefined, { theme: 'obsidian' }, { theme: 'not-a-theme' }, ['junk']]) {
      const { attrs, style, meta } = await boot(stored);
      assert.equal(attrs.has('data-lxtheme'), false, JSON.stringify(stored));
      assert.equal(style.size, 0);
      assert.equal(meta.content, '#0a0a0c');
    }
  });

  it('keeps every backdrop under the cards, so a card is raised on every theme', async () => {
    const { prefs } = await boot();
    const ids = prefs.THEMES.map((theme) => theme.id);
    assert.equal(new Set(ids).size, ids.length, 'theme ids are unique');
    assert.equal(ids[0], 'obsidian');
    for (const theme of prefs.THEMES.filter((t) => t.from)) {
      // --lx-2, the card, is oklch L 0.228.
      assert.ok(theme.from![0]! <= 0.2 && theme.to![0]! <= 0.2, `${theme.id} backdrop is lighter than a card`);
    }
    for (const theme of prefs.THEMES.filter((t) => t.h !== undefined)) {
      assert.ok(theme.c! > 0 && theme.c! <= 0.05, `${theme.id} surfaces stay a tint, not a colour`);
    }
  });

  it('turns any picked colour into a dark theme with readable text', async () => {
    const { prefs } = await boot();
    const white = prefs.hexToOklch('#ffffff')!;
    assert.ok(Math.abs(white.l - 1) < 1e-6);
    assert.equal(white.c, 0, 'a grey has no chroma');
    assert.equal(white.h, 0);
    const red = prefs.hexToOklch('#ff0000')!;
    assert.equal(red.h, 29);
    assert.ok(Math.abs(red.c - 0.2577) < 0.001);
    assert.equal(prefs.hexToOklch('red'), null);

    const neon = prefs.themeOf({ theme: 'custom', custom: { a: '#00ff00', b: '#ff00ff', gradient: true } })!;
    assert.ok(neon.c! <= 0.05);
    assert.ok(neon.from![0]! <= 0.2 && neon.to![0]! <= 0.2, 'a neon pick is taken down to the dark shades');
    assert.ok(neon.from![1]! <= 0.12 && neon.to![1]! <= 0.1);
    const solid = prefs.themeOf({ theme: 'custom', custom: { a: '#00ff00', b: '#ff00ff', gradient: false } })!;
    assert.equal(solid.from, undefined);
    assert.equal(prefs.themeOf({ theme: 'custom', custom: { a: 'nope' } }), null);
  });

  it('applies a change at once, and says so when the browser will not keep it', async () => {
    const kept = await boot();
    assert.equal(kept.prefs.update({ theme: 'nether', hideBalance: true }), true);
    assert.equal(kept.attrs.get('data-lxtheme'), 'nether');
    assert.equal(kept.attrs.get('data-hide-balance'), '1');
    assert.deepEqual(JSON.parse(kept.store.get('lx:prefs')!), { theme: 'nether', hideBalance: true });
    assert.deepEqual(kept.events, ['lx:prefs']);
    kept.prefs.update({ theme: undefined, hideBalance: undefined });
    assert.equal(kept.attrs.has('data-lxtheme'), false);
    assert.equal(kept.attrs.has('data-hide-balance'), false);

    const refused = await boot(undefined, { storageWorks: false });
    assert.equal(refused.prefs.update({ theme: 'moss', motion: 'reduce', chatSize: 'l', chatWins: false }), false);
    assert.equal(refused.attrs.get('data-lxtheme'), 'moss');
    assert.equal(refused.attrs.get('data-motion'), 'reduce');
    assert.equal(refused.attrs.get('data-chat-size'), 'l');
    assert.equal(refused.attrs.get('data-chat-wins'), 'off');
  });

  it('only sets the switches it knows', async () => {
    const { attrs } = await boot({ chatSize: '<script>', motion: 'yes', chatWins: 0, hideBalance: 'true' });
    for (const name of ['data-chat-size', 'data-motion', 'data-chat-wins', 'data-hide-balance']) {
      assert.equal(attrs.has(name), false, name);
    }
  });
});

describe('settings: the page and what it changes', () => {
  it('loads the boot script blocking in <head>, so a themed page never flashes obsidian', async () => {
    const html = await source('index.html');
    const head = html.slice(0, html.indexOf('<body'));
    assert.match(head, /<script src="assets\/js\/prefs-boot\.js"><\/script>/);
    assert.doesNotMatch(head, /prefs-boot\.js"[^>]*(?:defer|async|type="module")/);
    // Reachable signed out: the theme is this browser's, not the account's.
    const side = html.slice(html.indexOf('<aside class="lxside"'), html.indexOf('</aside>', html.indexOf('<aside class="lxside"')));
    assert.match(side, /<a class="lxnav" href="\/settings" data-route="settings" data-tip="Settings">/);
  });

  it('derives every step of the ladder from one hue and paints the backdrop under the page', async () => {
    const css = await source('assets/css/prefs.css');
    for (const [step, lightness] of [[1, '0.183'], [2, '0.228'], [3, '0.265'], [4, '0.307'], [5, '0.352']]) {
      assert.match(css, new RegExp(`--lx-${step}: oklch\\(${lightness} var\\(--lx-c\\) var\\(--lx-h\\)\\);`));
    }
    assert.match(css, /:root\[data-lxtheme\] body\.lx::before \{[^}]*position: fixed; inset: 0; z-index: 0;[^}]*background: var\(--lx-backdrop, var\(--lx-1\)\);/);
    assert.match(css, /:root\[data-motion="reduce"\] \*,/);
    assert.match(css, /:root\[data-chat-wins="off"\] \.chat \.msg--hit \{ display: none; \}/);
    assert.match(css, /:root\[data-hide-balance\] \.lxbal \.cashpill__n \{\s*filter: blur/);
    // The theme tiles are radios, chosen with a tick as well as a ring.
    assert.match(css, /\.lxtheme:has\(:checked\)::after \{/);
  });

  it('builds the preferences once and repaints only the account part under them', async () => {
    const account = await source('assets/js/account.js');
    const paint = account.slice(account.indexOf('function paintSettings()'), account.indexOf('const INVITE_CODE'));
    assert.match(paint, /if \(!mine\) \{\s*mine = el\('div', 'acct__mine'\);\s*root\.replaceChildren\(buildPreferences\(\), mine\);\s*\}\s*mine\.innerHTML = '';/);
    assert.doesNotMatch(paint, /root\.innerHTML = ''/);
    const settings = await source('assets/js/settings.js');
    assert.match(settings, /input\.setAttribute\('role', 'switch'\)/);
    assert.match(settings, /input\.type = 'radio';\s*input\.name = 'lxtheme';/);
  });

  it('lets reduced motion come from the switch as well as the device', async () => {
    const holder = globalThis as { document?: unknown; matchMedia?: unknown };
    holder.matchMedia = () => ({ matches: false });
    const util = (await import(pathToFileURL(path.join(frontend, 'assets/js/util.js')).href)) as {
      reduceMotion: () => boolean;
    };
    try {
      holder.document = { documentElement: { dataset: {} } };
      assert.equal(util.reduceMotion(), false);
      holder.document = { documentElement: { dataset: { motion: 'reduce' } } };
      assert.equal(util.reduceMotion(), true);
    } finally {
      delete holder.document;
      delete holder.matchMedia;
    }
  });

  it('keeps the volume between 0 and 100 and remembers it with the other settings', async () => {
    const saved: unknown[] = [];
    const holder = globalThis as { DonutPrefs?: unknown };
    holder.DonutPrefs = { get: () => ({ volume: 40 }), update: (patch: unknown) => saved.push(patch) };
    try {
      const copy = `${pathToFileURL(path.join(frontend, 'assets/js/audio-engine.js')).href}?volume`;
      const audio = (await import(copy)) as { getVolume(): number; setVolume(v: unknown): number };
      assert.equal(audio.getVolume(), 40);
      assert.equal(audio.setVolume(150), 100);
      assert.equal(audio.setVolume(-3), 0);
      assert.equal(audio.setVolume('nope'), 0);
      assert.equal(audio.setVolume(62), 62);
      assert.deepEqual(saved, [{ volume: 100 }, { volume: 0 }, { volume: 62 }]);
    } finally {
      delete holder.DonutPrefs;
    }
  });
});
