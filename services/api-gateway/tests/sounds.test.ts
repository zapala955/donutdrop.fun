import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(front, relative), 'utf8')).replace(/\r\n/g, '\n');

async function cueTable() {
  const engine = await read('assets/js/audio-engine.js');
  const table = engine.slice(engine.indexOf('const CUES = {'), engine.indexOf('\n};\n', engine.indexOf('const CUES = {')));
  const names = [...table.matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]!);
  const takes = [...new Set([...table.matchAll(/'([a-z]+(?:-[a-z]+)*-?\d*)'/g)].map((m) => m[1]!))];
  return { engine, names, takes };
}

describe('the site sounds', () => {
  it('plays recordings, every one of which ships with the site under its CC0 note', async () => {
    const { takes } = await cueTable();
    assert.ok(takes.length >= 20, `takes found: ${takes.length}`);
    for (const take of takes) {
      await access(path.join(front, 'assets/sound/casino', `${take}.ogg`));
    }
    const shipped = (await readdir(path.join(front, 'assets/sound/casino'))).filter((f) => f.endsWith('.ogg'));
    assert.deepEqual(shipped.map((f) => f.replace(/\.ogg$/, '')).sort(), [...takes].sort(), 'no orphaned or missing sample files');
    const sources = await read('assets/sound/casino/SOURCES.txt');
    assert.match(sources, /CC0/);
    await access(path.join(front, 'assets/sound/casino/LICENSE-kenney.txt'));
  });

  it('has a cue for every sound the pages ask for', async () => {
    const { names } = await cueTable();
    const js = path.join(front, 'assets/js');
    for (const file of (await readdir(js)).filter((f) => f.endsWith('.js'))) {
      const source = await read(`assets/js/${file}`);
      for (const match of source.matchAll(/playSound\('([a-z]+)'/g)) {
        assert.ok(names.includes(match[1]!), `${file} plays '${match[1]}', which is not a cue`);
      }
      // Ternaries choose between cues by name: every one of those names must exist too.
      for (const match of source.matchAll(/playSound\(([^)]*\?[^)]*)\)/g)) {
        for (const name of match[1]!.matchAll(/[?:]\s*'([a-z]+)'/g)) {
          assert.ok(names.includes(name[1]!), `${file} may play '${name[1]}', which is not a cue`);
        }
      }
    }
  });

  it('makes no sound on an ordinary press or a hover', async () => {
    const { engine } = await cueTable();
    const init = engine.slice(engine.indexOf('export function initAudioEngine'));
    assert.doesNotMatch(init, /playSound\(/);
    assert.doesNotMatch(engine, /pointerover/);
    assert.doesNotMatch(engine, /createOscillator/, 'no synthesized beeps left');
  });

  it('climbs a safe step as the run goes on', async () => {
    for (const [file, arg] of [['mines.js', 'game?.revealed?.length'], ['tower.js', 'floor'], ['chicken.js', 'game?.crossed']] as const) {
      const source = await read(`assets/js/${file}`);
      assert.ok(source.includes(`playSound('tick', { rate: stepRate(${arg}) });`), file);
    }
    assert.match(await read('assets/js/blackjack.js'), /await flyIn\(slot, delay\);\n {2}playSound\('card'\);/);
  });
});
