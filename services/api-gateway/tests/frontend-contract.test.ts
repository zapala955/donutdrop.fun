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

  it('signs the player in on confirmation, and stays retryable if that fails', async () => {
    /* The Finish button is gone. Confirmation means the bot has already seen the payment, so there
     * was nothing left for the player to decide and the button only made them wait.
     *
     * Retryable is still asserted, and matters more now than it did: completion is a separate
     * request from the confirmation, so it can fail on its own AFTER the money has been paid. The
     * block that offers another go must exist and must start hidden — a player holding a receipt
     * for a session they never got is the one outcome this flow must not produce. */
    const app = await source('assets/js/app.js');
    const store = await source('assets/js/store.js');
    assert.doesNotMatch(app, /Admin TOTP|linkTotp/);
    assert.match(app, /await finishLogin\(challengeId, body\);/);
    assert.doesNotMatch(app, /Finish login/);
    assert.match(app, /<div id="linkFinish" hidden>/);
    assert.match(app, /type="button" id="linkComplete">Try again</);
    // Wired once, so a second failure cannot queue a second completion against a spent payment.
    assert.match(app, /button\.dataset\.wired = '1';/);
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
    /* The arguments are not the point and pinning them broke this when the settlement was made
       deferrable. What matters is that the outcome is AWAITED FROM THE SERVER here and that the
       module holds no source of chance, which the assertions above and below cover. */
    assert.match(upgrader, /await runBalanceUpgrade\(\s*wagered\.toString\(\), destination/);
    /* And that whatever it defers, it still settles: a deferred round that is never settled is a
       balance that never updates. */
    assert.match(upgrader, /response\.settle\(\)/);
  });

  it('exposes the cash-only routes and API base configuration', async () => {
    const html = await source('index.html');
    assert.match(html, /meta name="api-base-url"/);
    // The platform runs on cash: there is no inventory to route to any more.
    assert.doesNotMatch(html, /data-route="inventory"/);
    assert.doesNotMatch(html, /data-view="inventory"/);
    // Linked from the menu AND reachable.
    for (const route of ['crates', 'upgrader', 'fairness']) {
      assert.match(html, new RegExp(`data-route="${route}"`));
      assert.match(html, new RegExp(`data-view="${route}"`));
    }
    /* Reachable, but no longer on the menu. Skill Duels, Quests & Streak and Faction War were
     * taken off the board together; their views stay so an existing link or bookmark still
     * resolves, and so restoring the menu block is all it takes to put a mode back. */
    for (const view of ['quests', 'war', 'skill-duel']) {
      assert.match(html, new RegExp(`data-view="${view}"`));
      assert.doesNotMatch(html, new RegExp(`data-route="${view}"`));
    }
  });

  it('keeps the profile focused on identity, balance and wallet actions', async () => {
    const account = await source('assets/js/account.js');
    const start = account.indexOf('function paintProfile()');
    const end = account.indexOf('let walletRoot', start);
    const profile = account.slice(start, end);
    assert.doesNotMatch(profile, /\['Status'/);
    assert.doesNotMatch(profile, /\['Role'/);
    assert.doesNotMatch(profile, /panel\('Terms'\)/);
    assert.match(profile, /\$\('#depositBtn'\)\?\.click\(\)/);
    assert.match(profile, /\$\('#withdrawBtn'\)\?\.click\(\)/);
  });

  it('shows the invite offer and collects referral share from one Rewards page', async () => {
    const html = await source('index.html');
    const app = await source('assets/js/app.js');
    const store = await source('assets/js/store.js');
    const rewards = await source('assets/js/rakeback.js');
    /* No figure in the markup. The reward is an admin setting now, so a number typed here would be
     * wrong the first time somebody changed it; the server's terms fill it in, as for the nav pill. */
    assert.match(html, /id="menuInvites"><\/b> Invites/);
    assert.match(app, /state\.referrals\?\.terms\?\.bonusMinor/);
    assert.match(html, /href="\/rewards" data-route="rewards"/);
    assert.match(html, /data-view="rewards"/);
    assert.doesNotMatch(html, />Rakeback<\/span>/);
    assert.match(app, /requested === 'rakeback' \? 'rewards' : requested/);
    assert.match(store, /api\.post\('\/v1\/referrals\/claim', \{\}\)/);
    assert.match(rewards, /claimReferralRewards\(\)/);
    const referralCard = rewards.slice(
      rewards.indexOf('function referralCard('),
      rewards.indexOf('function tierCard('),
    );
    assert.doesNotMatch(referralCard, /rake__rate|% of wagers/);
  });

  it('shows the server-enforced daily wager progress before enabling a streak claim', async () => {
    const html = await source('index.html');
    const daily = await source('assets/js/daily.js');
    const quests = await source('assets/js/quests.js');
    assert.match(html, /Wager at least \$10M each UTC day to claim/);
    assert.match(daily, /streak\.wagerRequirementMet/);
    assert.match(daily, /streak\.wagerRemainingMinor/);
    assert.match(daily, /daily__track/);
    assert.match(quests, /streak\.wagerRequirementMet/);
  });

  it('uses clean public paths while preserving old fragment bookmarks', async () => {
    const html = await source('index.html');
    const app = await source('assets/js/app.js');
    const battles = await source('assets/js/battles.js');
    const referrals = await source('assets/js/referrals.js');
    const routing = await source('assets/js/routing.js');
    const nginx = await readFile(
      path.resolve(import.meta.dirname, '../../../infra/nginx/nginx.conf'),
      'utf8',
    );
    const referralRoutes = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/referrals.ts'),
      'utf8',
    );

    assert.doesNotMatch(html, /href="#\//);
    assert.match(html, /href="\/terms"/);
    assert.match(app, /currentRouteName\(\)/);
    assert.match(app, /onNavigate\(route\)/);
    assert.doesNotMatch(app, /hashchange|location\.hash/);
    assert.match(battles, /\/battles\?code=/);
    assert.doesNotMatch(battles, /location\.hash|#\/battles/);
    assert.match(referrals, /URLSearchParams\(location\.search\)/);
    assert.match(routing, /migrateLegacyHashRoute/);
    assert.match(routing, /query\.set\('code', parts\[1\]\)/);
    assert.match(nginx, /\|terms\)\$/);
    assert.match(referralRoutes, /\$\{config\.appOrigin\}\/\?ref=\$\{code\}/);
    assert.match(referralRoutes, /\$\{config\.appOrigin\}\/referrals\?discord=/);
    assert.doesNotMatch(referralRoutes, /\/#\//);
  });

  it('renders Terms as a basic document instead of an economics dashboard', async () => {
    const info = await source('assets/js/info.js');
    const start = info.indexOf('function paintTerms()');
    const end = info.indexOf('// ─────────── shared', start);
    const terms = info.slice(start, end);
    assert.match(terms, /1\. Eligibility/);
    assert.match(terms, /3\. Balances and gameplay/);
    assert.match(terms, /10\. Questions/);
    assert.doesNotMatch(terms, /18 years|18\+|legal age/i);
    assert.doesNotMatch(terms, /House edge|Return to player|not published yet|acct__facts/);
  });

  it('quotes the signup bonus and the invite offer from the server, never from the markup', async () => {
    /* Both figures are admin settings. A number typed into the page is wrong the first time
     * somebody changes one, so every place that shows an offer reads /v1/promotions and hides
     * itself until it has. */
    const html = await source('index.html');
    const app = await source('assets/js/app.js');
    const store = await source('assets/js/store.js');
    assert.match(store, /api\.get\('\/v1\/promotions'\)/);

    const bar = /<a class="invitebar" id="inviteBar" href="\/referrals" hidden>[\s\S]*?<\/a>/.exec(html)?.[0];
    assert.ok(bar, 'the lobby invite strip is missing or not hidden by default');
    assert.doesNotMatch(bar, /\$\d/);
    assert.match(app, /state\.promotions\?\.referral/);
    // Signed out, the strip opens the signup form rather than the referrals page's dead end.
    assert.match(app, /if \(state\.authenticated\) return;\s*event\.preventDefault\(\);\s*openLoginModal\(\);/);

    assert.match(app, /<div class="auth__bonus" id="linkBonus" hidden>/);
    assert.match(app, /state\.promotions\?\.signupBonus/);
    // The lock is stated beside the amount, not discovered at the withdraw button.
    assert.match(app, /it can be withdrawn once you have wagered \$\{money\(wager\)\}/);
  });

  it('shows what is still owed instead of a withdraw form that cannot succeed', async () => {
    const app = await source('assets/js/app.js');
    const start = app.indexOf('async function openWithdrawModal()');
    const flow = app.slice(start, app.indexOf('function paintWithdrawCooldown(', start));
    const owed = flow.indexOf('info.wagerRequirementRemainingMinor');
    const form = flow.indexOf('<form id="wdForm"');
    assert.ok(owed > 0 && form > owed, 'the withdraw form is drawn before the requirement is checked');
    assert.match(flow, /paintWithdrawLocked\(host, owed\)/);
  });

  it('sends the Discord menu row straight to the same invite as the nav pill', async () => {
    const html = await source('index.html');
    const discordRows = [...html.matchAll(/<a class="menu__row"[^>]*>[\s\S]*?<\/a>/g)]
      .filter((match) => match[0].includes('<span>Discord</span>'));

    assert.equal(discordRows.length, 1);
    const row = discordRows[0]?.[0] ?? '';
    // Two links to one server must not drift onto two invites when somebody rotates one of them.
    const invite = html.match(/<a class="navdc" href="([^"]+)"/)?.[1];
    assert.ok(invite, 'the nav Discord pill is missing');
    assert.ok(row.includes(`href="${invite}"`), 'the menu row and the nav pill use different invites');
    assert.match(row, /target="_blank" rel="noopener noreferrer"/);
    assert.match(row, /aria-label="Discord \(opens in a new tab\)"/);
    assert.match(row, /<svg class="menu__ico menu__ico--brand"/);
  });

  it('measures the chat tail before appending so initial and incoming messages stay visible', async () => {
    const chat = await source('assets/js/chat.js');
    const start = chat.indexOf('function appendLine(');
    const end = chat.indexOf('function trim()', start);
    const append = chat.slice(start, end);
    const measurement = append.indexOf('const followTail =');
    const mutation = append.indexOf('log.appendChild(node)');
    assert.ok(measurement >= 0, 'chat does not decide whether to follow its tail');
    assert.ok(mutation >= 0, 'chat does not append new lines');
    assert.ok(measurement < mutation, 'chat measures the tail after changing its height');
    assert.match(append, /!log\.children\.length/);
    assert.match(append, /if \(followTail\) log\.scrollTop = log\.scrollHeight/);
  });

  it('inserts mixed chat messages and big-hit cards at their chronological position', async () => {
    const chat = await source('assets/js/chat.js');
    const start = chat.indexOf('function appendLine(');
    const end = chat.indexOf('function trim()', start);
    const append = chat.slice(start, end);
    assert.match(append, /for \(const child of log\.children\)/);
    assert.match(append, /Number\(child\.dataset\.at \|\| 0\) <= nodeAt/);
    assert.match(append, /log\.insertBefore\(node, child\)/);
    assert.doesNotMatch(append, /const previous = log\.lastElementChild/);
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

  it('keeps the meta policy and the header policy in step', async () => {
    /* Two policies are served: a <meta> in the page and a header from nginx. A browser enforces
     * BOTH, so the effective policy is their intersection — widening one alone blocks the thing
     * anyway, which is how the sign-in challenge came to be allowed by the page and refused by the
     * header at the same time. Whatever one admits beyond 'self', the other has to admit too. */
    const html = await source('index.html');
    /* The tag's own content, not the page. A long comment above it explains the policy in prose
     * and names the same directives, which a looser match reads as the policy itself. */
    const metaPolicy =
      /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
    assert.ok(metaPolicy, 'no Content-Security-Policy meta tag');
    const headers = await readFile(
      path.resolve(import.meta.dirname, '../../../infra/nginx/security-headers.conf'),
      'utf8',
    );

    const origins = (policy: string, directive: string): Set<string> => {
      const found = new RegExp(`${directive} ([^;"]*)`).exec(policy);
      return new Set(
        (found?.[1] ?? '')
          .split(/\s+/)
          .filter((token) => token.startsWith('https://') || token.startsWith('wss://')),
      );
    };

    for (const directive of ['script-src', 'frame-src', 'img-src']) {
      const inPage = origins(metaPolicy, directive);
      const inHeader = origins(headers, directive);
      for (const origin of inPage) {
        assert.ok(
          inHeader.has(origin),
          `${directive} allows ${origin} in index.html but not in security-headers.conf`,
        );
      }
      for (const origin of inHeader) {
        assert.ok(
          inPage.has(origin),
          `${directive} allows ${origin} in security-headers.conf but not in index.html`,
        );
      }
    }
    assert.doesNotMatch(metaPolicy, /mc-heads\.net/);
    assert.doesNotMatch(headers, /mc-heads\.net/);
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
    for (const file of ['crates.js', 'war.js', 'quests.js', 'fair.js', 'ticker.js']) {
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

describe('the admin console is never served stale', () => {
  const nginx = () =>
    readFile(path.resolve(import.meta.dirname, '../../../infra/nginx/nginx.conf'), 'utf8');

  it('caches its script exactly as it caches the markup that loads it', async () => {
    /* The bug this exists for.
     *
     * /admin/index.html was no-store and /admin/admin.js was "max-age=0, must-revalidate". The
     * markup was therefore always fresh while the script it loads could be answered from a cache,
     * so a deploy could land new HTML wired to old JavaScript. That fails in total silence: the
     * new button renders, the handler that would bind it never arrives, and clicking does nothing
     * at all — no error, no console output, nothing to search for.
     *
     * "must-revalidate" did not prevent it because it is a promise to the browser, and a CDN in
     * front of the origin may cache the response and rewrite the max-age it passes on. The two
     * files have to carry the SAME instruction, and it has to be the one nothing caches.
     */
    const conf = await nginx();
    const block = (pattern: RegExp): string => {
      const start = conf.search(pattern);
      assert.ok(start >= 0, `no location block matching ${pattern}`);
      const open = conf.indexOf('{', start);
      return conf.slice(open, conf.indexOf('}', open));
    };
    const cacheControl = (body: string): string => {
      const found = /add_header\s+Cache-Control\s+"([^"]*)"/.exec(body);
      assert.ok(found, 'a location block sets no Cache-Control');
      return found[1] ?? '';
    };

    const markup = cacheControl(block(/location ~ \^\/admin\/\(\?:index\\.html\)\?\$/));
    const bundle = cacheControl(block(/location ~ \^\/admin\/\(\?:admin\\.js\|admin\\.css\)\$/));
    assert.equal(bundle, markup, 'the admin script and its HTML disagree about caching');
    assert.equal(bundle, 'no-store');
  });

  it('asks for its bundle by a versioned url', async () => {
    /* Belt to the header's braces, and the only half that helps while a cache already holds a
     * copy: a changed URL is a key nothing has an answer for. */
    const html = await readFile(path.join(frontend, 'admin/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]+src="(admin\.js[^"]*)"/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<link[^>]+href="(admin\.css[^"]*)"/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1, 'expected exactly one admin.js script tag');
    assert.equal(styles.length, 1, 'expected exactly one admin.css link tag');
    for (const asset of [...scripts, ...styles]) assert.match(asset ?? '', /\?v=\d+$/, asset);
  });
});
