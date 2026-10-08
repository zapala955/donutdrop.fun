import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { ApiClient, BotProxy } from '../src/api-client.js';
import { loadBotConfig } from '../src/config.js';
import { describeRoute, openTunnel, proxiedConnect } from '../src/proxy.js';
import type { TransferAdapter } from '../src/transfer-adapter.js';
import { MinecraftWorker } from '../src/worker.js';

/* Real sockets on loopback throughout: an echo server stands in for DonutSMP, and the two proxies
 * are minimal but speak the actual protocols, so these exercise the bytes, not a mock of them. */

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** SOCKS5 with username/password authentication (RFC 1928, RFC 1929), CONNECT only. */
function socks5Server(user: string, pass: string): net.Server {
  return net.createServer((client) => {
    let stage: 'greeting' | 'auth' | 'request' | 'piping' = 'greeting';
    let buffer = Buffer.alloc(0);
    client.on('error', () => undefined);
    client.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        const methods = buffer.subarray(2, 2 + buffer[1]!);
        buffer = buffer.subarray(2 + buffer[1]!);
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1]!;
        if (buffer.length < 3 + userLength) return;
        const passLength = buffer[2 + userLength]!;
        if (buffer.length < 3 + userLength + passLength) return;
        const givenUser = buffer.subarray(2, 2 + userLength).toString();
        const givenPass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString();
        buffer = buffer.subarray(3 + userLength + passLength);
        const accepted = givenUser === user && givenPass === pass;
        client.write(Buffer.from([1, accepted ? 0 : 1]));
        if (!accepted) {
          client.end();
          return;
        }
        stage = 'request';
      }
      if (stage === 'request') {
        if (buffer.length < 10 || buffer[3] !== 1) return;
        const host = [...buffer.subarray(4, 8)].join('.');
        const port = buffer.readUInt16BE(8);
        const rest = buffer.subarray(10);
        stage = 'piping';
        client.pause();
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.removeAllListeners('data');
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      }
    });
  });
}

/** An HTTP proxy that only does CONNECT, with Basic authentication. */
function httpConnectProxy(user: string, pass: string): http.Server {
  const server = http.createServer((_request, response) => response.writeHead(405).end());
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => undefined);
    const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    if (request.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = (request.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
  });
  return server;
}

function proxy(overrides: Partial<BotProxy>): BotProxy {
  return {
    revision: '50000000-0000-4000-8000-000000000005',
    type: 'socks5',
    host: '127.0.0.1',
    port: 1,
    username: null,
    password: null,
    ...overrides,
  };
}

async function roundTrip(socket: net.Socket, text: string): Promise<string> {
  socket.write(text);
  const [chunk] = (await once(socket, 'data')) as [Buffer];
  socket.destroy();
  return chunk.toString();
}

describe('reaching the server through a proxy', () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const socks = socks5Server('bot-one', 'hunter2');
  const httpProxy = httpConnectProxy('bot-two', 'swordfish');
  let echoPort = 0;
  let socksPort = 0;
  let httpPort = 0;

  before(async () => {
    [echoPort, socksPort, httpPort] = await Promise.all([
      listen(echo),
      listen(socks),
      listen(httpProxy),
    ]);
  });
  after(() => {
    echo.close();
    socks.close();
    httpProxy.close();
  });

  it('tunnels through SOCKS5 with a username and password', async () => {
    const socket = await openTunnel(
      proxy({ type: 'socks5', port: socksPort, username: 'bot-one', password: 'hunter2' }),
      { host: '127.0.0.1', port: echoPort },
    );
    assert.equal(await roundTrip(socket, 'ping'), 'ping');
  });

  it('fails, rather than going direct, when SOCKS5 refuses the credentials', async () => {
    await assert.rejects(
      openTunnel(
        proxy({ type: 'socks5', port: socksPort, username: 'bot-one', password: 'wrong' }),
        { host: '127.0.0.1', port: echoPort },
      ),
    );
  });

  it('tunnels through an HTTP proxy with CONNECT and Basic authentication', async () => {
    const socket = await openTunnel(
      proxy({ type: 'http', port: httpPort, username: 'bot-two', password: 'swordfish' }),
      { host: '127.0.0.1', port: echoPort },
    );
    assert.equal(await roundTrip(socket, 'pong'), 'pong');
  });

  it('reports an HTTP proxy that refuses the tunnel', async () => {
    await assert.rejects(
      openTunnel(proxy({ type: 'http', port: httpPort, username: 'bot-two', password: 'nope' }), {
        host: '127.0.0.1',
        port: echoPort,
      }),
      /HTTP 407/,
    );
  });

  it("hands minecraft-protocol a connected socket, and greets the server by its own address", async () => {
    const options = { host: '127.0.0.1', port: echoPort };
    const events: string[] = [];
    let socket: net.Socket | undefined;
    const connected = new Promise<void>((resolve) => {
      proxiedConnect(
        proxy({ type: 'socks5', port: socksPort, username: 'bot-one', password: 'hunter2' }),
        options,
      )({
        setSocket: (given) => {
          socket = given;
        },
        emit: (event) => {
          events.push(event);
          if (event === 'connect') resolve();
          return true;
        },
      });
    });
    await connected;
    assert.deepEqual(events, ['connect']);
    assert.ok(socket);
    assert.equal(await roundTrip(socket, 'hello'), 'hello');
    // An IP literal has no SRV record to follow, so the handshake names it unchanged.
    assert.deepEqual(options, { host: '127.0.0.1', port: echoPort });
  });

  it('ends the client when the proxy cannot be reached, so the ordinary reconnect takes over', async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    closed.close();
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      proxiedConnect(proxy({ type: 'socks5', port: deadPort }), {
        host: '127.0.0.1',
        port: echoPort,
      })({
        setSocket: () => assert.fail('a socket was handed over for a proxy that is down'),
        emit: (event) => {
          events.push(event);
          if (event === 'end') resolve();
          return true;
        },
      });
    });
    assert.deepEqual(events, ['error', 'end']);
  });
});

