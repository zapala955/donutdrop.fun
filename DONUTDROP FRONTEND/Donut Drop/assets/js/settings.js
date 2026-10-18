/* settings.js — the preferences on /settings: theme, motion, sound, chat and the top bar.
 *
 * Every setting takes effect the moment it changes, and prefs-boot.js keeps it in this browser and
 * applies it again before the next page paints. There is no Save button. Nothing here costs
 * anything to undo, and a page that holds changes back until a button is pressed loses them the
 * first time somebody navigates away.
 *
 * Nothing on this page reaches the server. The account sections below it (account.js) belong to
 * the server and stay read-only.
 *
 * Every switch is a real one: each changes something on the site today. A setting that does nothing
 * yet does not get a row.
 */
import { isMuted, setMuted, getVolume, setVolume, playSound } from './audio-engine.js';
import { el } from './util.js';

const prefs = () => globalThis.DonutPrefs;
/* What a fresh custom theme starts from: amethyst fading into gold, a pair that shows the
 * picker's range on its first open. */
const CUSTOM_START = { a: '#8b5cf6', b: '#ffaa00', gradient: false };
let seq = 0;
const uid = (name) => `pref-${name}-${(seq += 1)}`;

function textEl(tag, cls, content) {
  const node = el(tag, cls);
  node.textContent = content;
  return node;
}

/** The preference sections, built once per visit: account.js repaints only what sits below them. */
export function buildPreferences() {
  const wrap = el('div', 'prefs');
  if (!prefs()) return wrap; // the boot script did not load: there is nothing to change
  const warn = textEl(
    'p',
    'prefs__warn',
    "This browser isn't keeping settings (a private window, or site data turned off). Changes last until this tab closes.",
  );
  warn.hidden = true;
  warn.setAttribute('role', 'status');
  /* Every change goes through here, so the one place that learns storage is refused can say so. */
  const save = (patch) => {
    if (!prefs().update(patch)) warn.hidden = false;
  };
  wrap.append(warn, appearance(save), sound(), chat(save), streaming(save));
  return wrap;
}

/* ═════════════════════════ building blocks ═════════════════════════ */

function section(title) {
  const sec = el('section', 'prefs__sec');
  const heading = textEl('h2', 'prefs__h', title);
  heading.id = uid('sec');
  sec.setAttribute('aria-labelledby', heading.id);
  sec.append(heading);
  return sec;
}

/** One setting: its name and a line on what it does, with the control on the right. */
function row({ title, hint, control, labelFor }) {
  const line = el('div', 'prefs__row');
  const words = el('div', 'prefs__text');
  const name = textEl(labelFor ? 'label' : 'span', 'prefs__title', title);
  if (labelFor) name.htmlFor = labelFor;
  name.id = uid('title');
  words.append(name);
  if (hint) {
    const note = textEl('p', 'prefs__hint', hint);
    note.id = uid('hint');
    words.append(note);
    control.setAttribute('aria-describedby', note.id);
  }
  line.append(words, control);
  return { line, name };
}

