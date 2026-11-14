import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FLEET_PREFIX, isAllowedFleetPath } from '../src/routes/admin-fleet.js';

const source = readFileSync(new URL('../src/routes/admin-fleet.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const root = new URL('../../../', import.meta.url);
const nginx = readFileSync(new URL('infra/nginx/nginx.conf', root), 'utf8');
const compose = readFileSync(new URL('infra/docker/compose.yml', root), 'utf8');
const headers = readFileSync(new URL('infra/nginx/security-headers.conf', root), 'utf8');
const adminHeaders = readFileSync(new URL('infra/nginx/security-headers-admin.conf', root), 'utf8');
const adminDir = new URL('DONUTDROP FRONTEND/Donut Drop/admin/', root);
const adminHtml = readFileSync(new URL('index.html', adminDir), 'utf8');
const adminJs = readFileSync(new URL('admin.js', adminDir), 'utf8');

/* What the code says, not what its comments say. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('admin fleet proxy', () => {
  it('lives under the admin prefix', () => {
    assert.equal(FLEET_PREFIX, '/v1/admin/fleet');
  });

  it('forwards only the pages and reads the fleet serves', () => {
    for (const path of ['/', '/api/live', '/api/relays', '/api/accounts/0a1b2c3d4e5f/log']) {
      assert.ok(isAllowedFleetPath('GET', path), `GET ${path}`);
    }
    for (const path of ['/server.mjs', '/api/accounts', '/api/settings', '/switch-ip', '/api/live/x', '/..%2f', '//evil']) {
      assert.ok(!isAllowedFleetPath('GET', path), `GET ${path}`);
    }
  });

  it('forwards writes only below /api, short words, never traversal', () => {
    for (const path of ['/api/fleet/start', '/api/accounts/ab12/start', '/api/vpn/fix', '/api/settings']) {
      assert.ok(isAllowedFleetPath('POST', path), `POST ${path}`);
    }
    for (const path of ['/', '/api/', '/api/../x', '/api//x', '/switch-ip', `/api/${'a/'.repeat(10)}a`]) {
      assert.ok(!isAllowedFleetPath('POST', path), `POST ${path}`);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
      assert.ok(!isAllowedFleetPath(method, '/api/fleet/start'), method);
    }
  });

  it('is behind the admin guard, with CSRF on every write', () => {
    assert.ok(source.includes('await guards.requireAdmin(request);'));
    assert.ok(source.includes("request.authUser?.role !== 'admin'"));
    assert.ok(source.includes("if (request.method === 'GET') await requireAdminRead(request);"));
  });

  it('registers nothing without FLEET_URL, and never passes cookies back', () => {
    assert.ok(source.includes('if (!config.fleetUrl) return;'));
    assert.ok(!/set-cookie/i.test(code(source)), 'no set-cookie passthrough');
    assert.ok(config.includes("FLEET_URL: z"));
    assert.ok(config.includes("z.string().url().startsWith('http://')"));
    assert.ok(config.includes('fleetUrl: env.FLEET_URL,'));
    assert.ok(app.includes('await registerAdminFleetRoutes(app, db, config);'));
  });

  it('does not touch money: no ledger, teller or payout code in the proxy', () => {
    for (const word of ['wallet', 'ledger', 'payout', 'teller', 'vault', 'transfer']) {
      assert.ok(!code(source).toLowerCase().includes(word), word);
    }
  });

  it('nginx: the fleet location comes before /v1/, buffers nothing and brings no policy of its own', () => {
    const start = nginx.indexOf('location ^~ /v1/admin/fleet/ {');
    assert.ok(start > 0 && start < nginx.indexOf('location ^~ /v1/ {'), 'before the general /v1/ block');
    const block = nginx.slice(start, nginx.indexOf('\n    }', start));
    assert.ok(block.includes('proxy_pass http://api_backend;'));
    assert.ok(block.includes('proxy_buffering off;'));
    assert.ok(!block.includes('security-headers'), 'the page sends its own policy');
    /* The API (helmet) already sends these. A second X-Frame-Options is an invalid value and the browser
     * refuses to show the frame at all, which is exactly what happened on the first deploy. */
    const directives = block.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    for (const header of ['X-Frame-Options', 'Referrer-Policy', 'X-Content-Type-Options', 'Strict-Transport-Security']) {
      assert.ok(!directives.includes(header), `${header} comes from the API only`);
    }
    assert.ok(source.includes("reply.header('x-frame-options', 'SAMEORIGIN');"));
  });

  it('nginx: only the admin page may frame its own origin, and nothing else differs', () => {
    const at = nginx.indexOf('include /etc/nginx/security-headers-admin.conf;');
    assert.ok(at > 0, 'the admin page uses its own header file');
    assert.equal(nginx.split('include /etc/nginx/security-headers-admin.conf;').length, 2, 'and nothing else does');
    assert.ok(nginx.slice(at, at + 120).includes('try_files /admin/index.html =404;'));
    assert.ok(!headers.includes("frame-src 'self'"), 'the global policy stays strict');
    assert.equal(
      adminHeaders,
      headers.replace('frame-src https://challenges.cloudflare.com;', "frame-src 'self' https://challenges.cloudflare.com;"),
      'the admin copy differs from the global file only by frame-src',
    );
    assert.ok(compose.includes('../nginx/security-headers-admin.conf:/etc/nginx/security-headers-admin.conf:ro'));
  });

  it('compose: only the API reaches the host, and an empty FLEET_URL means no fleet', () => {
    assert.ok(compose.includes("FLEET_URL: '${FLEET_URL:-}'"));
    assert.equal(compose.split('host.docker.internal:host-gateway').length, 2, 'exactly one service');
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  maintenance:'));
    assert.ok(api.includes('host.docker.internal:host-gateway'));
  });

  it('admin console: a Fleet tab with a lazy frame and its own reload button', () => {
    assert.ok(adminHtml.includes('data-panel="fleet" aria-selected="false">Fleet</button>'));
    assert.ok(adminHtml.includes('<iframe class="fleet-frame" id="fleetFrame"'));
    assert.ok(adminHtml.includes('referrerpolicy="same-origin"'));
    assert.ok(!/<iframe[^>]* src=/.test(adminHtml), 'nothing is fetched until the tab is opened');
    assert.ok(adminJs.includes('fleet: loadFleet,'));
    assert.ok(adminJs.includes("'/v1/admin/fleet/'"));
    assert.ok(adminJs.includes("$('fleetReload').addEventListener"));
  });
});
