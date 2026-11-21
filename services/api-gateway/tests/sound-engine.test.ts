import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The redesign preview's sound (2026-11-21): FM bells, inharmonic coins and filtered noise through
 * one compressed bus with a small room on it, and five Minecraft clips as MP3, which every browser
 * decodes (Safari does not decode the Ogg copies the older player uses). */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the sound engine', () => {
  it('loads the five clips it names, and each is a real MP3 in the site', async () => {
    const engine = await read('assets/js/audio-engine.js');
    assert.match(engine, /const SAMPLE_BASE = '\/assets\/sound\/';/);
    const listed = engine.match(/const SAMPLES = \[([^\]]+)\];/);
    assert.ok(listed, 'SAMPLES');
    const names = [...listed[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    assert.deepEqual(names, ['orb', 'levelup', 'click', 'fizz', 'chestopen']);
    for (const name of names) {
      const bytes = await readFile(path.join(frontend, `assets/sound/${name}.mp3`));
      const id3 = bytes.subarray(0, 3).toString('latin1') === 'ID3';
      const frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
      assert.ok(id3 || frame, `${name}.mp3 is an MP3`);
      assert.ok(bytes.length < 40_000, `${name}.mp3 stays small`);
    }
  });

  it('runs every voice through the compressed bus, the room and a silent start', async () => {
    const engine = await read('assets/js/audio-engine.js');
    assert.match(engine, /const squash = ctx\.createDynamicsCompressor\(\);/);
    assert.match(engine, /verb = ctx\.createConvolver\(\);\n\s*verb\.buffer = room\(ctx, 1\.6, 3\.2\);/);
    // A gain left at its default of 1 lets one full-level sample through before the envelope: a click.
    assert.match(engine, /function envelope\(gain, at, attack, peak, decay\) \{\n\s*gain\.gain\.value = 0\.0001;/);
    // Each voice lets go of its nodes when it ends.
    assert.match(engine, /source\.onended = \(\) => \{\n\s*for \(const node of nodes\) node\.disconnect\(\);/);
  });

  it('repitches a whole cue by the caller\'s rate, and never leaves the pitch behind', async () => {
    const engine = await read('assets/js/audio-engine.js');
    assert.match(engine, /pitch = Number\.isFinite\(rate\) && rate > 0 \? rate : 1;\n\s*try \{\n\s*cue\(ctx\);\n\s*\} catch \{[\s\S]*?\} finally \{\n\s*pitch = 1;/);
    assert.match(engine, /source\.playbackRate\.value = rate \* pitch;/);
    assert.match(engine, /osc\.frequency\.setValueAtTime\(freq \* pitch, at\);/);
  });
});
