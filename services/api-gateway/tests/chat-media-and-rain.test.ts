import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const frontend = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('media nametags in chat', () => {
  it('tags only approved creators, with the code that currently works', async () => {
    const route = await read('services/api-gateway/src/routes/chat.ts');
    const select = route.slice(
      route.indexOf('const MESSAGE_SELECT'),
      route.indexOf('interface ChatClearRow'),
    );
    assert.match(select, /LEFT JOIN LATERAL/);
    assert.match(select, /ca\.status = 'approved'/);
    // The live code from referral_codes, not the string the creator originally asked for.
    assert.match(select, /JOIN referral_codes rc ON rc\.user_id = ca\.user_id/);
    assert.doesNotMatch(select, /requested_code/);
    // Nothing private from the application leaves the server.
    assert.doesNotMatch(select, /channel_url|audience_size|granted_revshare_bps/);
  });

  it('switches the tags off with the programme, and decorates the read and the write alike', async () => {
    const route = await read('services/api-gateway/src/routes/chat.ts');
    const tag = route.slice(
      route.indexOf('function mediaTag('),
      route.indexOf('function present('),
    );
    assert.match(
      tag,
      /if \(!config\.creatorProgrammeEnabled \|\| !row\.creator_code\) return \{\};/,
    );
    assert.match(
      route,
      /messages: result\.rows\.reverse\(\)\.map\(\(row\) => present\(config, row\)\)/,
    );
    assert.match(route, /reply\.code\(201\)\.send\(\{ message: present\(config, sent\) \}\)/);
    assert.match(route, /\$\{MESSAGE_SELECT\} WHERE m\.id = \$1/);
  });

  it('renders the tag as text and makes it copy the code', async () => {
    const chat = await frontend('assets/js/chat.js');
    const builder = chat.slice(
      chat.indexOf('function mediaTag('),
      chat.indexOf('function buildRainLine('),
    );
    assert.match(builder, /label\.textContent = code/);
    assert.match(builder, /navigator\.clipboard\.writeText\(code\)/);
    assert.doesNotMatch(builder, /innerHTML/);
    assert.match(chat, /if \(message\.media\?\.code\) \{/);
  });
});

describe('lava rain', () => {
  it('actually hides the card between drops', async () => {
    const [html, social] = await Promise.all([
      frontend('index.html'),
      frontend('assets/css/social.css'),
    ]);
    // app.css gives the card display:flex, which beats the browser's [hidden] rule on its own.
    assert.match(social, /\.chat__rain\[hidden\] \{ display: none; \}/);
    assert.match(html, /<div class="chat__rain" hidden><\/div>/);
    assert.doesNotMatch(html, /id="(?:rainPot|rainTimer|rainJoin)"/);
  });

  it('keeps the card alive while switched off and refetches on live events', async () => {
    const [chat, live] = await Promise.all([
      frontend('assets/js/chat.js'),
      frontend('assets/js/live.js'),
    ]);
    assert.doesNotMatch(chat, /card\.remove\(\)/);
    assert.match(chat, /off \? RAIN_OFF_POLL_MS : RAIN_POLL_MS \* 2/);
    assert.match(chat, /window\.addEventListener\('donut:rain', scheduleRain\)/);
    assert.match(
      live,
      /source\.addEventListener\('rain', \(\) => window\.dispatchEvent\(new CustomEvent\('donut:rain'\)\)\)/,
    );
  });

  it('does not spin when the browser clock reaches the deadline before the server does', async () => {
    const chat = await frontend('assets/js/chat.js');
    const clock = chat.slice(
      chat.indexOf('const paintClock = () =>'),
      chat.indexOf('paintClock();'),
    );
    assert.match(clock, /scheduleRain\(\)/);
    assert.doesNotMatch(clock, /pollRain\(/);
  });

  it('publishes rain events after each commit, and only when a settlement closed something', async () => {
    const [social, hub] = await Promise.all([
      read('services/api-gateway/src/routes/social.ts'),
      read('services/api-gateway/src/lib/live-events.ts'),
    ]);
    assert.match(hub, /\| 'rain'/);
    assert.match(social, /if \(closedAny\) liveEvents\.publish\('rain'\);/);
    const claim = social.slice(
      social.indexOf("'/v1/social/rain/claim'"),
      social.indexOf('Starts a drop by hand'),
    );
    assert.ok(
      claim.indexOf("liveEvents.publish('rain')") >
        claim.indexOf('const result = await db.transaction'),
      'the claim broadcast must follow the commit',
    );
  });

  it('tells the claimant their share once it has landed', async () => {
    const [social, chat] = await Promise.all([
      read('services/api-gateway/src/routes/social.ts'),
      frontend('assets/js/chat.js'),
    ]);
    assert.match(social, /yourPayout: paid/);
    assert.match(social, /c\.user_id = \$1 AND e\.status = 'settled' AND c\.paid_minor > 0/);
    assert.match(chat, /function noticePayout\(board\)/);
    assert.match(chat, /RAIN_PAID_KEY/);
  });
});

describe('chat housekeeping', () => {
  it('takes a moderated message down on every screen, not just the moderator’s', async () => {
    const [chat, store] = await Promise.all([
      frontend('assets/js/chat.js'),
      frontend('assets/js/store.js'),
    ]);
    assert.match(
      store,
      /const requestedAt = Date\.now\(\);\s*\n\s*const result = await api\.get\(`\/v1\/chat\?limit=\$\{CHAT_WINDOW\}`\)/,
    );
    const prune = chat.slice(
      chat.indexOf('function pruneRemoved('),
      chat.indexOf('function drainBigHits('),
    );
    assert.match(prune, /Number\(node\.dataset\.seen \|\| 0\) >= requestedAt\) continue;/);
    assert.match(prune, /Number\(node\.dataset\.at \|\| 0\) <= floor\) continue;/);
  });

  it('scopes the desktop collapse so phones never fall back to the browser stylesheet', async () => {
    const social = await frontend('assets/css/social.css');
    assert.doesNotMatch(social, /display:\s*revert;/);
    assert.match(
      social,
      /@media \(min-width: 1081px\) \{\s*\n\s*body\[data-chat-collapsed="1"\] \.shell/,
    );
  });

  it('counts slow mode down without disabling the form that /tip also uses', async () => {
    const chat = await frontend('assets/js/chat.js');
    const paint = chat.slice(
      chat.indexOf('function paintSendButton()'),
      chat.indexOf('async function onSubmit('),
    );
    assert.match(paint, /setAttribute\('aria-disabled', 'true'\)/);
    const submit = chat.slice(
      chat.indexOf('async function onSubmit('),
      chat.indexOf('/* ═════════════════════════ tipping'),
    );
    assert.ok(
      submit.indexOf('Date.now() < cooldownUntil') > submit.indexOf('await sendTip('),
      'a tip must not wait out the chat slow mode',
    );
  });

  it('draws staff with one badge, not two', async () => {
    const platform = await frontend('assets/css/platform.css');
    assert.doesNotMatch(platform, /content: "STAFF"/);
  });
});

describe('creator code length', () => {
  it('asks for the same 6 to 16 characters a referral code is held to', async () => {
    const [rewards, admin, form] = await Promise.all([
      read('services/api-gateway/src/routes/rewards.ts'),
      read('services/api-gateway/src/routes/admin-operations.ts'),
      frontend('assets/js/creators.js'),
    ]);
    // An approved creator code is inserted into referral_codes, whose CHECK is 6 to 16.
    assert.doesNotMatch(rewards, /\[A-Z0-9\]\{3,16\}/);
    assert.doesNotMatch(admin, /\[A-Z0-9\]\{3,16\}/);
    assert.doesNotMatch(form, /\[A-Z0-9\]\{3,16\}/);
    assert.match(rewards, /requestedCode: z[\s\S]{0,80}\.regex\(\/\^\[A-Z0-9\]\{6,16\}\$\//);
  });

  it('refuses an old short application with a 400 instead of failing in Postgres', async () => {
    const admin = await read('services/api-gateway/src/routes/admin-operations.ts');
    const decision = admin.slice(
      admin.indexOf('const code = body.code ?? application.requested_code;'),
    );
    const guard = decision.indexOf("'CREATOR_CODE_INVALID'");
    assert.ok(guard > 0, 'approval must check the final code');
    assert.ok(guard < decision.indexOf('INSERT INTO referral_codes'), 'and before the insert');
  });
});
