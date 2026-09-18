import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { verifyTurnstile } from '../src/lib/turnstile.js';

const config = { turnstileSecretKey: '0xSECRET' } as unknown as AppConfig;

function respond(body: unknown, ok = true, status = 200) {
  return mock.method(
    globalThis,
    'fetch',
    async () =>
      ({
        ok,
        status,
        text: async () => JSON.stringify(body),
      }) as unknown as Response,
  );
}

describe('turnstile verification', () => {
  it('accepts only what Cloudflare says succeeded', async (t) => {
    t.after(() => mock.restoreAll());
    respond({ success: true });
    await verifyTurnstile(config, 'token-from-the-widget');
  });

  it('refuses a token Cloudflare rejects', async (t) => {
    t.after(() => mock.restoreAll());
    respond({ success: false, 'error-codes': ['invalid-input-response'] });
    await assert.rejects(() => verifyTurnstile(config, 'stale-token'), /was not passed/);
  });

  it('sends the secret and the token, and never the secret to the browser', async (t) => {
    t.after(() => mock.restoreAll());
    const fetcher = respond({ success: true });
    await verifyTurnstile(config, 'a-token', '203.0.113.9');

    const [url, init] = fetcher.mock.calls[0]!.arguments as [string, RequestInit];
    assert.match(String(url), /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
    const body = String(init.body);
    assert.match(body, /secret=0xSECRET/);
    assert.match(body, /response=a-token/);
    // Advisory on Cloudflare's side, but passing it is free and sharpens their scoring.
    assert.match(body, /remoteip=203.0.113.9/);
  });

  it('fails closed when Cloudflare cannot be reached', async (t) => {
    /* Refusing sign-ins during a Cloudflare outage is recoverable. Passing them would mean the
     * challenge can be removed by anyone able to stop this one request from completing. */
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('network down');
    });
    await assert.rejects(() => verifyTurnstile(config, 'a-token'), /Could not check the challenge/);
  });

  it('separates a misconfigured deployment from a person who failed', async (t) => {
    /* "Your secret key is wrong" is not something a player can act on, and telling them to try
     * again would have them retry forever against a server that can never pass them. */
    t.after(() => mock.restoreAll());
    respond({ success: false, 'error-codes': ['invalid-input-secret'] });
    await assert.rejects(() => verifyTurnstile(config, 'a-token'), /not configured correctly/);
  });

  it('rejects a malformed token without calling out at all', async (t) => {
    t.after(() => mock.restoreAll());
    const fetcher = respond({ success: true });
    await assert.rejects(() => verifyTurnstile(config, 'has spaces'), /Complete the challenge/);
    assert.equal(fetcher.mock.calls.length, 0);
  });

  it('checks the challenge before the request costs anything', async () => {
    /* Verified against the source: a challenge checked after the bot lookup and the expiry sweep
     * would let an unsolved request do that work first, which is the work a flood is trying to
     * make this server do. */
    const source = await readFile(path.join(process.cwd(), 'src/routes/auth-pay.ts'), 'utf8');
    const start = source.indexOf("'/v1/auth/pay/start'");
    const verify = source.indexOf('verifyTurnstile(config', start);
    const botLookup = source.indexOf('await selectOnlineBot()', start);
    assert.ok(verify > start, 'the start route does not verify a challenge');
    assert.ok(verify < botLookup, 'the challenge is checked after the bot lookup');
  });
});