describe('the route in the logs', () => {
  it('names the proxy and never prints its password', () => {
    const line = describeRoute(
      proxy({ type: 'http', host: 'gate.example.net', port: 8080, username: 'u1', password: 'secret' }),
    );
    assert.equal(line, 'http://u1@gate.example.net:8080');
    assert.doesNotMatch(line, /secret/);
    assert.equal(describeRoute(null), 'direct');
  });
});

describe('how the worker learns its route', () => {
  type RouteHarness = {
    knownRoute: { proxy: BotProxy | null } | undefined;
    routeRevision: string | undefined;
    bot: unknown;
    resolveRoute(): Promise<BotProxy | null>;
    heartbeat(online: boolean): Promise<void>;
  };

  function worker(api: Partial<ApiClient>): RouteHarness {
    const config = loadBotConfig({
      NODE_ENV: 'test',
      MINECRAFT_HOST: 'donutsmp.net',
      MINECRAFT_USERNAME: 'bot-account@example.com',
      MINECRAFT_EXPECTED_USERNAME: 'DonutBot',
      MINECRAFT_PROFILES_FOLDER: '/tmp/minecraft-auth',
      BOT_ID: '10000000-0000-4000-8000-000000000001',
      API_INTERNAL_URL: 'http://api:3001/internal/v1/minecraft',
      BOT_WEBHOOK_SECRET: Buffer.alloc(32, 7).toString('base64'),
    });
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    } as unknown as Logger;
    return new MinecraftWorker(
      config,
      api as ApiClient,
      {} as TransferAdapter,
      log,
    ) as unknown as RouteHarness;
  }

  it('remembers the last answer and uses it when the gateway cannot be asked', async () => {
    const assigned = proxy({ host: 'gate.example.net', port: 1080 });
    let reachable = true;
    const harness = worker({
      connectionRoute: async () => {
        if (!reachable) throw new Error('API down');
        return assigned;
      },
    });
    assert.deepEqual(await harness.resolveRoute(), assigned);
    reachable = false;
    assert.deepEqual(await harness.resolveRoute(), assigned);
  });

  it('does not guess "direct" when it has never had an answer', async () => {
    const harness = worker({
      connectionRoute: async () => {
        throw new Error('API down');
      },
    });
    await assert.rejects(harness.resolveRoute(), /API down/);
  });

  it('reports the assignment it connected with on the heartbeat, and only while online', async () => {
    const sent: Record<string, unknown>[] = [];
    const harness = worker({
      sendEvent: async (event: Record<string, unknown>) => {
        sent.push(event);
      },
    });
    harness.bot = { username: 'DonutBot' };
    harness.routeRevision = '50000000-0000-4000-8000-000000000005';
    await harness.heartbeat(true);
    await harness.heartbeat(false);
    harness.routeRevision = undefined;
    await harness.heartbeat(true);
    assert.equal(sent[0]?.['proxyRevision'], '50000000-0000-4000-8000-000000000005');
    assert.equal('proxyRevision' in sent[1]!, false);
    assert.equal('proxyRevision' in sent[2]!, false);
  });
});
