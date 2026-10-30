import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');

/* Each page with a 3D scene: its file, the scene's variable, its once-only promise, and the id stem
 * of its graphics setting. */
const PAGES = [
  ['mines', 'field', 'fieldTried', 'mines'],
  ['plinko', 'board3d', 'boardTried', 'plinko'],
  ['roulette', 'wheel3d', 'wheelTried', 'roulette'],
  ['crash', 'sky', 'skyTried', 'crash'],
  ['chicken', 'road3d', 'roadTried', 'chicken'],
  ['fishing', 'pond', 'pondTried', 'fishing'],
  ['icefishing', 'lake', 'lakeTried', 'icefish'],
  ['derby', 'track', 'trackTried', 'derby'],
  ['tower', 'tower3d', 'towerTried', 'tower'],
  ['dice', 'range3d', 'rangeTried', 'dice'],
] as const;

describe('the 2D/3D switch', () => {
  it('is one choice for the whole site, kept with the display settings; nothing stored means 3D', async () => {
    const view = await front('assets/js/view3d.js');
    assert.match(view, /export const wants3d = \(\) => globalThis\.DonutPrefs\?\.get\?\.\(\)\.view !== '2d';/);
    assert.match(view, /globalThis\.DonutPrefs\?\.update\?\.\(\{ view: on \? undefined : '2d' \}\);/);
    assert.match(view, /role="group" aria-label="View"/);
    assert.match(view, /if \(root && root\.dataset\.scene !== scene\) root\.dataset\.scene = scene;/);
  });

  for (const [page, scene, tried, stem] of PAGES) {
    it(`${page}: builds no scene while 2D is wanted, and switching puts it away or builds it again`, async () => {
      const js = await front(`assets/js/${page}.js`);
      assert.match(js, /import \{ onViewChange, onViewSwitch, paintViewSwitch, sceneLoaded, sceneLoading, setWants3d, viewSwitch, wants3d \} from '\.\/view3d\.js';/);
      // A change made anywhere else is followed: 2D at once, 3D only on the page on screen.
      assert.ok(js.includes('onViewChange((on) => { if (!on || root?.offsetParent) setView(on); });'));
      assert.ok(js.includes(`if (${tried} || !wants3d()) return ${tried};`));
      // A switch to 2D while the scene downloads puts the new scene away as soon as it is built.
      assert.ok(js.includes(`else if (!wants3d()) {\n`) && js.includes(`built.dispose();\n        ${tried} = null;\n        return;`));
      assert.ok(js.includes(`if (!built) root.dataset.no3d = '';`));
      const setView = js.slice(js.indexOf('function setView(on) {'), js.indexOf('\n}\n', js.indexOf('function setView(on) {')));
      assert.ok(setView.length > 0, 'setView');
      assert.ok(setView.includes(`if (!on && ${scene}) {\n    ${scene}.dispose();\n    ${scene} = null;\n    ${tried} = null;\n    root.dataset.render = '2d';`));
      assert.match(setView, /setWants3d\(on\);/);
      assert.ok(js.includes(`\${viewSwitch('${stem}View')}`));
      assert.ok(js.includes(`onViewSwitch($('#${stem}View', root), setView);`));
      assert.ok(js.includes(`paintViewSwitch(root, $('#${stem}View', root)`));
    });
  }

  it('slots and blackjack follow the same choice', async () => {
    const slots = await front('assets/js/slots.js');
    assert.match(slots, /async function startMachine\(\) \{\s*if \(!wants3d\(\)\) return;/);
    assert.match(slots, /if \(!on && machine\) \{\s*machine\.dispose\(\);\s*machine = null;\s*machineTried = false;\s*root\.dataset\.render = '2d';/);
    assert.ok(slots.includes('onViewSwitch($(`#${P}View`, root), setView);'));
    const blackjack = await front('assets/js/blackjack.js');
    assert.match(blackjack, /import \{ onViewChange, sceneLoaded, sceneLoading, setWants3d, wants3d as wantsScenes \} from '\.\/view3d\.js';/);
    assert.match(blackjack, /onViewChange\(function follow\(\) \{\n\s*if \(busy\) \{\n\s*setTimeout\(follow, 600\);/);
  });

  it('is in the top bar on every page and on the settings page, and announces every change', async () => {
    const [view, index, app, settings] = await Promise.all([front('assets/js/view3d.js'), front('index.html'), front('assets/js/app.js'), front('assets/js/settings.js')]);
    assert.match(view, /globalThis\.dispatchEvent\?\.\(new CustomEvent\(EVENT, \{ detail: Boolean\(on\) \}\)\);/);
    assert.match(index, /<button class="lxicon view3dbtn" id="view3dBtn" type="button" aria-pressed="true"/);
    assert.match(app, /mountViewToggle\(\$\('#view3dBtn'\)\);/);
    assert.match(settings, /title: 'Games in 3D',/);
    assert.match(settings, /onChange: \(on\) => setWants3d\(on\),/);
  });

  it('shows a loading screen, not the flat board, while a wanted scene is on its way', async () => {
    const view = await front('assets/js/view3d.js');
    // Up only when 3D is wanted, WebGL has not already failed, and no scene is drawn yet.
    assert.ok(view.includes(`if (!root || !host || !wants3d() || 'no3d' in root.dataset || root.dataset.render === '3d') return;`));
    assert.ok(view.includes(`if (root.dataset.render !== 'loading') root.dataset.render = 'loading';`));
    assert.ok(view.includes(`if (root?.dataset.render === 'loading') root.dataset.render = '2d';`));
    const css = await front('assets/css/view3d.css');
    assert.match(css, /\.scene3d-load \{ display: none; \}\n\[data-render="loading"\] \.scene3d-load \{\n  position: absolute;\n  inset: 0;\n  z-index: 20;/);
    assert.match(css, /:root\[data-motion='reduce'\] \.scene3d-load__bar \{ display: none; \}/);
  });

  for (const [page, , tried] of PAGES) {
    it(`${page}: puts the loading screen up when the scene starts, and takes it down however the wait ends`, async () => {
      const js = await front(`assets/js/${page}.js`);
      const start = js.slice(js.indexOf(`${tried} = (async () => {`), js.indexOf(`return ${tried};\n}`, js.indexOf(`${tried} = (async () => {`)));
      assert.match(start, /^[^\n]*\n    const host = \$\('[^']+', root\);\n    sceneLoading\(root, host\);\n    try \{/);
      assert.ok(start.includes(`} finally {\n      sceneLoaded(root);\n    }\n  })();`));
      // Switched to 2D while it loads: the flat board at once, not when the scene arrives.
      const setView = js.slice(js.indexOf('function setView(on) {'), js.indexOf('\n}\n', js.indexOf('function setView(on) {')));
      assert.ok(setView.includes('if (!on) sceneLoaded(root);'));
      // A page that waits for its config shows the screen from the moment it opens, and only when a
      // scene is still to be built (a failed one would leave it up for good).
      if (js.includes(`if (config) void start`) || js.includes(`if (config) await start`)) {
        assert.match(js, new RegExp(`\\n  if \\(!${tried}\\) sceneLoading\\(root, \\$\\('[^']+', root\\)\\);\\n  void load\\(\\);\\n\\}\\n`));
        assert.match(js, /\n  if \(config\) (void|await) start[A-Za-z]+\(\);\n  else sceneLoaded\(root\);\n/);
      }
    });
  }

  it('slots, blackjack and coinflip show it too', async () => {
    const slots = await front('assets/js/slots.js');
    assert.ok(slots.includes(`machineTried = true;\n    sceneLoading(root, $('.slots__window', root));`));
    assert.ok(slots.includes(`} finally {\n      sceneLoaded(root);\n    }`));
    assert.ok(slots.includes(`if (!machineTried) sceneLoading(root, $('.slots__window', root));\n    void load();`));
    assert.ok(slots.includes('else if (!config) sceneLoaded(root);'));
    const blackjack = await front('assets/js/blackjack.js');
    assert.ok(blackjack.includes(`const host = $('.bj__table', root);\n  sceneLoading(host, host);\n  starting3d = (async () => {`));
    assert.equal(blackjack.match(/sceneLoaded\(host\);/g)?.length, 2);
    assert.ok(blackjack.includes(`function stop3d() {\n  // Still on its way: the flat table at once, and the scene is put away when it arrives.\n  sceneLoaded($('.bj__table', root));`));
    // Every opening builds the table if 3D is wanted, not only the first.
    assert.ok(blackjack.includes(`    root.dataset.built = '1';\n  }\n  // Every opening`));
    const coinflip = await front('assets/js/coinflip.js');
    assert.ok(coinflip.includes('sceneLoading(coin, coin);\n  void toss3d(coin, game.result)'));
    assert.ok(coinflip.includes(`coin.dataset.render = '3d';\n    await built.flip(result);`));
  });

  it('lays a loading game out as its scene, so nothing jumps when the scene arrives', async () => {
    for (const sheet of ['blackjack', 'chicken', 'coinflip', 'crash', 'derby', 'dice', 'fishing', 'icefishing', 'mines', 'plinko', 'roulette', 'slots', 'tower']) {
      const css = await front(`assets/css/${sheet}.css`);
      const rules = css.match(/\[data-render=["']3d["']\]/g) ?? [];
      const paired = css.match(/\[data-render=(["'])3d\1\], \[data-render=\1loading\1\]/g) ?? [];
      assert.ok(rules.length > 0, sheet);
      assert.equal(paired.length, rules.length, `${sheet}: a 3D rule that does not apply while loading`);
    }
  });

  it('hides the graphics setting on the flat board, and both without WebGL', async () => {
    const css = await front('assets/css/view3d.css');
    assert.match(css, /\[data-scene="2d"\] \[class\$="__gfx"\],\s*\[data-no3d\] \[class\$="__gfx"\],\s*\[data-no3d\] \.view3d \{ display: none; \}/);
    const index = await front('index.html');
    assert.match(index, /<link rel="stylesheet" href="assets\/css\/view3d\.css" \/>/);
    // Every graphics setting is one label whose only class ends in __gfx, which the rule above relies on.
    for (const [page, , , stem] of PAGES) {
      const js = await front(`assets/js/${page}.js`);
      assert.match(js, new RegExp(`<label class="${stem}__gfx" for="${stem}Gfx">`));
    }
  });
});
