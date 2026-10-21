import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The loader in the content area, from the first paint until the router shows a page. Before it, a
 * slow load was an empty frame with the footer notice floating at the top, on a white page until
 * the stylesheets arrived. It is pure CSS, keyed on every page being a hidden direct child of
 * <main>; these hold the markup to that. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const source = async (relative: string) =>
  (await readFile(path.join(frontend, relative), 'utf8')).replace(/\r\n/g, '\n');

/** The tags directly inside <main>, in order, as [tag, attributes]. */
function mainChildren(html: string): Array<[string, string]> {
  const start = html.indexOf('<main ');
  const end = html.indexOf('</main>');
  assert.ok(start > 0 && end > start, 'index.html has one <main>');
  const inner = html.slice(html.indexOf('>', start) + 1, end).replace(/<!--[\s\S]*?-->/g, '');
  const children: Array<[string, string]> = [];
  let depth = 0;
  for (const match of inner.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attributes, selfClosing] = match;
    if (['img', 'br', 'input', 'meta', 'link', 'source', 'hr', 'wbr'].includes(tag!) || selfClosing) {
      if (depth === 0 && !closing) children.push([tag!, attributes!]);
      continue;
    }
    if (closing) depth -= 1;
    else {
      if (depth === 0) children.push([tag!, attributes!]);
      depth += 1;
    }
  }
  return children;
}

describe('the boot loader', () => {
  it('is the first thing in <main>, and every page sits directly beside it, hidden', async () => {
    const html = await source('index.html');
    const children = mainChildren(html);
    assert.equal(children[0]?.[0], 'div');
    assert.match(children[0]![1], /class="lxboot" role="status"/);
    const views = children.filter(([tag, attributes]) => tag === 'section' && /class="view"/.test(attributes));
    // Every view in the file is one of these: a view wrapped in anything else would never count as
    // shown, and the loader would sit above that page for good.
    assert.equal(views.length, (html.match(/<section class="view"/g) ?? []).length);
    assert.ok(views.length > 30, 'could not read the views');
    for (const [, attributes] of views) assert.match(attributes, / hidden$/, attributes);
  });

  it('shows only while no page is, without a script', async () => {
    const css = await source('assets/css/boot.css');
    assert.match(css, /^\.lxboot \{ display: none; \}$/m);
    assert.match(css, /body\.lx \.lxmain:not\(:has\(> \.view:not\(\[hidden\]\)\)\) > \.lxboot \{\n\s*display: grid;/);
    const html = await source('index.html');
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/boot\.css" \/>/);
    assert.doesNotMatch(await source('assets/js/app.js'), /lxboot/, 'nothing in the app has to remember to remove it');
  });

  it('holds back on a fast load, explains a stuck one, and keeps still for reduced motion', async () => {
    const css = await source('assets/css/boot.css');
    assert.match(css, /animation: lxboot-in \.15s linear \.3s both;/);
    assert.match(css, /animation: lxboot-slow 0s linear 12s forwards;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.lxboot__bar \{ display: none; \}/);
    assert.match(css, /:root\[data-motion='reduce'\] \.lxboot__bar \{ display: none; \}/);
    // Colours from the luxe tokens only, so a player's theme carries through.
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i);
    const html = await source('index.html');
    assert.match(html, /<p class="lxboot__slow">This is taking longer than usual\. <a href="">Reload<\/a><\/p>/);
  });

  it('asks the browser for a dark canvas before the stylesheets arrive', async () => {
    const html = await source('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<meta name="color-scheme" content="dark" \/>/);
    assert.ok(head.indexOf('name="color-scheme"') < head.indexOf('rel="stylesheet"'));
  });
});
