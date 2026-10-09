import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '../../..');
const frontend = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const readFrontend = (relative: string) => readFile(path.join(frontend, relative), 'utf8');

type Seo = {
  SITE_ORIGIN: string;
  ROUTE_META: Record<string, { title: string; description: string }>;
  PRIVATE_ROUTES: Set<string>;
  canonicalUrl(route: string): string;
  applyRouteMeta(route: string): void;
};
const seo = async () =>
  (await import(pathToFileURL(path.join(frontend, 'assets/js/seo.js')).href)) as Seo;

function sitemapPaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>https:\/\/donutwin\.fun(\/[^<]*)<\/loc>/g)].map((m) => m[1]!);
}

/**
 * Every route was one shell with one title, there was no robots.txt and no sitemap (nginx 404'd
 * both), and the description still advertised two games the site no longer has. These hold the
 * pieces together so the next route added cannot quietly fall out of one of them.
 */
describe('what search engines are given', () => {
  it('lists exactly the public routes in the sitemap', async () => {
    const { ROUTE_META, PRIVATE_ROUTES, canonicalUrl } = await seo();
    const listed = sitemapPaths(await readFrontend('sitemap.xml'));
    const expected = Object.keys(ROUTE_META)
      .filter((route) => !PRIVATE_ROUTES.has(route))
      .map((route) => new URL(canonicalUrl(route)).pathname);
    assert.deepEqual(listed, expected);
    for (const route of PRIVATE_ROUTES) {
      assert.ok(!listed.includes(`/${route}`), `${route} is private and must not be in the sitemap`);
    }
  });

  it('only lists pages nginx actually serves', async () => {
    const nginx = await read('infra/nginx/nginx.conf');
    const allowlist = /location ~ \^\/\(\?:([a-z|-]+)\)\$ \{/.exec(nginx)?.[1]?.split('|') ?? [];
    assert.ok(allowlist.length > 10, 'could not read the route allowlist');
    for (const pathname of sitemapPaths(await readFrontend('sitemap.xml'))) {
      if (pathname === '/') continue;
      assert.ok(allowlist.includes(pathname.slice(1)), `${pathname} would 404`);
    }
    assert.match(nginx, /location = \/robots\.txt \{[\s\S]*?try_files \/robots\.txt =404;/);
    assert.match(nginx, /location = \/sitemap\.xml \{[\s\S]*?try_files \/sitemap\.xml =404;/);
  });

  it('points crawlers at the sitemap and away from the console and the API', async () => {
    const robots = await readFrontend('robots.txt');
    assert.match(robots, /^Sitemap: https:\/\/donutwin\.fun\/sitemap\.xml$/m);
    assert.match(robots, /^Disallow: \/admin\/$/m);
    assert.match(robots, /^Disallow: \/v1\/$/m);
  });

  it('keeps titles and descriptions short enough not to be cut off', async () => {
    const { ROUTE_META } = await seo();
    for (const [route, meta] of Object.entries(ROUTE_META)) {
      assert.ok(meta.title.length <= 60, `${route} title is ${meta.title.length} characters`);
      assert.ok(meta.description.length <= 160, `${route} description is ${meta.description.length}`);
    }
  });

  /* Another DonutSMP site uses the same name on a .com and outranked this one for it. Every page
   * leads with the name, so the account pages read "DonutWin Wallet" in the tab too. */
  it('titles every route the router knows, each one leading with DonutWin', async () => {
    const { ROUTE_META } = await seo();
    const app = await readFrontend('assets/js/app.js');
    const table = app.slice(app.indexOf('const VIEWS = {'), app.indexOf('};', app.indexOf('const VIEWS = {')));
    const routes = [...table.matchAll(/^\s+'?([a-z-]+)'?: mount/gm)].map((match) => match[1]!);
    assert.ok(routes.length > 20, 'could not read the route table');
    for (const route of routes) {
      const meta = ROUTE_META[route];
      assert.ok(meta, `${route} has no title`);
      assert.match(meta.title, /^DonutWin[ .]/, `${route}: ${meta.title}`);
    }
  });

  /* A link to /discord previewed in Discord as the home page: previews read the HTML as served and
   * never run seo.js. nginx rewrites the home values to the route's own from generated maps. */
  it('serves each route its own title in the HTML itself, for link previews', async () => {
    const seoModule = await seo();
    const generator = (await import(
      pathToFileURL(path.join(repo, 'infra/nginx/seo-map.mjs')).href
    )) as {
      expectedConf(conf: string, seo: unknown): string;
      homeStrings(seo: unknown): Record<string, string>;
      htmlText(text: string): string;
    };
    const conf = (await read('infra/nginx/nginx.conf')).replace(/\r\n/g, '\n');
    assert.equal(
      conf,
      generator.expectedConf(conf, seoModule),
      'nginx.conf is out of date with seo.js: run node infra/nginx/seo-map.mjs',
    );

    // Every string nginx looks for is really in the page, as many times as it has to be replaced.
    const html = await readFrontend('index.html');
    const home = generator.homeStrings(seoModule);
    const count = (needle: string) => html.split(needle).length - 1;
    assert.equal(count(home['title']!), 3, 'the home title: <title>, og:title, twitter:title');
    assert.equal(count(home['description']!), 3, 'the home description: meta, og, twitter');
    for (const key of ['canonical', 'ogUrl', 'robots']) {
      assert.equal(count(home[key]!), 1, `${key} must appear exactly once`);
    }

    // What a preview of /discord now reads, doing what nginx does.
    const discord = seoModule.ROUTE_META['discord']!;
    const served = html
      .split(home['title']!).join(generator.htmlText(discord.title))
      .split(home['description']!).join(generator.htmlText(discord.description))
      .split(home['canonical']!).join('<link rel="canonical" href="https://donutwin.fun/discord" />');
    assert.match(served, /<title>DonutWin Discord — Join &amp; Link Your Account<\/title>/);
    assert.match(served, /<meta property="og:title" content="DonutWin Discord — /);
    assert.match(served, /<meta name="twitter:description" content="Join the DonutWin Discord/);
    assert.match(served, /<link rel="canonical" href="https:\/\/donutwin\.fun\/discord" \/>/);
    assert.match(conf, /map \$uri \$seo_robots \{[\s\S]*?\/wallet "noindex, follow";/);
  });

  it('says what the site is, by name, on the home page', async () => {
    const html = await readFrontend('index.html');
    const home = html.slice(html.indexOf('data-view="home"'), html.indexOf('class="promos"'));
    assert.match(home, /<p>DonutWin is a DonutSMP minigame site:/);
  });

  it('gives each route its own title, canonical URL and robots rule', async () => {
    const { applyRouteMeta, ROUTE_META } = await seo();
    const nodes = new Map<string, Record<string, string>>();
    for (const selector of [
      'meta[name="description"]',
      'meta[name="robots"]',
      'link[rel="canonical"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:url"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
    ]) {
      nodes.set(selector, {});
    }
    const fakeDocument = {
      title: '',
      head: {
        querySelector: (selector: string) => {
          const attributes = nodes.get(selector);
          return attributes
            ? { setAttribute: (name: string, value: string) => (attributes[name] = value) }
            : null;
        },
      },
    };
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = fakeDocument;
    try {
      applyRouteMeta('crash');
      assert.equal(fakeDocument.title, ROUTE_META['crash']!.title);
      assert.equal(nodes.get('link[rel="canonical"]')!['href'], 'https://donutwin.fun/crash');
      assert.equal(nodes.get('meta[name="robots"]')!['content'], 'index, follow');

      applyRouteMeta('home');
      assert.equal(nodes.get('link[rel="canonical"]')!['href'], 'https://donutwin.fun/');

      applyRouteMeta('wallet');
      assert.equal(nodes.get('meta[name="robots"]')!['content'], 'noindex, follow');
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
    const app = await readFrontend('assets/js/app.js');
    const route = app.slice(app.indexOf('function route() {'), app.indexOf('/* ═════════ boot'));
    assert.match(route, /applyRouteMeta\(name\);/);
  });

  it('ships the home page head with a canonical, previews and structured data', async () => {
    const html = await readFrontend('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<link rel="canonical" href="https:\/\/donutwin\.fun\/" \/>/);
    assert.match(head, /<meta property="og:image" content="https:\/\/donutwin\.fun\/assets\/img\//);
    for (const tag of ['og:title', 'og:description', 'og:url']) {
      assert.match(head, new RegExp(`<meta property="${tag}" content="[^"]+" />`));
    }
    const description = /<meta name="description" content="([^"]+)"/.exec(head)?.[1] ?? '';
    assert.ok(description.length > 50 && description.length <= 160);
    assert.doesNotMatch(description, /snake arena|faction war/i);
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head)?.[1];
    assert.ok(jsonLd, 'structured data is missing');
    const data = JSON.parse(jsonLd) as { '@graph': { '@type': string; url: string }[] };
    assert.deepEqual(
      data['@graph'].map((node) => node['@type']),
      ['WebSite', 'Organization'],
    );
  });
});
