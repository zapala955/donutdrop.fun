#!/usr/bin/env node
/* Builds the frontend the site serves: one stylesheet, a few script files, and an index.html that
 * points at them, all under a content-addressed /b/<id>/ that browsers may keep for a year.
 *
 * WHY
 * The page used to load 37 stylesheets and 61 modules straight from the source checkout, under
 * names that never change. nginx asked browsers to revalidate them on every load, and Cloudflare
 * overrides that with its own four-hour browser cache, so after a deploy a returning visitor got
 * the new index.html with up to four-hour-old scripts and styles: a mix of two releases, which
 * fails in silence the day a module stops exporting a name the other half still imports. The admin
 * console already lost an afternoon to the same override (nginx.conf, the admin bundle).
 *
 * Here every file the page loads lives under /b/<id>/, where <id> is a hash of what was built. A
 * change makes a new id, so nothing is ever served stale; no change keeps the id, so a deploy that
 * did not touch the frontend leaves every browser's copy valid. nginx serves /b/ as immutable.
 *
 * WHAT IT DOES
 *   - the stylesheets index.html links, concatenated in the order it links them (the cascade is
 *     unchanged) with their relative url()s made absolute, then minified;
 *   - the module scripts, bundled from each entry with the shared code split into chunks, then
 *     minified, with linked source maps; import() stays on demand as its own chunk;
 *   - the classic scripts (prefs-boot.js in <head>, file-guard.js), minified;
 *   - index.html with those swapped in, the modulepreload list rebuilt for the new chunks, and its
 *     comments taken out. Everything nginx's SEO sub_filter matches is left exactly as written.
 *
 * Without esbuild (ESBUILD_DIR, or the repo's node_modules) it still builds: the stylesheet is
 * concatenated but not minified and the modules are copied as they are. Same /b/<id>/ scheme, so
 * the caching and the no-mixing guarantee hold either way; only the bytes differ.
 *
 * The output is written beside the site in build/ (git-ignored): a release is written to a
 * temporary directory and renamed into place, and index.html is replaced last, so the site switches
 * in one step or not at all. The last eight releases are kept for pages that were opened before a
 * deploy and still load a chunk on demand.
 *
 *   node scripts/build-frontend.mjs                 build into "DONUTDROP FRONTEND/Donut Drop/build"
 *   node scripts/build-frontend.mjs --out <dir>     build somewhere else (the tests do)
 *   node scripts/build-frontend.mjs --no-esbuild    the fallback, on purpose
 *
 * infra/vps/build-frontend.sh runs this on the server during every deploy.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop');
const KEEP_RELEASES = 8;
/* Nothing newer than the browsers the site already needs (it uses :has(), oklch() and ES2022), so
 * minifying never rewrites the code into syntax the source did not already use. */
const JS_TARGET = ['es2022'];
const CSS_TARGET = ['chrome120', 'edge120', 'firefox121', 'safari17'];

const LOCAL_SHEET = /<link rel="stylesheet" href="assets\/css\/([a-z0-9-]+\.css)" \/>/g;
const MODULE_SCRIPT = /<script type="module" src="assets\/js\/([a-z0-9-]+\.js)(?:\?[^"]*)?"><\/script>/g;
const CLASSIC_SCRIPT = /<script src="assets\/js\/([a-z0-9-]+\.js)"><\/script>/g;
const MODULE_PRELOAD = /^[ \t]*<link rel="modulepreload" href="[^"]+" \/>\r?\n/gm;

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export async function loadEsbuild() {
  const places = [process.env.ESBUILD_DIR, path.join(repo, 'node_modules')].filter(Boolean);
  for (const place of places) {
    const main = path.join(place, 'esbuild', 'lib', 'main.js');
    if (!existsSync(main)) continue;
    try {
      const mod = await import(pathToFileURL(main).href);
      const esbuild = mod.build ? mod : mod.default;
      if (esbuild?.build && esbuild?.transform) return esbuild;
    } catch {
      /* a broken install is no install: fall through to the next place, then to the fallback */
    }
  }
  return null;
}

/**
 * A stylesheet's relative url()s, made absolute against where the sheet was served from. The
 * bundle is served from /b/<id>/, where "../img/x.png" would point nowhere. Fragments (#grad) and
 * data: and absolute URLs are left alone.
 */
export function absoluteUrls(css, sheetDir = '/assets/css/') {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote, ref) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(ref)) return whole;
    const resolved = new URL(ref, `https://site${sheetDir}`).pathname;
    return `url(${quote}${resolved}${quote})`;
  });
}

/**
 * Comments out of the HTML, never out of a <script> or <style> (the JSON-LD block, a template).
 * Whitespace is left as it is: collapsing it would change the gaps between inline elements.
 */
export function stripHtmlComments(html) {
  const parts = html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/<!--[\s\S]*?-->/g, '')))
    .join('')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
}