function toggle(checked, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'lxswitch';
  input.id = uid('switch');
  input.setAttribute('role', 'switch');
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function switchRow({ title, hint, checked, onChange }) {
  const input = toggle(checked, onChange);
  return { ...row({ title, hint, control: input, labelFor: input.id }), input };
}

/* ═════════════════════════ appearance ═════════════════════════ */

function appearance(save) {
  const sec = section('Appearance');
  const motion = switchRow({
    title: 'Reduce motion',
    hint: 'Shortens animations across the site and skips the long ones in games, as a reduced-motion setting on your device would.',
    checked: prefs().get().motion === 'reduce',
    onChange: (on) => save({ motion: on ? 'reduce' : undefined }),
  });
  sec.append(themeField(save), motion.line);
  return sec;
}

function themeField(save) {
  const field = el('fieldset', 'lxthemes');
  field.append(textEl('legend', 'prefs__title', 'Theme'));
  const hint = textEl(
    'p',
    'prefs__hint',
    "Recolours the site's backgrounds. Gold stays gold, so buttons and wins look the same on every theme.",
  );
  hint.id = uid('hint');
  field.setAttribute('aria-describedby', hint.id);

  const grid = el('div', 'lxthemes__grid');
  const now = el('p', 'lxthemes__now');
  const editor = customEditor(save, () => paint());
  const choices = [{ id: 'custom', name: 'Custom' }, ...prefs().THEMES];
  const tiles = new Map();
  for (const theme of choices) {
    const tile = swatch(theme);
    tiles.set(theme.id, tile);
    grid.append(tile);
  }

  grid.addEventListener('change', (event) => {
    const id = event.target.value;
    const patch = { theme: id === 'obsidian' ? undefined : id };
    if (id === 'custom' && !prefs().get().custom) patch.custom = { ...CUSTOM_START };
    save(patch);
    paint();
  });

  function paint() {
    const state = prefs().get();
    const id = state.theme === 'custom' || prefs().THEMES.some((t) => t.id === state.theme && t.h !== undefined)
      ? state.theme
      : 'obsidian';
    for (const [key, tile] of tiles) tile.querySelector('input').checked = key === id;
    // The custom tile wears the colours it holds, once it holds some.
    const custom = prefs().themeOf({ theme: 'custom', custom: state.custom });
    if (custom) tiles.get('custom').style.setProperty('--sw', swatchPaint(custom));
    const theme = id === 'custom' ? custom : prefs().THEMES.find((t) => t.id === id);
    now.replaceChildren(
      textEl('b', '', theme?.name ?? 'Obsidian'),
      document.createTextNode(
        id === 'obsidian' ? ' · the default' : id === 'custom' ? ' · your colours' : theme?.from ? ' · gradient' : ' · solid',
      ),
    );
    editor.hidden = id !== 'custom';
    editor.sync();
  }

  field.append(hint, grid, now, editor);
  paint();
  window.addEventListener('lx:prefs', () => {
    if (field.isConnected) paint();
  });
  return field;
}

/** How a theme looks in its tile: a gradient theme's backdrop, or a solid theme's raised surface. */
function swatchPaint(theme) {
  if (theme.h === undefined) return '';
  if (theme.from) return prefs().backdrop(theme);
  // A shade lighter and a touch richer than the page itself, or eight near-blacks look alike.
  return `oklch(0.27 ${Math.min(theme.c * 1.6, 0.08).toFixed(3)} ${theme.h})`;
}

function swatch(theme) {
  const tile = el('label', `lxtheme lxtheme--${theme.id}`);
  tile.title = theme.name;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'lxtheme';
  input.value = theme.id;
  input.className = 'lxtheme__input';
  const name = theme.id === 'custom' ? 'Custom colours' : theme.from ? `${theme.name}, gradient` : theme.name;
  tile.append(input, textEl('span', 'lxsr', name));
  if (theme.id === 'custom') {
    tile.insertAdjacentHTML(
      'beforeend',
      '<svg class="lxtheme__ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1.2"/><circle cx="10.5" cy="7.5" r="1.2"/><circle cx="15.5" cy="7.5" r="1.2"/></svg>',
    );
  } else {
    const paint = swatchPaint(theme);
    if (paint) tile.style.setProperty('--sw', paint);
  }
  return tile;
}

/* The colours of a custom theme. Shown under the grid while Custom is the theme. */
function customEditor(save, repaint) {
  const box = el('div', 'lxcustom');
  const first = colourPick('Colour');
  const second = colourPick('Second colour');
  const blend = switchRow({
    title: 'Fade into a second colour',
    checked: false,
    onChange: (on) => commit({ gradient: on }),
  });
  const note = textEl(
    'p',
    'prefs__hint',
    "Your colours are taken down to the site's own dark shades, so text stays readable whatever you pick.",
  );
  box.append(first.wrap, blend.line, second.wrap, note);

  let frame = 0;
  let pending = {};
  /* A colour picker reports every step of a drag. One write per frame is plenty. */
  function commit(patch) {
    pending = { ...pending, ...patch };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const custom = { ...CUSTOM_START, ...prefs().get().custom, ...pending };
      pending = {};
      save({ theme: 'custom', custom });
      repaint();
    });
  }
  first.input.addEventListener('input', () => commit({ a: first.input.value }));
  second.input.addEventListener('input', () => commit({ b: second.input.value }));

  box.sync = () => {
    const custom = { ...CUSTOM_START, ...prefs().get().custom };
    if (document.activeElement !== first.input) first.input.value = custom.a;
    if (document.activeElement !== second.input) second.input.value = custom.b;
    blend.input.checked = Boolean(custom.gradient);
    second.wrap.hidden = !custom.gradient;
  };
  return box;
}

