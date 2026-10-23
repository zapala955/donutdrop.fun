import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const front = (relative: string) =>
  readFile(
    path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop', relative),
    'utf8',
  );

describe('the notice at the foot of every page', () => {
  it('says the site is not connected to DonutSMP, Mojang or Microsoft', async () => {
    const html = await front('index.html');
    const footer = html.slice(html.indexOf('<footer class="sitefoot"'), html.indexOf('</footer>'));
    assert.ok(footer.length > 0, 'the footer is missing');
    const text = footer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // The 18+ line came off at the operator's request (2026-10-14).
    assert.doesNotMatch(text, /18\+|18 years old/);
    assert.match(
      text,
      /not affiliated with, endorsed by or connected to DonutSMP, Mojang or Microsoft/,
    );
    assert.match(text, /not an official Minecraft product/);
    assert.match(footer, /href="\/terms"/);
    // donutvanta.com redirects here; the name on the page is what lets a search for it find the site.
    assert.match(text, /DonutLuxe is also DonutVanta, at donutvanta\.com\./);
    assert.match(html, /"alternateName":\["DonutLuxe\.com","DonutVanta","DonutVanta\.com"\]/);
  });

  it('is the last thing in the main column, on every route, and loads its own stylesheet', async () => {
    const html = await front('index.html');
    // By its id: the shell gives <main> more than one class ("main lxmain").
    const main = html.slice(html.indexOf('id="main"'), html.indexOf('</main>'));
    assert.ok(html.indexOf('id="main"') > 0, 'the main column is missing');
    // After the live feed and every view: it belongs to the shell, not to one page.
    assert.ok(main.indexOf('id="tickerRoot"') < main.indexOf('<footer class="sitefoot"'));
    assert.doesNotMatch(
      main.slice(main.indexOf('</footer>')),
      /<section class="view"/,
      'no view comes after it',
    );
    assert.match(html, /href="assets\/css\/sitefoot\.css"/);
  });

  it('keeps clear of the phone tab bar and honours the house tokens', async () => {
    const css = await front('assets/css/sitefoot.css');
    assert.match(css, /var\(--tabbar-reach, 0px\)/);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'house tokens only, no stray colours');
  });
});
