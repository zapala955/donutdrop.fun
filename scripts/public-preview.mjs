/**
 * Single-origin front door for the public preview.
 *
 * The API sets SameSite=Strict session cookies and checks the exact Origin on every mutation, so
 * the frontend and the API have to answer on one origin or nothing authenticates. This serves the
 * static frontend and forwards API paths to the gateway, which makes the tunnel a single origin.
 *
 * /internal/* is refused outright. Those are the bot's HMAC-signed routes and have no business
 * being reachable from the internet, signature or not.
 *
 * Usage: node scripts/public-preview.mjs [--port 8080] [--api 127.0.0.1:3001]
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const PORT = Number(readArg('--port', '8080'));
const [API_HOST, API_PORT] = readArg('--api', '127.0.0.1:3001').split(':');
const ROOT = path.resolve(readArg('--root', 'DONUTDROP FRONTEND/Donut Drop'));

// Paths the gateway owns. Everything else is a static asset.
const API_PREFIXES = ['/v1/', '/health/'];
const BLOCKED_PREFIXES = ['/internal/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

const startsWithAny = (value, prefixes) => prefixes.some((prefix) => value.startsWith(prefix));

function proxyToApi(clientRequest, clientResponse, pathname) {
  const headers = { ...clientRequest.headers };
  // The gateway trusts forwarding headers only from 127.0.0.1, which is us. Passing the real
  // client through keeps its rate limits per visitor instead of pooling everyone into one bucket.
  const forwarded = clientRequest.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded) headers['x-forwarded-for'] = forwarded;
  headers.host = API_HOST + ':' + API_PORT;

  const upstream = httpRequest(
    { host: API_HOST, port: Number(API_PORT), method: clientRequest.method, path: pathname, headers },
    (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    },
  );
  upstream.on('error', (error) => {
    process.stdout.write('upstream error: ' + error.message + '\n');
    if (!clientResponse.headersSent) clientResponse.writeHead(502, { 'content-type': 'application/json' });
    clientResponse.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API unreachable' } }));
  });
  clientRequest.pipe(upstream);
}

async function serveStatic(clientRequest, clientResponse, pathname) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const resolved = path.resolve(ROOT, '.' + relative);
  // Refuse anything that escapes the frontend directory.
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    clientResponse.writeHead(403).end('Forbidden');
    return;
  }

  let target = resolved;
  let stats = await fs.stat(target).catch(() => undefined);
  if (stats && stats.isDirectory()) {
    target = path.join(target, 'index.html');
    stats = await fs.stat(target).catch(() => undefined);
  }
  if (!stats || !stats.isFile()) {
    // Clean SPA paths such as /terms and /battles still need the shared shell.
    target = path.join(ROOT, 'index.html');
    stats = await fs.stat(target).catch(() => undefined);
    if (!stats) {
      clientResponse.writeHead(404).end('Not found');
      return;
    }
  }

  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';

  if (path.basename(target) === 'index.html') {
    // api.js prefers window.DONUTDROP_API_URL over its baked-in meta tag. Setting it to the
    // current origin is what makes the same HTML work on localhost and on the tunnel host,
    // without editing the checked-in frontend. A classic script runs before deferred modules.
    const html = await fs.readFile(target, 'utf8');
    const injected = html.replace(
      '<head>',
      '<head>\n<script>window.DONUTDROP_API_URL=location.origin;</script>',
    );
    const body = Buffer.from(injected, 'utf8');
    clientResponse.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
    clientResponse.end(body);
    return;
  }

  clientResponse.writeHead(200, { 'content-type': type, 'content-length': stats.size });
  createReadStream(target).pipe(clientResponse);
}

const server = createServer((clientRequest, clientResponse) => {
  const pathname = new URL(clientRequest.url ?? '/', 'http://placeholder').pathname;

  if (startsWithAny(pathname, BLOCKED_PREFIXES)) {
    clientResponse.writeHead(404, { 'content-type': 'application/json' });
    clientResponse.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
    return;
  }

  if (startsWithAny(pathname, API_PREFIXES)) {
    proxyToApi(clientRequest, clientResponse, clientRequest.url ?? pathname);
    return;
  }

  serveStatic(clientRequest, clientResponse, pathname).catch((error) => {
    process.stdout.write('static error: ' + error.message + '\n');
    if (!clientResponse.headersSent) clientResponse.writeHead(500);
    clientResponse.end('Internal error');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('public-preview listening on http://127.0.0.1:' + PORT + '\n');
  process.stdout.write('  static root: ' + ROOT + '\n');
  process.stdout.write('  api upstream: ' + API_HOST + ':' + API_PORT + '\n');
});
