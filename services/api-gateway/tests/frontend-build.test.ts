import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

/* The frontend build (scripts/build-frontend.mjs): the page, one stylesheet and a few scripts under
 * a content-addressed /b/<id>/ that nginx serves as immutable. Run here for real, into a temporary
 * directory, so what these tests read is what the server will serve. */

const repo = path.resolve(import.meta.dirname, '../../..');
const site = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop');
type Built = { id: string; base: string; release: string; preloads: string[]; minified: boolean };
type Build = {
  buildFrontend(options: { out: string; useEsbuild?: boolean; log?: (line: string) => void }): Promise<Built>;
  absoluteUrls(css: string, dir?: string): string;
  stripHtmlComments(html: string): string;
};
let build: Build;
let out = '';
let built: Built;
let page = '';

before(async () => {
  build = (await import(pathToFileURL(path.join(repo, 'scripts/build-frontend.mjs')).href)) as Build;
  out = mkdtempSync(path.join(tmpdir(), 'frontend-build-'));
  built = await build.buildFrontend({ out, log: () => undefined });
  page = readFileSync(path.join(out, 'index.html'), 'utf8');
});
after(() => rmSync(out, { recursive: true, force: true }));

describe('frontend build', () => {
  it('serves every stylesheet and script from the release, and nothing from the unbuilt sources', () => {
    assert.equal(built.minified, true, 'esbuild is in node_modules here; the server installs the same version');
    assert.match(built.id, /^[0-9a-f]{12}$/);
    assert.deepEqual([...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), [`${built.base}site.css`]);
    assert.doesNotMatch(page, /assets\/css\/|assets\/js\//);
    const scripts = [...page.matchAll(/<script(?: type="module")? src="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(scripts.map((src) => src.replace(/-[A-Z0-9]{8}\.js$/, '.js')), [
      `${built.base}prefs-boot.js`,
      `${built.base}file-guard.js`,
      `${built.base}app.js`,
      `${built.base}luxe.js`,
    ]);
    const preloads = [...page.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(preloads.length > 0, 'the shared chunks are named up front');
    for (const url of [...scripts, ...preloads, `${built.base}site.css`]) {
      assert.ok(existsSync(path.join(out, url)), `${url} is in the release`);
    }
  });

  it('keeps every string nginx rewrites for a route exactly as the source wrote it', async () => {
    const conf = await readFile(path.join(repo, 'infra/nginx/nginx.conf'), 'utf8');
    const searches = [...conf.matchAll(/^\s*sub_filter '([^']+)' '[^']*';$/gm)].map((m) => m[1]!);
    assert.ok(searches.length >= 5);
    const source = readFileSync(path.join(site, 'index.html'), 'utf8');
    for (const search of searches) {
      assert.equal(page.split(search).length, source.split(search).length, `"${search}" must match the built page as it matched the source`);
    }
  });

  it('drops the comments from the page but not from a script', () => {
    assert.doesNotMatch(page, /<!--/);
    assert.match(page, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org"/);
    assert.equal(build.stripHtmlComments('<p>a<!-- x -->b</p><script>/* <!-- kept --> */</script>'), '<p>ab</p><script>/* <!-- kept --> */</script>');
  });

  it('concatenates the stylesheets in the order the page links them, with their urls made absolute', () => {
    const css = readFileSync(path.join(built.release, 'site.css'), 'utf8');
    const at = (needle: string) => css.indexOf(needle);
    assert.ok(at('figtree-400-800-latin.woff2') >= 0 && at('figtree-400-800-latin.woff2') < at('.lxswitch'), 'fonts.css first, prefs.css last');
    // Custom property values are kept as written, leading space and all.
    assert.ok(at('--lx-0: #0a0a0c') > 0 && at('--lx-0: #0a0a0c') < at('data-lxtheme'), 'luxe.css before prefs.css');
    assert.match(css, /url\(\/assets\/img\/luxe\/tnt\.svg\)/);
    assert.doesNotMatch(css, /url\(["']?\.\.\//);
    assert.equal(build.absoluteUrls('a{b:url("../img/x.png") url(#grad) url(data:image/png;base64,AA) url(/y.svg)}'),
      'a{b:url("/assets/img/x.png") url(#grad) url(data:image/png;base64,AA) url(/y.svg)}');
  });

  it('names a release after what is in it: the same sources build the same id, once', async () => {
    const again = await build.buildFrontend({ out, log: () => undefined });
    assert.equal(again.id, built.id);
    assert.deepEqual(readdirSync(path.join(out, 'b')).filter((name) => !name.startsWith('.')), [built.id]);
  });

  it('still builds without esbuild: unminified, the same scheme, a different release', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'frontend-build-plain-'));
    try {
      const result = await build.buildFrontend({ out: plain, useEsbuild: false, log: () => undefined });
      assert.equal(result.minified, false);
      assert.notEqual(result.id, built.id);
      const html = readFileSync(path.join(plain, 'index.html'), 'utf8');
      assert.match(html, new RegExp(`<script type="module" src="${result.base}js/app\\.js"></script>`));
      assert.ok(existsSync(path.join(result.release, 'js/store.js')), 'the modules travel with their relative imports');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('bundles nothing that finds a file relative to its own module', async () => {
    // A bundled module's import.meta.url is its chunk under /b/<id>/, where a relative path leads nowhere.
    for (const name of readdirSync(path.join(site, 'assets/js')).filter((file) => file.endsWith('.js'))) {
      const code = readFileSync(path.join(site, 'assets/js', name), 'utf8');
      assert.doesNotMatch(code, /import\.meta\.url/, name);
    }
  });
});

describe('frontend build: serving and deploying it', () => {
  it('serves releases as immutable and prefers the built page', async () => {
    const conf = await readFile(path.join(repo, 'infra/nginx/nginx.conf'), 'utf8');
    assert.match(conf, /location \^~ \/b\/ \{\s*root \/srv\/www\/build;\s*add_header Cache-Control "public, max-age=31536000, immutable" always;/);
    assert.equal(conf.split('try_files /build/index.html /index.html =404;').length - 1, 2, 'the root and every route');
    assert.doesNotMatch(conf, /try_files \/index\.html =404;/);
  });

  it('builds on every deploy and after a rollback, and never commits a build', async () => {
    const [deploy, update, ignore, script] = await Promise.all([
      readFile(path.join(repo, 'infra/vps/deploy.sh'), 'utf8'),
      readFile(path.join(repo, 'infra/vps/update-and-deploy.sh'), 'utf8'),
      readFile(path.join(repo, '.gitignore'), 'utf8'),
      readFile(path.join(repo, 'infra/vps/build-frontend.sh'), 'utf8'),
    ]);
    assert.ok(deploy.indexOf('infra/vps/build-frontend.sh') > 0);
    assert.ok(deploy.indexOf('infra/vps/build-frontend.sh') < deploy.indexOf('up -d --force-recreate nginx'), 'built before nginx is recreated');
    assert.ok(update.indexOf('build-frontend.sh') > update.indexOf('git reset --hard "$previous_commit"'));
    assert.match(ignore, /^DONUTDROP FRONTEND\/Donut Drop\/build\/$/m);
    // The server builds with the Node image the API is built from, and the esbuild the tests use.
    const local = JSON.parse(await readFile(path.join(repo, 'node_modules/esbuild/package.json'), 'utf8')) as { version: string };
    assert.match(script, new RegExp(`esbuild_version="${local.version.replaceAll('.', '\\.')}"`));
    assert.match(script, /sed -n 's\/\^FROM \\\(node:\[\^ \]\*\\\) AS build\$\/\\1\/p' "\$repo_root\/infra\/docker\/api\.Dockerfile"/);
  });

  it('loads its fonts from the site, not from Google', async () => {
    const html = await readFile(path.join(site, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<link[^>]+fonts\.(?:googleapis|gstatic)\.com/);
    const preload = /<link rel="preload" href="(assets\/fonts\/[^"]+\.woff2)" as="font" type="font\/woff2" crossorigin \/>/.exec(html);
    assert.ok(preload && existsSync(path.join(site, preload[1]!)));
    const fonts = await readFile(path.join(site, 'assets/css/fonts.css'), 'utf8');
    const files = [...fonts.matchAll(/url\(\.\.\/fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]!);
    assert.equal(files.length, 4);
    for (const file of files) assert.ok(existsSync(path.join(site, 'assets/fonts', file)), file);
    for (const family of ['Figtree', 'Archivo']) assert.match(fonts, new RegExp(`font-family: '${family}'`));
  });
});
