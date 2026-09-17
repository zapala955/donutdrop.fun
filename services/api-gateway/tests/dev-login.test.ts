import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const routePath = path.resolve(import.meta.dirname, '../src/routes/dev.ts');
const configPath = path.resolve(import.meta.dirname, '../src/config.ts');
const appPath = path.resolve(import.meta.dirname, '../src/app.ts');

/**
 * The developer login is a deliberate authentication bypass. Each of these is one of the fences
 * that keeps it off a production box; any one of them silently regressing turns a convenience
 * into an unauthenticated path to a funded, compliance-cleared account.
 */
describe('developer login fencing', () => {
  it('refuses to start when enabled in production', async () => {
    const config = await readFile(configPath, 'utf8');
    assert.match(config, /env\.DEV_LOGIN_ENABLED && env\.NODE_ENV === 'production'/);
    assert.match(config, /must never be enabled in production: it bypasses authentication/);
  });

  it('refuses to start enabled without a long shared token', async () => {
    const config = await readFile(configPath, 'utf8');
    assert.match(config, /env\.DEV_LOGIN_ENABLED && env\.DEV_LOGIN_TOKEN\.length < 24/);
    assert.match(config, /DEV_LOGIN_TOKEN: z\.string\(\)\.min\(24\)/);
    // off unless explicitly turned on
    assert.match(config, /DEV_LOGIN_ENABLED: booleanString/);
    assert.match(config, /\.default\('false'\)/);
  });

  it('registers no route at all when the flag is off', async () => {
    const route = await readFile(routePath, 'utf8');
    // the guard must be the first thing the registrar does, before any app.post
    const guardIndex = route.indexOf('if (!config.devLoginEnabled) return;');
    const firstRoute = route.indexOf('app.post(');
    assert.ok(guardIndex > 0, 'registrar must bail when the flag is off');
    assert.ok(guardIndex < firstRoute, 'the bail must come before any route is declared');
  });

  it('compares the token in constant time and never by equality', async () => {
    const route = await readFile(routePath, 'utf8');
    assert.match(route, /safeEqualText\(body\.token, config\.devLoginToken\)/);
    assert.doesNotMatch(route, /body\.token === config\.devLoginToken/);
    // an empty configured token must not authorise an empty supplied one
    assert.match(route, /!config\.devLoginToken \|\|/);
  });

  it('never lets the disposable account hold the admin role', async () => {
    const route = await readFile(routePath, 'utf8');
    // the account is created as a player and demoted back if it somehow is not one
    assert.match(route, /role = 'player'/);
    assert.match(route, /user\.role !== 'player'/);
    /* No statement may put 'admin' in a role position. Scoped to the word `role` on the line so
     * that source_type = 'admin' on a seeded lot — a legitimate, unrelated enum value — does not
     * make this pass or fail for the wrong reason. */
    assert.doesNotMatch(route, /role[^\n]*'admin'/);
    assert.doesNotMatch(route, /'admin'[^\n]*role/);
  });

  it('tops the wallet up to a target instead of adding without bound', async () => {
    const route = await readFile(routePath, 'utf8');
    assert.match(route, /if \(current < targetBalance\)/);
    assert.match(route, /const topUp = targetBalance - current;/);
    // the credit is still a ledger row, not money appearing from nowhere
    assert.match(route, /'admin_adjustment'/);
  });

  it('warns loudly at startup that the bypass is live', async () => {
    const route = await readFile(routePath, 'utf8');
    assert.match(route, /app\.log\.warn/);
    assert.match(route, /DEVELOPER LOGIN IS ENABLED/);
  });

  it('is wired into the app behind its own registrar', async () => {
    const app = await readFile(appPath, 'utf8');
    assert.match(app, /registerDevRoutes\(app, db, config\)/);
  });

  it('ships disabled in the example environment', async () => {
    const example = await readFile(
      path.resolve(import.meta.dirname, '../../../.env.example'),
      'utf8',
    );
    assert.match(example, /DEV_LOGIN_ENABLED=false/);
  });
});