function hashFiles(dir) {
  const hash = createHash('sha256');
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(dir, full).replaceAll('\\', '/')).update('\0').update(readFileSync(full)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/** Every chunk an entry imports statically, transitively: what the head should preload. */
function staticChunks(metafile, entryOut) {
  const seen = new Set();
  const visit = (out) => {
    for (const edge of metafile.outputs[out]?.imports ?? []) {
      if (edge.kind !== 'import-statement' || seen.has(edge.path)) continue;
      seen.add(edge.path);
      visit(edge.path);
    }
  };
  visit(entryOut);
  return [...seen];
}

export async function buildFrontend({ site = SITE, out = path.join(site, 'build'), useEsbuild = true, log = console.log } = {}) {
  const esbuild = useEsbuild ? await loadEsbuild() : null;
  const html = readFileSync(path.join(site, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(LOCAL_SHEET)].map((match) => match[1]);
  const modules = [...new Set([...html.matchAll(MODULE_SCRIPT)].map((match) => match[1]))];
  const classics = [...new Set([...html.matchAll(CLASSIC_SCRIPT)].map((match) => match[1]))];
  if (!sheets.length || !modules.length) throw new Error('index.html links no stylesheets or modules: refusing to build');

  mkdirSync(path.join(out, 'b'), { recursive: true });
  const tmp = path.join(out, `.tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // ── the stylesheet ──
    let css = sheets
      .map((name) => `/* ${name} */\n${absoluteUrls(readFileSync(path.join(site, 'assets/css', name), 'utf8'))}\n`)
      .join('\n');
    if (esbuild) {
      const result = await esbuild.transform(css, { loader: 'css', minify: true, target: CSS_TARGET, legalComments: 'none', logLevel: 'silent' });
      for (const warning of result.warnings) log(`css warning: ${warning.text}`);
      css = result.code;
    }
    writeFileSync(path.join(tmp, 'site.css'), css);

    // ── the modules ──
    const entryFiles = new Map();
    const preloads = new Set();
    if (esbuild) {
      const result = await esbuild.build({
        absWorkingDir: site,
        entryPoints: modules.map((name) => path.join(site, 'assets/js', name)),
        bundle: true,
        splitting: true,
        format: 'esm',
        minify: true,
        sourcemap: 'linked',
        target: JS_TARGET,
        outdir: tmp,
        entryNames: '[name]-[hash]',
        chunkNames: 'chunk-[hash]',
        legalComments: 'none',
        metafile: true,
        logLevel: 'silent',
        charset: 'utf8',
      });
      for (const warning of result.warnings) log(`js warning: ${warning.text}`);
      for (const [file, info] of Object.entries(result.metafile.outputs)) {
        if (!info.entryPoint) continue;
        const entry = path.basename(info.entryPoint);
        const built = path.relative(tmp, path.resolve(site, file)).replaceAll('\\', '/');
        entryFiles.set(entry, built);
        for (const chunk of staticChunks(result.metafile, file)) {
          preloads.add(path.relative(tmp, path.resolve(site, chunk)).replaceAll('\\', '/'));
        }
      }
    } else {
      // Copied as they are: relative imports resolve inside the release exactly as in the source.
      cpSync(path.join(site, 'assets/js'), path.join(tmp, 'js'), { recursive: true });
      for (const name of modules) entryFiles.set(name, `js/${name}`);
    }

    // ── the classic scripts ──
    for (const name of classics) {
      let code = readFileSync(path.join(site, 'assets/js', name), 'utf8');
      if (esbuild) code = (await esbuild.transform(code, { loader: 'js', minify: true, target: JS_TARGET, legalComments: 'none' })).code;
      writeFileSync(path.join(tmp, name), code);
    }

    // ── the release ──
    const id = hashFiles(tmp);
    const base = `/b/${id}/`;
    const release = path.join(out, 'b', id);
    if (existsSync(release)) rmSync(tmp, { recursive: true, force: true });
    else renameSync(tmp, release);

    // The source's own preload list names the unbundled modules: out first, before the new one goes in.
    let page = html.replace(MODULE_PRELOAD, '');
    let first = true;
    page = page.replace(LOCAL_SHEET, () => {
      if (!first) return '';
      first = false;
      const preloadLinks = [...preloads].map((file) => `\n<link rel="modulepreload" href="${base}${file}" />`).join('');
      return `<link rel="stylesheet" href="${base}site.css" />${preloadLinks}`;
    });
    page = page.replace(MODULE_SCRIPT, (whole, name) => `<script type="module" src="${base}${entryFiles.get(name)}"></script>`);
    page = page.replace(CLASSIC_SCRIPT, (whole, name) => `<script src="${base}${name}"></script>`);
    page = stripHtmlComments(page);
    const index = path.join(out, 'index.html');
    writeFileSync(`${index}.tmp`, page);
    renameSync(`${index}.tmp`, index);

    // ── the old releases ──
    const releases = readdirSync(path.join(out, 'b'))
      .filter((name) => /^[0-9a-f]{12}$/.test(name))
      .map((name) => ({ name, at: name === id ? Infinity : statSync(path.join(out, 'b', name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of releases.slice(KEEP_RELEASES)) rmSync(path.join(out, 'b', old.name), { recursive: true, force: true });

    const size = (file) => statSync(path.join(release, file)).size;
    log(
      `built ${base} ${esbuild ? 'minified' : 'unminified (no esbuild)'}: ` +
        `${sheets.length} stylesheets -> site.css ${Math.round(size('site.css') / 1024)} KB, ` +
        `${modules.length} entries + ${preloads.size} chunks, ${classics.length} classic scripts`,
    );
    return { id, base, release, sheets, modules, classics, entryFiles, preloads: [...preloads], minified: Boolean(esbuild) };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = argValue('--out');
  await buildFrontend({ ...(out ? { out: path.resolve(out) } : {}), useEsbuild: !process.argv.includes('--no-esbuild') });
}
