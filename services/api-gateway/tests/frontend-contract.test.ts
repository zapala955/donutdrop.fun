import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(frontend, relativePath), 'utf8');
}

describe('frontend/backend contract', () => {
  it('uses one credentialed API client with CSRF and idempotency support', async () => {
    const api = await source('assets/js/api.js');
    const html = await source('index.html');
    assert.match(api, /credentials: 'include'/);
    assert.match(api, /headers\['X-CSRF-Token'\]/);
    assert.match(api, /headers\['Idempotency-Key'\]/);
    assert.match(api, /crypto\.getRandomValues/);
    assert.match(api, /window\.location\.origin/);
    assert.match(html, /meta name="api-base-url" content=""/);
  });

  it('keeps payment-login completion player-facing and retryable', async () => {
    const app = await source('assets/js/app.js');
    const store = await source('assets/js/store.js');
    assert.doesNotMatch(app, /Admin TOTP|linkTotp/);
    assert.match(app, /type="button" id="linkComplete"/);
    assert.match(app, /completionPending = false;\s*button\.disabled = false;/);
    assert.doesNotMatch(store, /completeLogin\(challengeId,\s*adminTotpCode/);
    assert.match(store, /Post-login data refresh failed/);
    assert.match(store, /Authenticated data refresh failed/);
  });

  it('routes every core economic action to the backend', async () => {
    const store = await source('assets/js/store.js');
    assert.match(store, /\/v1\/cases\/'/);
    assert.match(store, /\/v1\/upgrades'/);
    assert.match(store, /\/v1\/inventory\/'/);
    assert.match(store, /\/v1\/withdrawals'/);
    assert.match(store, /\/v1\/balance'/);
    assert.doesNotMatch(store, /localStorage/);
  });

  it('contains no client-side outcome roll in any module that settles a wager', async () => {
    /* Crate opening moved out of app.js into its own controller when the catalogue grew to fifty,
     * and the upgrader is cash-staked now. The guarantee is unchanged and still what matters: no
     * module that settles a wager may contain a source of chance. */
    const app = await source('assets/js/app.js');
    const upgrader = await source('assets/js/upgrader.js');
    const crates = await source('assets/js/crates.js');
    assert.doesNotMatch(app, /Math\.random/);
    assert.doesNotMatch(upgrader, /Math\.random/);
    assert.doesNotMatch(crates, /Math\.random/);
    // every outcome is awaited from the server, never computed here
    assert.match(crates, /await requestCaseOpen\(crate\)/);
    assert.match(upgrader, /await runBalanceUpgrade\(wagered\.toString\(\), destination\)/);
  });

  it('exposes the cash-only routes and API base configuration', async () => {
    const html = await source('index.html');
    assert.match(html, /meta name="api-base-url"/);
    // The platform runs on cash: there is no inventory to route to any more.
    assert.doesNotMatch(html, /data-route="inventory"/);
    assert.doesNotMatch(html, /data-view="inventory"/);
    for (const route of ['crates', 'upgrader', 'piggy', 'quests', 'war', 'fairness']) {
      assert.match(html, new RegExp(`data-route="${route}"`));
      assert.match(html, new RegExp(`data-view="${route}"`));
    }
  });

  it('routes the 1v1 Skill header button straight into the arena', async () => {
    const html = await source('index.html');
    const app = await source('assets/js/app.js');
    // The header entry and the route behind it.
    assert.match(html, /<a class="navlive" href="#\/slither" data-route="slither">/);
    assert.match(html, /data-view="slither"/);
    assert.match(app, /slither: mountSlither/);
    /* The duel lobby the button used to open is still live and still reachable. A mode with money
     * in it is retired by being taken off the board, not by being stranded behind a URL. */
    assert.match(html, /href="#\/skill-duel" data-route="skill-duel"/);
    assert.match(html, /data-view="skill-duel"/);
    assert.match(app, /'skill-duel': mountDuel/);
  });

  it('keeps the arena entry band at $1M to $100M and computes no outcome in the browser', async () => {
    const arena = await source('assets/js/slither.js');
    assert.match(arena, /const MIN_ENTRY = 1_000_000;/);
    assert.match(arena, /const MAX_ENTRY = 100_000_000;/);
    /* Every position, collision, pickup, kill and payout arrives from the server. A source of
     * chance in here — even a cosmetic one — weakens the guarantee the rest of the platform makes,
     * so orb sparkle is derived from the orb's id instead. */
    assert.doesNotMatch(arena, /Math\.random/);
    // The steering frame is the whole client-to-server vocabulary.
    assert.match(arena, /type: 'input', heading: input\.heading, boost: input\.boost/);
  });

  it('displays no fee, rake or percentage anywhere in the arena', async () => {
    /* The platform's cut is applied on the server at the instant of extraction and the socket
     * returns only the figure that reached the wallet. This asserts the absence is structural: the
     * client never receives a rate, so there is nothing here that could render one. */
    const arena = await source('assets/js/slither.js');
    const sheet = await source('assets/css/slither.css');
    for (const [label, body] of [
      ['slither.js', arena],
      ['slither.css', sheet],
    ] as const) {
      for (const forbidden of [/feeBps/, /rakeBps/, /RAKE/, /HOUSE (EDGE|CUT)/]) {
        assert.doesNotMatch(body, forbidden, `${label} must not surface a platform cut`);
      }
    }
  });

  it('parses every browser module as an ES module, not merely as a script', async () => {
    /* WHY THIS IS NOT `node --check`.
     *
     * `node --check file.js` parses with the SCRIPT goal. The browser loads these with the MODULE
     * goal, and the two accept different programs — a file can pass the first and be fatal in the
     * second. That is not hypothetical: a comment inside a GLSL template literal contained a
     * backticked `position.z`, the backtick closed the template, the rest of the shader parsed as
     * JavaScript, and `node --check` said it was fine. In the browser app.js imported it, the whole
     * module graph died before the router ran, and every view stayed hidden — a completely blank
     * page behind working static chrome, which is the hardest failure of all to read.
     *
     * Copying to a .mjs is what forces the module goal, and --check parses without executing, so
     * this needs no DOM.
     */
    const directory = path.join(frontend, 'assets/js');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.js'));
    assert.ok(files.length > 20, 'expected the browser module directory');

    const scratch = await mkdtemp(path.join(tmpdir(), 'donut-esm-'));
    try {
      for (const file of files) {
        const target = path.join(scratch, `${file}.mjs`);
        await writeFile(target, await readFile(path.join(directory, file), 'utf8'));
        try {
          execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
        } catch (error) {
          const detail = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
          assert.fail(`${file} does not parse as an ES module:
${detail}`);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('keeps the arena renderer isolated and uses the WebGL2 instanced path', async () => {
    const arena = await source('assets/js/slither.js');
    const renderer = await source('assets/js/slither-renderer.js');
    assert.match(arena, /createSlitherRenderer/);
    assert.doesNotMatch(arena, /getTHREE|WebGLRenderer/);
    assert.match(renderer, /getContext\('webgl2'/, 'the arena requires a WebGL2 context');
    assert.match(renderer, /drawArraysInstanced/);
    assert.match(renderer, /createShader/);
    assert.match(renderer, /createTexture/);
  });

  it('forbids inline script with a content security policy', async () => {
    const html = await source('index.html');
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /script-src 'self'/);
    // 'unsafe-inline' on script-src would defeat the whole point of having the policy
    assert.doesNotMatch(html, /script-src[^;"]*unsafe-inline/);
    assert.doesNotMatch(html, /script-src[^;"]*unsafe-eval/);
  });

  it('never renders a server-supplied string into innerHTML unescaped', async () => {
    /* Names, blurbs and player labels all originate server-side. Each view module carries its own
     * escapeText and must use it.
     *
     * Only markup is checked, not every interpolation: toast() and openModal() set textContent,
     * which escapes by construction, and flagging those produced a false positive that would have
     * trained someone to ignore this test. So the assertion extracts the template literals that
     * are actually assigned to innerHTML and looks only inside those. */
    const FIELDS = 'name|displayName|blurb|description|player';
    for (const file of ['crates.js', 'war.js', 'quests.js', 'fair.js', 'piggy.js', 'ticker.js']) {
      const module = await source('assets/js/' + file);
      const markup = [...module.matchAll(/innerHTML\s*(?:\+)?=\s*`([\s\S]*?)`;/g)].map(
        (m) => m[1] ?? '',
      );
      for (const block of markup) {
        const bare = block.match(
          new RegExp(`\\$\\{\\s*[a-zA-Z_$][\\w$]*\\.(?:${FIELDS})\\s*\\}`, 'g'),
        );
        assert.equal(
          bare,
          null,
          `${file} interpolates a server string into innerHTML without escaping: ${bare}`,
        );
      }
    }
  });
});
