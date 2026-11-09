import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Dice's casino-floor look (2026-11-09): a thick green-and-red rail in a tray with a gold handle, a
 * white die that slides to the roll while its number runs to it, and its own sounds. Flat: no glow. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the dice table', () => {
  it('lands the roll as a die whose number runs to it, then says win or miss', async () => {
    const page = await read('assets/js/dice.js');
    assert.match(page, /<div class="dice__marker" id="diceMarker" role="img" hidden><span class="dice__die"><b>50\.00<\/b><\/span><\/div>/);
    assert.match(page, /<div class="dice__tray">\s*<div class="dice__track" data-side="under">/);
    // Neutral on its way, the number on the slide's own curve, the tone painted on landing.
    assert.match(page, /marker\.dataset\.tone = 'rolling';/);
    assert.match(page, /number\.textContent = hundredths\(Math\.round\(fromRoll \+ \(bet\.roll - fromRoll\) \* eased\)\);/);
    assert.match(page, /await slide\.finished\.catch\(\(\) => undefined\);\s*if \(last !== bet\) return;\s*paintMarker\(\);\s*landSound\(bet\);\s*flashSide\(bet\);/);
    // The die is placed from the rail's edge, the tray's padding included.
    assert.match(page, /const inset = track\.getBoundingClientRect\(\)\.left - rail\.getBoundingClientRect\(\)\.left;/);
  });

  it('has its own sounds: a tick per point of the line, a rattle out, a win, a big win and a miss', async () => {
    const [page, audio] = await Promise.all([read('assets/js/dice.js'), read('assets/js/audio-engine.js')]);
    for (const cue of ['diceTick', 'diceRoll', 'diceWin', 'diceBig', 'diceLose']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `dice.js plays ${cue}`);
    }
    // 10x and up is the big one; the button's generic click is off, the rattle is its sound.
    assert.match(page, /bet\.multiplierBps >= 100_000 \? 'diceBig' : 'diceWin'/);
    assert.match(page, /id="diceGo" type="submit" data-sfx="none"/);
    assert.match(page, /range\.addEventListener\('input', \(\) => \{ setLine\(Number\(range\.value\)\); tickLine\(\); \}\);/);
  });

  it('is flat, keeps a shape difference between the sides, and stops moving for reduced motion', async () => {
    const css = await read('assets/css/dice.css');
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow/);
    // The winning side is thicker as well as green.
    assert.match(css, /\.dice__track\[data-side="under"\] \.dice__zone--lo,\n\.dice__track\[data-side="over"\] \.dice__zone--hi \{\n  height: 14px;/);
    assert.match(css, /\.dice__zone \{\n  position: absolute;\n  top: 50%;\n  height: 10px;/);
    assert.match(css, /body\.lx #diceGo\[aria-busy="true"\]::after \{ animation: none; opacity: 0; \}/);
    const page = await read('assets/js/dice.js');
    assert.match(page, /function flashSide\(bet\) \{\n  if \(reduceMotion\(\)\) return;/);
  });
});
