import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* 2026-10-25: Fishing was written on a branch as 074, beside a 074 already applied in production.
 * Renamed to 076 it still created donut_schema_ready_v74, which production already had, and the
 * dry run on a copy of production failed on it -- in a real deploy the runner stops at the first
 * failed file and the API never starts. CI could not see it: on an empty database the two 074s ran
 * in an order where nothing clashed. These two rules held for every migration before it, so they
 * are tested now instead of remembered. */

const directory = path.resolve(import.meta.dirname, '../../../packages/db/migrations');

describe('the migration ladder', () => {
  it('gives every migration its own number', async () => {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const seen = new Map<string, string>();
    for (const file of files) {
      const number = file.slice(0, 3);
      assert.match(number, /^\d{3}$/, `${file} does not start with a three-digit number`);
      assert.ok(!seen.has(number), `${file} and ${seen.get(number)} share the number ${number}`);
      seen.set(number, file);
    }
  });

  it("names each schema marker after its own migration's number, once", async () => {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const owner = new Map<number, string>();
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      for (const match of sql.matchAll(/CREATE FUNCTION donut_schema_ready_v(\d+)\(\)/g)) {
        const version = Number(match[1]);
        assert.equal(version, Number(file.slice(0, 3)), `${file} creates donut_schema_ready_v${version}`);
        assert.ok(!owner.has(version), `${file} and ${owner.get(version)} both create v${version}`);
        owner.set(version, file);
      }
    }
  });
});
