import { request as httpRequest } from 'node:http';
import type { AppConfig } from '../config.js';

/**
 * The bot fleet's health, as three counters for the Discord bot's alert poller.
 *
 * The poller already asks the gateway for a handful of integers and reports one only when it rises
 * (see discord-bot/src/alerts.ts), into the channel and role the admin panel names. The fleet joins
 * that: how many of its VPNs are down, how many accounts cannot get back in, and whether it can be
 * reached at all. Numbers only. Which VPN and which account is for the admin console's Fleet tab, so
 * nothing here names an account and the fleet's token never leaves this file.
 *
 * It must never be able to break the counters it sits beside: any failure turns into
 * fleet_unreachable and nothing else, and no fleet means no extra keys at all.
 */

const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface FleetCounters {
  readonly fleet_vpns_down?: string;
  readonly fleet_accounts_stuck?: string;
  readonly fleet_unreachable?: string;
}

/** node:http because fetch drops a Host header, and the fleet only answers its own loopback address. */
function get(url: URL, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const out = httpRequest(
      { host: url.hostname, port: url.port || 80, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) out.destroy(new Error('answer too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
    );
    out.on('error', reject);
    out.setTimeout(TIMEOUT_MS, () => out.destroy(new Error('timeout')));
    out.end();
  });
}

export async function fleetCounters(config: Pick<AppConfig, 'fleetUrl'>): Promise<FleetCounters> {
  if (!config.fleetUrl) return {};
  const fleet = new URL(config.fleetUrl);
  const headers = { host: `127.0.0.1:${fleet.port || '80'}`, 'user-agent': 'donutluxe-fleet-alerts' };
  try {
    /* The fleet's token is minted per process and handed to its own page, so it is read from there, the
     * way the console's frame gets it. A restart of the fleet changes it, and the next poll just reads
     * the new one. */
    const page = await get(fleet, '/', headers);
    const token = /const TOKEN = '([0-9a-f]{20,})'/.exec(page.body)?.[1];
    if (page.status !== 200 || !token) throw new Error('no token');
    const answer = await get(fleet, '/api/alerts', { ...headers, 'x-token': token });
    if (answer.status !== 200) throw new Error(`status ${answer.status}`);
    const data = JSON.parse(answer.body) as { vpns_down?: unknown; accounts_stuck?: unknown };
    const vpns = Number(data.vpns_down);
    const stuck = Number(data.accounts_stuck);
    if (!Number.isInteger(vpns) || vpns < 0 || !Number.isInteger(stuck) || stuck < 0) throw new Error('bad numbers');
    return { fleet_vpns_down: String(vpns), fleet_accounts_stuck: String(stuck), fleet_unreachable: '0' };
  } catch {
    return { fleet_unreachable: '1' };
  }
}
