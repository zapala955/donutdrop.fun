import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { SocksClient } from 'socks';
import type { BotProxy } from './api-client.js';

/** How long a proxy gets to open a tunnel before the attempt counts as failed. */
const TUNNEL_TIMEOUT_MS = 15_000;

export interface Destination {
  host: string;
  port: number;
}

/** A proxy as it is safe to write in a log line: no password. */
export function describeRoute(proxy: BotProxy | null): string {
  if (!proxy) return 'direct';
  const user = proxy.username === null ? '' : `${proxy.username}@`;
  return `${proxy.type}://${user}${proxy.host}:${proxy.port}`;
}

/**
 * The address minecraft-protocol would connect to by itself: the `_minecraft._tcp` SRV record when
 * the port is the default and the host is a name, otherwise the host as given. Looked up here
 * because the proxy is only told where to connect, never how the address was found.
 */
export async function resolveMinecraftServer(host: string, port: number): Promise<Destination> {
  if (port !== 25_565 || net.isIP(host) !== 0 || host === 'localhost') return { host, port };
  try {
    const [record] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (record) return { host: record.name, port: record.port };
  } catch {
    // No SRV record: the host itself, which is what minecraft-protocol falls back to as well.
  }
  return { host, port };
}

/** Opens a TCP stream to `destination` through the proxy. */
export async function openTunnel(
  proxy: BotProxy,
  destination: Destination,
  timeoutMs = TUNNEL_TIMEOUT_MS,
): Promise<net.Socket> {
  if (proxy.type === 'socks5') {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.username === null ? {} : { userId: proxy.username }),
        ...(proxy.password === null ? {} : { password: proxy.password }),
      },
      command: 'connect',
      destination,
      timeout: timeoutMs,
    });
    return socket;
  }
  return httpConnect(proxy, destination, timeoutMs);
}

/** An HTTP proxy's CONNECT method: one request, and on a 200 the socket is the tunnel. */
function httpConnect(
  proxy: BotProxy,
  destination: Destination,
  timeoutMs: number,
): Promise<net.Socket> {
  const authority = `${net.isIPv6(destination.host) ? `[${destination.host}]` : destination.host}:${destination.port}`;
  const headers: Record<string, string> = { host: authority };
  if (proxy.username !== null) {
    const credentials = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64');
    headers['proxy-authorization'] = `Basic ${credentials}`;
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers,
      timeout: timeoutMs,
      agent: false,
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`the proxy refused the tunnel with HTTP ${response.statusCode}`));
        return;
      }
      // The request's timeout was armed on this socket; it is a game connection now, idle at times.
      socket.setTimeout(0);
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once('timeout', () => request.destroy(new Error('the proxy did not answer in time')));
    request.once('error', reject);
    request.end();
  });
}

/** The two things minecraft-protocol's `connect` option touches on its client. */
interface ConnectingClient {
  setSocket(socket: net.Socket): void;
  emit(event: string, ...args: unknown[]): boolean;
}

/**
 * minecraft-protocol's `connect` option, opening every connection it makes -- the version ping as
 * well as the login -- through the proxy instead of straight from the VPS.
 *
 * `options` is the same object minecraft-protocol reads the handshake's host and port from, and it
 * is updated with the SRV answer exactly as its own connect does, so the server is greeted the same
 * way either route.
 *
 * A tunnel that cannot be opened ends the client, so the bot goes through its ordinary reconnect.
 */
export function proxiedConnect(
  proxy: BotProxy,
  options: { host?: string | undefined; port?: number | undefined },
): (client: ConnectingClient) => void {
  return (client) => {
    resolveMinecraftServer(options.host ?? 'localhost', options.port ?? 25_565)
      .then(async (target) => {
        options.host = target.host;
        options.port = target.port;
        const socket = await openTunnel(proxy, target);
        client.setSocket(socket);
        client.emit('connect');
      })
      .catch((error: unknown) => {
        client.emit('error', error);
        client.emit('end', 'proxyConnectFailed');
      });
  };
}

/**
 * An HTTPS agent whose connections go through the proxy too.
 *
 * Used for the one HTTPS request a login makes on its own, the session-server join. A server can
 * check that the join and the game connection come from the same address, and a join sent from the
 * VPS while the game connection arrives from the proxy would fail that check.
 */
export class TunnelledHttpsAgent extends https.Agent {
  constructor(private readonly proxy: BotProxy) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = options.hostname ?? options.host ?? 'localhost';
    const port = Number(options.port ?? 443);
    // SNI carries a name, never an IP literal.
    const servername = options.servername ?? host;
    openTunnel(this.proxy, { host, port }).then(
      (socket) =>
        callback?.(
          null,
          tls.connect({ socket, ...(net.isIP(servername) === 0 ? { servername } : {}) }),
        ),
      (error: unknown) =>
        callback?.(error instanceof Error ? error : new Error(String(error)), undefined as never),
    );
    return undefined;
  }
}
