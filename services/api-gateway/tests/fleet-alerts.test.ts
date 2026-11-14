import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';
import { fleetCounters } from '../src/lib/fleet-alerts.js';

const control = readFileSync(new URL('../src/routes/discord-control.ts', import.meta.url), 'utf8');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/* A stand-in fleet. It listens under 127.0.0.2 and, like the real one, answers only a request that
 * names 127.0.0.1:<port> as its Host. A client that cannot set Host (fetch) gets a 403 here. */
function standIn(behaviour: { numbers?: unknown; status?: number; page?: string } = {}): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const port = (server.address() as { port: number }).port;
      if (req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{"error":"Host not allowed."}');
      }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(behaviour.page ?? `<script>const TOKEN = '${TOKEN}';</script>`);
      }
      if (req.url === '/api/alerts') {
        if (req.headers['x-token'] !== TOKEN) {
          res.writeHead(403);
          return res.end('{}');
        }
        res.writeHead(behaviour.status ?? 200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(behaviour.numbers ?? { vpns_down: 1, accounts_stuck: 3 }));
      }
      res.writeHead(404);
      return res.end();
    });
    server.listen(0, '127.0.0.2', () => resolve({ server, url: `http://127.0.0.2:${(server.address() as { port: number }).port}` }));
  });
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});
const start = async (behaviour?: Parameters<typeof standIn>[0]) => {
  const { server, url } = await standIn(behaviour);
  servers.push(server);
  return url;
};

describe('fleet counters for the Discord alert poller', () => {
  it('adds nothing at all without a fleet', async () => {
    assert.deepEqual(await fleetCounters({ fleetUrl: '' }), {});
  });

  it('reads the fleet with its own Host and token, and returns three strings', async () => {
    const url = await start();
    assert.deepEqual(await fleetCounters({ fleetUrl: url }), {
      fleet_vpns_down: '1',
      fleet_accounts_stuck: '3',
      fleet_unreachable: '0',
    });
  });

  it('a fleet that refuses, answers badly or is not there costs one key and never throws', async () => {
    const closed = await start();
    servers.pop()!.close();
    const cases = [
      await start({ status: 500 }),
      await start({ numbers: { vpns_down: 'x', accounts_stuck: 2 } }),
      await start({ numbers: { vpns_down: -1, accounts_stuck: 2 } }),
      await start({ numbers: { vpns_down: 1.5, accounts_stuck: 2 } }),
      await start({ page: '<html>no token here</html>' }),
      closed,
    ];
    for (const fleetUrl of cases) {
      assert.deepEqual(await fleetCounters({ fleetUrl }), { fleet_unreachable: '1' }, fleetUrl);
    }
  });

  it('is merged into the counters the bot already polls, after the site\'s own', () => {
    assert.ok(control.includes("import { fleetCounters } from '../lib/fleet-alerts.js';"));
    assert.ok(control.includes('return { ...(result.rows[0] ?? {}), ...(await fleetCounters(config)) };'));
  });
});
