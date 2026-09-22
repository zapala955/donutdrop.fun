import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const source = () =>
  readFile(path.resolve(import.meta.dirname, '../src/api-client.ts'), 'utf8');

/* The helper alone. Slicing to the end of the file swept in the whole of ApiClient, and the
 * assertions below are about what THIS function does. */
const helperOf = (code: string) =>
  code.slice(
    code.indexOf('function unsignedResponseError'),
    code.indexOf('export class ApiClient'),
  );

/**
 * The gateway signs every reply it produces for a bot it RECOGNISED, failures included, so an
 * unsigned reply usually means the request never reached a handler -- the bot is unknown to it.
 *
 * Reporting that as "API response authentication timestamp is missing or malformed" described the
 * symptom and discarded the status and error code that name the cause. A 401 became a mystery,
 * repeated every two seconds, with nothing in it to act on.
 */
describe('an unsigned reply says why it was refused', () => {
  it('reports the status and the error code rather than only the missing signature', async () => {
    const code = await source();
    const helper = helperOf(code);
    assert.match(helper, /API \$\{response\.status\}/);
    assert.match(helper, /error\?: \{ code\?: unknown \}/);
  });

  /* A 401 has exactly one likely cause here, and it is not obvious: the API parses the
   * credentials file once at startup, so adding a bot needs the container recreated. */
  it('names the startup-only credential load on an auth failure', async () => {
    const code = await source();
    const helper = helperOf(code);
    assert.match(helper, /response\.status === 401 \|\| response\.status === 403/);
    assert.match(helper, /only reads that file when it STARTS/);
  });

  /* The security property this check exists for: an injected error must not be able to steer the
   * retry, quarantine or job-failure logic. Putting the status in the message does not, because
   * the function still throws on the same path -- but it must stay marked as untrusted. */
  it('still throws, and says the report is unauthenticated', async () => {
    const code = await source();
    const helper = helperOf(code);
    assert.match(helper, /unauthenticated/);
    assert.doesNotMatch(helper, /return (?:true|false|null)\b/);
    // The caller throws it; it never resolves the request.
    const verify = code.slice(code.indexOf('private verifyResponse'));
    assert.match(verify, /throw unsignedResponseError\(response, responseBody\)/);
  });

  it('keeps the old wording for a successful but unsigned reply, which is a real signing fault', async () => {
    const code = await source();
    const helper = helperOf(code);
    assert.match(helper, /if \(response\.ok\) \{\s*return new Error\(\s*'API response authentication timestamp is missing or malformed'/);
  });
});

describe('adding a bot needs the API recreated', () => {
  it('force-recreates rather than trusting up -d to notice a changed file', async () => {
    const script = await readFile(
      path.resolve(import.meta.dirname, '../../../infra/vps/add-vault-bot.sh'),
      'utf8',
    );
    assert.match(script, /up -d --build --force-recreate api/);
  });
});
