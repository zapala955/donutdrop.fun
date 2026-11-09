import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { AppConfig } from '../src/config.js';
import { inviteOffer, registerInviteLinkRoutes } from '../src/routes/invite-links.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const config = {
  appOrigin: 'https://donutluxe.com',
  referralsEnabled: true,
  referralSignupBonusMinor: 10_000_000n,
  signupBonusMinor: 1_000_000n,
} as unknown as AppConfig;

async function app(settings = config) {
  const server = Fastify();
  await registerInviteLinkRoutes(server, settings);
  return server;
}

describe('invite links (/r/<code>)', () => {
  it('shows a link preview the invite signup bonus, from the live settings', async () => {
    const server = await app();
    const response = await server.inject({ url: '/r/abc123', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/html/);
    assert.match(response.body, /<meta property="og:title" content="Get a \$10M signup bonus on DonutLuxe" \/>/);
    assert.match(response.body, /Sign up with this invite and \$10M is added to your balance/);
    assert.match(response.body, /<meta property="og:url" content="https:\/\/donutluxe\.com\/r\/ABC123" \/>/);
    assert.match(response.body, /<meta property="og:image" content="https:\/\/donutluxe\.com\/assets\/img\/brand\/og-image\.png\?v=2" \/>/);
    await server.close();
  });

  it('sends a person on to the site with the code, and a malformed code to the home page', async () => {
    const server = await app();
    const person = await server.inject({ url: '/r/abc123', headers: { 'user-agent': 'Mozilla/5.0 Chrome/130' } });
    assert.equal(person.statusCode, 302);
    assert.equal(person.headers['location'], '/?ref=ABC123');
    const bad = await server.inject({ url: '/r/%3Cscript%3E', headers: { 'user-agent': 'Discordbot/2.0' } });
    assert.equal(bad.statusCode, 302);
    assert.equal(bad.headers['location'], '/');
    await server.close();
  });

  it('falls back to the ordinary bonus, then to no figure, as the settings are switched off', () => {
    assert.equal(inviteOffer({ ...config, referralSignupBonusMinor: 0n } as AppConfig).title, 'Get $1M free on DonutLuxe');
    assert.equal(inviteOffer({ ...config, referralSignupBonusMinor: 0n, signupBonusMinor: 0n } as AppConfig).title, "You're invited to DonutLuxe");
  });

  it('is the link the invite page hands out, and nginx sends previews of older ?ref= links to it', async () => {
    const [referrals, nginx] = await Promise.all([
      read('services/api-gateway/src/routes/referrals.ts'),
      read('infra/nginx/nginx.conf'),
    ]);
    assert.equal(referrals.match(/link: `\$\{config\.appOrigin\}\/r\/\$\{code\}`/g)?.length, 2);
    assert.doesNotMatch(referrals, /\/\?ref=\$\{code\}/);
    assert.match(nginx, /location \^~ \/r\/ \{\s*limit_req zone=public_api burst=30 nodelay;\s*proxy_pass http:\/\/api_backend;/);
    assert.match(nginx, /map "\$link_previewer:\$arg_ref" \$invite_preview \{/);
    assert.match(nginx, /if \(\$invite_preview\) \{ rewrite \^ \/r\/\$invite_preview\? last; \}/);
    // Search engines keep reading the home page.
    const previewers = nginx.slice(nginx.indexOf('map $http_user_agent $link_previewer'), nginx.indexOf('map "$link_previewer'));
    assert.doesNotMatch(previewers, /googlebot|bingbot/);
  });
});
