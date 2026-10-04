import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * A query handed parameters must have somewhere to put them.
 *
 * PostgreSQL refuses a statement that is bound more values than it has placeholders ("bind message
 * supplies 1 parameters, but prepared statement requires 0"). The route tests run against fake
 * databases that accept anything, so the mistake only shows on a real server: the developer login
 * shipped `client.query('SELECT 1', [user.id])` after the compliance removal and answered every
 * request with a 500 from then on, which hid the whole animation test bench behind a dead login.
 *
 * This reads every source file and checks each `.query('…', [ … ])` / `.query(`…`, [ … ])` call
 * whose SQL is a literal: if it passes an argument list, the SQL must contain a `$n`.
 */
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('SQL parameters', () => {
  it('never binds values to a statement with no placeholder', async () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const call = /\.query(?:<[^>]*>)?\(\s*(['`])([\s\S]*?)\1\s*,\s*\[/g;
    const offenders: string[] = [];
    for (const file of await sources(root)) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(call)) {
        const sql = match[2] ?? '';
        if (!/\$\d/.test(sql)) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(root, file)}:${line} ${sql.trim().slice(0, 60)}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
