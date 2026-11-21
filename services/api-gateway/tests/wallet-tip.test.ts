import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { AppConfig } from '../src/config.js';
import type { Database } from '../src/lib/db.js';
import { registerSocialRoutes } from '../src/routes/social.js';

/*
 * The Wallet's Tip tab (2026-11-21, the preview's third tab). Tips are behind a runtime switch, so
 * the page asks whether they are on before it shows the tab, and sends the same POST as chat's /tip.
 */

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (file: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', file), 'utf8');

async function server(config: object) {
  const app = Fastify();
  const db = { query: async () => ({ rows: [] }) } as unknown as Database;
  await registerSocialRoutes(app, db, config as unknown as AppConfig);
  return app;
}

describe('the Wallet tip tab', () => {
  it('says whether tips are on and what a tip must fit, to anybody, read live', async () => {
    const config = { tipsEnabled: true, tipMinMinor: 100_000n, tipMaxMinor: 100_000_000n };
    const app = await server(config);
    const on = await app.inject({ method: 'GET', url: '/v1/social/tip/info' });
    assert.equal(on.statusCode, 200);
    assert.deepEqual(on.json(), { enabled: true, minMinor: '100000', maxMinor: '100000000' });

    // The admin switch is read when asked, not when the route was built.
    config.tipsEnabled = false;
    const off = await app.inject({ method: 'GET', url: '/v1/social/tip/info' });
    assert.equal(off.json().enabled, false);
  });

  it('shows the tab only while tips are on, and sends what chat sends', async () => {
    const [app, store] = await Promise.all([front('assets/js/app.js'), front('assets/js/store.js')]);
    assert.match(store, /api\.get\('\/v1\/social\/tip\/info'\)/);
    assert.match(store, /api\.post\('\/v1\/social\/tip', \{ toUsername, amountMinor: String\(amountMinor\) \}\)/);
    assert.match(app, /const showsTip = \(current\) => current === 'tip' \|\| Boolean\(tips\?\.enabled\);/);
    assert.match(app, /if \(showsTip\(current\)\) list\.push\(\['tip', 'Tip', openTipModal\]\);/);
    // Nothing is sent until the name and the amount both pass, and the button names both.
    assert.match(app, /const ready = !nameProblem\(\) && !amountProblem\(\);/);
    assert.match(app, /go\.textContent = ready \? `Send \$\{money\(amountOf\(\)\)\} to \$\{nameOf\(\)\}` : 'Send tip';/);
  });
});
