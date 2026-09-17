/* battle-rtp.mjs — runs many battles and checks the aggregate economics.
 *
 * A single battle proves nothing about the edge: six opens of a high-variance crate can return
 * anything. This runs enough of them for the law of large numbers to bite, and checks the three
 * invariants that must hold on EVERY battle regardless of sample size:
 *
 *   1. the pot equals the sum of every drop;
 *   2. what was paid out equals the pot;
 *   3. no money is created — total credited never exceeds total staked plus the drops.
 */
const API = 'http://127.0.0.1:3001';
const TOKEN = process.env.DEV_TOKEN;
const BATTLES = Number(process.env.BATTLES ?? 60);
const out = (...a) => console.log(...a);

function makeClient() {
  const jar = new Map();
  return {
    csrf: null,
    async call(path, { method = 'GET', body } = {}) {
      const headers = { origin: 'http://localhost:8080' };
      if (body) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (this.csrf) headers['x-csrf-token'] = this.csrf;
      const res = await fetch(API + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const text = await res.text();
      try { return { status: res.status, json: text ? JSON.parse(text) : null }; }
      catch { return { status: res.status, json: null }; }
    },
    async login(suffix, balance) {
      const res = await this.call('/v1/dev/login', {
        method: 'POST', body: { token: TOKEN, identitySuffix: suffix, balanceMinor: String(balance) },
      });
      this.csrf = res.json?.csrfToken ?? null;
      return res.json;
    },
    async balance() {
      const res = await this.call('/v1/balance');
      return BigInt(res.json?.balanceMinor ?? res.json?.balance ?? 0);
    },
  };
}

const host = makeClient();
const guest = makeClient();
await host.login('rtphost', 900_000_000);
await guest.login('rtpguest', 900_000_000);

const cases = await host.call('/v1/cases?limit=60');
const pool = (cases.json?.cases ?? []).filter((c) => Number(c.priceMinor) <= 50_000);
if (pool.length < 3) { out('not enough cheap crates'); process.exit(1); }

const startHost = await host.balance();
const startGuest = await guest.balance();

let staked = 0n;
let potTotal = 0n;
let paidTotal = 0n;
let invariantFailures = 0;
let modeCrazyWins = 0;
let run = 0;

/* Paced to the create route's own rate limit (20/minute). The limiter is a real protection and
 * the test respects it rather than asking for an exemption. */
const PACE_MS = Number(process.env.PACE_MS ?? 3200);
for (let i = 0; i < BATTLES; i += 1) {
  if (i > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const picks = [pool[i % pool.length], pool[(i + 1) % pool.length], pool[(i + 2) % pool.length]];
  const mode = i % 4 === 3 ? 'crazy' : 'standard';
  const created = await host.call('/v1/battles', {
    method: 'POST',
    body: {
      format: '1v1', mode, visibility: 'public', allowBots: false,
      caseIds: picks.map((c) => c.id), clientSeed: `host-${i}`,
    },
  });
  let code = created.json?.battle?.code;
  if (!code && (created.status === 401 || created.status === 429)) {
    // The dev session can lapse across a long run; re-authenticate and retry once.
    await new Promise((r) => setTimeout(r, 4000));
    await host.login('rtphost', 900_000_000);
    await guest.login('rtpguest', 900_000_000);
    const again = await host.call('/v1/battles', {
      method: 'POST',
      body: {
        format: '1v1', mode, visibility: 'public', allowBots: false,
        caseIds: picks.map((c) => c.id), clientSeed: `host-retry-${i}`,
      },
    });
    code = again.json?.battle?.code;
  }
  if (!code) { out(`  battle ${i} create failed ${created.status}`); continue; }

  const joined = await guest.call(`/v1/battles/${code}/join`, {
    method: 'POST', body: { clientSeed: `guest-${i}` },
  });
  if (joined.status !== 200) { out(`  battle ${i} join failed ${joined.status}`); continue; }

  const battle = joined.json?.battle;
  const entry = BigInt(battle.entryCostMinor);
  const drops = (battle.results ?? []).reduce((s, r) => s + BigInt(r.payoutMinor), 0n);
  const paid = (battle.seats ?? []).reduce((s, r) => s + BigInt(r.payoutMinor ?? 0), 0n);
  const pot = BigInt(battle.potMinor ?? 0);

  if (drops !== pot || paid !== pot) invariantFailures += 1;

  // In crazy mode the winner must be the LOWEST team total.
  if (mode === 'crazy') {
    const totals = new Map();
    for (const s of battle.seats) {
      totals.set(s.team, (totals.get(s.team) ?? 0n) + BigInt(s.totalDropMinor ?? 0));
    }
    const lowest = [...totals.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))[0][0];
    if (lowest === battle.winningTeam) modeCrazyWins += 1;
    else invariantFailures += 1;
  }

  staked += entry * 2n;
  potTotal += pot;
  paidTotal += paid;
  run += 1;
}

const endHost = await host.balance();
const endGuest = await guest.balance();

out(`battles run: ${run} of ${BATTLES}`);
out('');
out('== per-battle invariants ==');
out(`  pot == sum of drops, and payout == pot, on every battle: ${invariantFailures === 0 ? 'YES' : `NO (${invariantFailures} failures)`}`);
out(`  crazy mode paid the LOWEST total: ${modeCrazyWins} of ${Math.floor(run / 4)} crazy battles`);
out('');
out('== aggregate economics ==');
const rtp = staked > 0n ? Number(potTotal * 10000n / staked) / 100 : 0;
out(`  staked   ${staked}`);
out(`  returned ${potTotal}  (${rtp.toFixed(2)}% RTP)`);
out(`  house    ${staked - potTotal}  (${(100 - rtp).toFixed(2)}% edge)`);
out(`  paid out ${paidTotal} == pot total: ${paidTotal === potTotal ? 'YES' : 'NO'}`);
out('');
out('== wallets reconcile ==');
const walletDelta = (endHost - startHost) + (endGuest - startGuest);
const expectedDelta = potTotal - staked;
out(`  host  ${startHost} -> ${endHost}`);
out(`  guest ${startGuest} -> ${endGuest}`);
out(`  combined change ${walletDelta}`);
out(`  expected (returned - staked) ${expectedDelta}`);
out(`  wallets match the ledger: ${walletDelta === expectedDelta ? 'YES' : 'NO'}`);
process.exit(invariantFailures === 0 && walletDelta === expectedDelta ? 0 : 1);
