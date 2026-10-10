import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The "How it works" button above each game explains how to play. The house edge figures that
 * used to close several of them came off at the operator's request (2026-10-10); the edge itself is
 * unchanged and still shown where it belongs, on the crate drop tables and the fairness page. */

const repo = path.resolve(import.meta.dirname, '../../..');

describe('the How it works hint above each game', () => {
  it('explains the game without quoting the house edge', async () => {
    const html = await readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/index.html'), 'utf8');
    const hints = [...html.matchAll(
      /<button class="ihint phead__how" type="button"\s*aria-label="How it works: ([^"]*)"\s*data-tip="([^"]*)"/g,
    )];
    assert.ok(hints.length >= 10, `expected a hint on every game page, found ${hints.length}`);
    for (const [, label, tip] of hints) {
      // The spoken label and the bubble say the same thing.
      assert.equal(label, tip);
      assert.doesNotMatch(tip!, /house edge|house margin|takes no edge|returns 90%/i, tip);
    }
  });
});
