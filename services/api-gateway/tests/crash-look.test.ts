import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Crash's casino-floor look (2026-11-10): a flat curve with a rocket riding its head, a burst where it
 * busts, a win card for the viewer's own cash-out, and the round's own sounds. Flat: no glow, no line
 * of text saying how a round went, no frame or banner on a bust. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the crash table', () => {
  it('draws the curve flat, a rocket on its head, a burst where it busts', async () => {
    const page = await read('assets/js/crash.js');
    assert.doesNotMatch(page, /shadowBlur|shadowColor/);
    assert.match(page, /drawBurst\(hx, hy, Date\.now\(\) - bustAt\);\n\s*\} else \{\n\s*drawSparks\(hx, hy, angle\);\n\s*drawRocket\(hx, hy, angle\);/);
    // The sparks spread from a seed, not Math.random.
    assert.doesNotMatch(page, /Math\.random\(/);
  });

  it('keeps the rocket steady: the exact multiplier, the curve’s own slope, a clock that never jolts', async () => {
    const page = await read('assets/js/crash.js');
    // Drawn to the floored hundredths, the tip went flat and stepped every 0.01x and the rocket,
    // aimed along the last few samples, swung up to 22° between frames.
    assert.match(page, /const exact = 100 \* Math\.exp\(growth\(\) \* seconds\);/);
    assert.match(page, /drawCurve\(seconds, exact, \{ markers: markersFor\(snap\.bets, x\) \}\);/);
    assert.match(page, /const angle = Math\.atan2\(\(-g \* tip \* \(h - pad\.t - pad\.b\)\) \/ spanY, \(w - pad\.l - pad\.r\) \/ spanX\);/);
    assert.doesNotMatch(page, /points\[Math\.max\(0, points\.length - 4\)\]/);
    // A refresh nudges the clock rather than resetting it, and the round never steps back.
    assert.match(page, /syncClock\(Date\.parse\(next\.serverTime\) - \(sent \+ received\) \/ 2, received - sent\);/);
    assert.match(page, /if \(flown\.id === snap\.round\.id\) seconds = Math\.max\(seconds, flown\.seconds\);/);
  });

  it('says nothing in words about how a round went, and shows a card for a cash-out only', async () => {
    const page = await read('assets/js/crash.js');
    // (The screen reader's one sentence per event still says it; nothing on screen does.)
    assert.doesNotMatch(page, /crashMine|Last round: busted|status\.textContent = bust|'In the air'|Current payout/);
    assert.doesNotMatch(page, /tone: 'lost'/);
    assert.match(page, /<div class="crash__card" id="crashCard" aria-hidden="true" hidden><b><\/b><span><\/span><\/div>/);
    assert.match(page, /countUp\(\$\('span', card\), Number\(out\.payoutMinor\), 650\);/);
    const frame = await read('assets/css/luxe-games.css');
    assert.doesNotMatch(frame, /\.crash\[data-phase="busted"\] \.crash__stage \{ border: 0; box-shadow: inset/);
  });

  it('has its own sounds, a ping at every whole multiplier', async () => {
    const [page, audio] = await Promise.all([read('assets/js/crash.js'), read('assets/js/audio-engine.js')]);
    for (const cue of ['crashBet', 'crashTick', 'crashLaunch', 'crashUp', 'crashBust', 'crashCash']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `crash.js plays ${cue}`);
    }
    assert.match(page, /if \(whole > lastWhole && lastPhase === 'running'\) milestone\(whole\);/);
    assert.match(page, /if \(phase === 'busted' && lastPhase === 'running'\) bustFx\(\);/);
    assert.match(page, /id="crashGo" type="submit" aria-keyshortcuts="Space" data-sfx="none"/);
  });

  it('is flat: one row of picks, buttons on a lip, a green cash-out, still under reduced motion', async () => {
    const css = await read('assets/css/crash.css');
    assert.doesNotMatch(css, /blur\(|drop-shadow|radial-gradient/);
    assert.match(css, /\.crash__picks \{ display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/);
    assert.match(css, /body\.lx #crashGo:active:not\(:disabled\) \{ transform: translateY\(3px\);/);
    assert.match(css, /body\.lx #crashGo\[data-tone="cash"\] \{ background: var\(--crash-win\);/);
    assert.match(css, /body\.lx \.crash \.crash__pick\[aria-pressed="true"\] \{ background: var\(--lx-gold\); color: var\(--lx-on-gold\); box-shadow: none; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^]*\.crash__past\[data-fresh="1"\] \{ animation: none; \}/);
  });
});
