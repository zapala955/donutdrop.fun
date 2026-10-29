/* view3d.js — the switch between a game's 3D scene and its flat board.
 *
 * Every game with a 3D scene keeps its flat 2D version underneath (for a machine without WebGL, and
 * for a screen reader), so the player can simply choose it. One choice for the whole site, kept with
 * the other display settings (prefs-boot.js, `view`): whoever wants the flat boards wants them on
 * every game, not one at a time. Nothing stored means 3D.
 *
 * The switch is everywhere: on every game's panel, in the top bar on every page, and on the settings
 * page. A change made in any of them is announced (`onViewChange`), and every game page that has a
 * scene follows at once: 2D puts every scene away, 3D builds the one on screen (the others build
 * theirs when they are next opened).
 *
 * The page owns what switching means -- putting its scene away or building it again -- and paints
 * the switch with `paintViewSwitch`. While the flat board is showing, the page's root carries
 * `data-scene="2d"`, which hides its graphics setting (view3d.css): there is nothing to set.
 */

export const wants3d = () => globalThis.DonutPrefs?.get?.().view !== '2d';

const EVENT = 'donut:view3d';

export function setWants3d(on) {
  if (Boolean(on) === wants3d()) return;
  globalThis.DonutPrefs?.update?.({ view: on ? undefined : '2d' });
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: Boolean(on) }));
}

/** Calls `fn(on)` whenever the choice changes, wherever it was made. */
export function onViewChange(fn) {
  globalThis.addEventListener?.(EVENT, (event) => fn(Boolean(event.detail)));
}

/** The switch: a row like the graphics one, "View" and two buttons. */
export function viewSwitch(id) {
  return `
    <div class="view3d" id="${id}" role="group" aria-label="View">
      <span class="view3d__label" aria-hidden="true">View</span>
      <span class="view3d__seg">
        <button type="button" data-mode="3d" aria-pressed="true">3D</button>
        <button type="button" data-mode="2d" aria-pressed="false">2D</button>
      </span>
    </div>`;
}

/** Which button is down, whether either can be pressed now, and the root's `data-scene`. */
export function paintViewSwitch(root, group, { disabled = false } = {}) {
  const on = wants3d();
  const scene = on ? '3d' : '2d';
  if (root && root.dataset.scene !== scene) root.dataset.scene = scene;
  if (!group) return;
  for (const button of group.querySelectorAll('button')) {
    const pressed = String((button.dataset.mode === '3d') === on);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    if (button.disabled !== disabled) button.disabled = disabled;
  }
}

/** The top bar's switch: one button, 3D or 2D written on it, gold while the games are in 3D. */
export function mountViewToggle(button) {
  if (!button) return;
  const text = button.querySelector('.view3dbtn__txt');
  const paint = () => {
    const on = wants3d();
    const label = on ? 'Games in 3D: switch to 2D' : 'Games in 2D: switch to 3D';
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', label);
    button.title = label;
    if (text) text.textContent = on ? '3D' : '2D';
  };
  button.addEventListener('click', () => setWants3d(!wants3d()));
  onViewChange(paint);
  paint();
}

/** Calls `choose(true)` for 3D and `choose(false)` for 2D. */
export function onViewSwitch(group, choose) {
  for (const button of group?.querySelectorAll('button') ?? []) {
    button.addEventListener('click', () => choose(button.dataset.mode === '3d'));
  }
}
