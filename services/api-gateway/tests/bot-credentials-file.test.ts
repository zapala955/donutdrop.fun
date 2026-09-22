import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * The credentials file has to be valid JSON AND exactly one line.
 *
 * `readSecretFile` strips a single trailing newline and then refuses anything that still contains
 * one. Pretty-printing that file is therefore not a formatting choice, it is an outage: the JSON
 * stays valid, every other tool reads it happily, and the gateway will not boot.
 *
 * add-vault-bot.sh wrote it with `indent=2` and took the site down. The edit was checked for being
 * parseable and never for the shape the reader imposes on top of that, which is the part that
 * actually decides whether the API starts.
 */
describe('the file the API loads its bot credentials from', () => {
  it('is read as one line, with a single trailing newline tolerated', async () => {
    const config = await read('services/api-gateway/src/config.ts');
    const reader = config.slice(config.indexOf('function readSecretFile'));
    const body = reader.slice(0, reader.indexOf('\n}'));
    // One trailing newline is stripped...
    assert.ok(
      body.includes(String.raw`.replace(/\r?\n$/, '')`),
      'readSecretFile no longer strips a single trailing newline',
    );
    // ...and anything still carrying a newline is refused outright.
    assert.ok(
      body.includes(String.raw`/[\r\n\0]/.test(value)`),
      'readSecretFile no longer rejects embedded newlines',
    );
    assert.ok(body.includes('must contain exactly one non-empty line'));
  });

  it('is written compactly by the setup script, never pretty-printed', async () => {
    const script = await read('infra/vps/add-vault-bot.sh');
    assert.ok(
      script.includes(`json.dumps(creds, separators=(',', ':'))`),
      'the setup script does not write the credentials file compactly',
    );
    assert.ok(
      !script.includes('json.dump(creds, handle, indent='),
      'the setup script pretty-prints the credentials file, which stops the API booting',
    );
  });

  /* Two guards, because the first lives inside a heredoc a later edit could quietly change, and
   * what it prevents is a full outage rather than one bad row. */
  it('refuses to write a multi-line file, and re-checks the result afterwards', async () => {
    const script = await read('infra/vps/add-vault-bot.sh');
    assert.ok(script.includes('refusing to write a multi-line credentials file'));
    assert.ok(script.includes('wc -l <"$creds_file"'));
    // And restores the backup rather than leaving behind a file the API cannot read.
    assert.ok(script.includes('cp -a "$newest_backup" "$creds_file"'));
  });
});