function colourPick(title) {
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'lxcolour';
  input.id = uid('colour');
  const { line } = row({ title, control: input, labelFor: input.id });
  return { wrap: line, input };
}

/* ═════════════════════════ sound ═════════════════════════ */

/* The volume is kept by the sound engine itself (setVolume), beside the mute it already owned. */
function sound() {
  const sec = section('Sound');
  const effects = switchRow({
    title: 'Sound effects',
    hint: 'Clicks, cash-outs and wins. The speaker in the top bar is the same switch.',
    checked: !isMuted(),
    onChange: (on) => {
      setMuted(!on);
      paintVolume();
    },
  });

  const level = document.createElement('input');
  level.type = 'range';
  level.className = 'lxrange';
  level.id = uid('volume');
  level.min = '0';
  level.max = '100';
  level.step = '5';
  level.value = String(getVolume());
  const readout = el('output', 'prefs__value mono');
  readout.htmlFor = level.id;
  const control = el('div', 'prefs__range');
  control.append(level, readout);
  const volume = row({ title: 'Volume', control, labelFor: level.id });

  function paintVolume() {
    const value = Number(level.value);
    readout.value = `${value}%`;
    level.setAttribute('aria-valuetext', `${value}%`);
    level.style.setProperty('--fill', `${value}%`);
    level.disabled = isMuted();
  }
  level.addEventListener('input', () => {
    setVolume(level.value);
    paintVolume();
  });
  // Let go of the slider and hear the level it is now at.
  level.addEventListener('change', () => playSound('coin'));

  sec.append(effects.line, volume.line);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sec.append(
      textEl(
        'p',
        'prefs__hint prefs__aside',
        'Your device asks for reduced motion, and the site stays quiet while it does.',
      ),
    );
  }
  window.addEventListener('lx:mute', () => {
    effects.input.checked = !isMuted();
    paintVolume();
  });
  paintVolume();
  return sec;
}

/* ═════════════════════════ chat ═════════════════════════ */

function chat(save) {
  const sec = section('Chat');
  const wins = switchRow({
    title: 'Big wins in chat',
    hint: 'The cards for big hits between messages. The live feed keeps every win either way.',
    checked: prefs().get().chatWins !== false,
    onChange: (on) => save({ chatWins: on ? undefined : false }),
  });

  const group = el('div', 'lxseg');
  group.setAttribute('role', 'radiogroup');
  const name = uid('chat-size');
  const now = prefs().get().chatSize ?? 'm';
  for (const [value, label] of [['s', 'Small'], ['m', 'Default'], ['l', 'Large']]) {
    const option = el('label', 'lxseg__opt');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = value === now;
    input.className = 'lxsr';
    option.append(input, textEl('span', '', label));
    group.append(option);
  }
  group.addEventListener('change', (event) => {
    const value = event.target.value;
    save({ chatSize: value === 'm' ? undefined : value });
  });
  const size = row({ title: 'Text size', control: group });
  group.setAttribute('aria-labelledby', size.name.id);

  sec.append(wins.line, size.line);
  return sec;
}

/* ═════════════════════════ streaming ═════════════════════════ */

function streaming(save) {
  const sec = section('Streaming');
  const balance = switchRow({
    title: 'Hide my balance',
    hint: 'Blurs the balance in the top bar, for streams and screenshots. Your wallet page still shows it.',
    checked: prefs().get().hideBalance === true,
    onChange: (on) => save({ hideBalance: on ? true : undefined }),
  });
  sec.append(balance.line);
  return sec;
}
