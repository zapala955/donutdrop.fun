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
  it('says the site is for adults and is not connected to DonutSMP, Mojang or Microsoft', async () => {
    const html = await front('index.html');
    const footer = html.slice(html.indexOf('<footer class="sitefoot"'), html.indexOf('</footer>'));
    assert.ok(footer.length > 0, 'the footer is missing');
    const text = footer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /18\+/);
    assert.match(text, /You must be at least 18 years old to use this site/);
    assert.match(
      text,
      /not affiliated with, endorsed by or connected to DonutSMP, Mojang or Microsoft/,
    );
    assert.match(text, /not an official Minecraft product/);
    assert.match(footer, /href="\/terms"/);
  });

  it('is the last thing in the main column, on every route, and loads its own stylesheet', async () => {
    const html = await front('index.html');
    const main = html.slice(html.indexOf('<main class="main"'), html.indexOf('</main>'));
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
