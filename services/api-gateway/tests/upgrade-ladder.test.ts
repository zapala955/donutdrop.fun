import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  LADDER_CEILING_MINOR,
  LADDER_FLOOR_MINOR,
  UPGRADE_LADDER,
} from '../src/lib/upgrade-ladder.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
const FRONTEND = path.join(REPO, 'DONUTDROP FRONTEND/Donut Drop');

/* The window the server enforces, as shipped in infra/vps/donutdrop.env.example. A ladder that is
 * only navigable under some other configuration is not the one production runs. */
const MIN_MULTIPLIER_BPS = 11_000n;
const MAX_MULTIPLIER_BPS = 1_000_000n;

describe('the upgrade prize ladder', () => {
  it('spans exactly the range it claims', () => {
    const values = UPGRADE_LADDER.map((rung) => BigInt(rung.unitValueMinor));
    assert.equal(values[0], LADDER_FLOOR_MINOR);
    assert.equal(values.at(-1), LADDER_CEILING_MINOR);
    assert.equal(LADDER_FLOOR_MINOR, 100_000n);
    assert.equal(LADDER_CEILING_MINOR, 10_000_000_000n);
  });

  it('rises without repeating', () => {
    const values = UPGRADE_LADDER.map((rung) => BigInt(rung.unitValueMinor));
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1]!;
      const current = values[index]!;
      assert.ok(current > previous, `rung ${index} (${current}) does not rise above ${previous}`);
    }
  });

  it('puts every rung within reach of the one below it', () => {
    /* The point of the spacing. If a neighbouring pair were closer together than the minimum
     * multiplier, the server would refuse a bet from one to the next and the ladder would have a
     * rung nobody could step onto — visible in the grid, rejected on commit. */
    const values = UPGRADE_LADDER.map((rung) => BigInt(rung.unitValueMinor));
    for (let index = 1; index < values.length; index += 1) {
      const from = values[index - 1]!;
      const to = values[index]!;
      assert.ok(
        to * 10_000n >= from * MIN_MULTIPLIER_BPS,
        `${to} is under the minimum multiplier from ${from}`,
      );
    }
  });

  it('leaves a real choice at every stake on it', () => {
    /* Density, stated as the thing it is for: standing on any rung, how many targets are legal?
     * A catalogue that offers two is a coin flip with extra steps. */
    const values = UPGRADE_LADDER.map((rung) => BigInt(rung.unitValueMinor));
    // The top rungs necessarily run out of ladder above them, so they are exempt by definition.
    for (const stake of values.slice(0, -10)) {
      const reachable = values.filter(
        (value) =>
          value * 10_000n >= stake * MIN_MULTIPLIER_BPS &&
          value * 10_000n <= stake * MAX_MULTIPLIER_BPS,
      );
      assert.ok(reachable.length >= 10, `only ${reachable.length} targets from a stake of ${stake}`);
    }
  });

  it('is keyed by values the database and the admin schema both accept', () => {
    const fingerprints = new Set<string>();
    const names = new Set<string>();
    for (const rung of UPGRADE_LADDER) {
      // catalog_items CHECK (fingerprint ~ '^[a-f0-9]{64}$')
      assert.match(rung.fingerprint, /^[a-f0-9]{64}$/, rung.displayName);
      // catalogCreateSchema's minecraftName pattern, so a rung stays creatable by hand too.
      assert.match(rung.minecraftName, /^[a-z0-9_.:-]{1,128}$/, rung.displayName);
      // catalog_items CHECK (unit_value_minor > 0), and the admin schema's digit cap.
      assert.match(rung.unitValueMinor, /^[1-9]\d{0,15}$/, rung.displayName);
      assert.ok(rung.displayName.length <= 128);
      fingerprints.add(rung.fingerprint);
      names.add(rung.displayName);
    }
    assert.equal(fingerprints.size, UPGRADE_LADDER.length, 'two rungs share a fingerprint');
    assert.equal(names.size, UPGRADE_LADDER.length, 'two rungs share a name');
  });

  it('keeps a rung tied to its price', async () => {
    /* The fingerprint is the natural key the publish route conflicts on, so it must be derived
     * from the value and nothing else. If it ever stopped being, a rung could be silently
     * re-pointed at a different figure instead of a new rung appearing beside it. */
    const source = await readFile(
      path.join(REPO, 'services/api-gateway/src/lib/upgrade-ladder.ts'),
      'utf8',
    );
    assert.match(source, /donutdrop:upgrade-ladder:\$\{unitValueMinor\}/);
  });

  it('draws art that exists', async () => {
    /* A missing sprite is silent: the browser renders a broken image and nothing throws. Fifty-one
     * rungs share six files, so one typo would be forty-odd broken tiles. */
    for (const rung of UPGRADE_LADDER) {
      assert.match(rung.imageUrl, /^assets\/img\/items\/[a-z-]+\.svg$/, rung.displayName);
      await access(path.join(FRONTEND, rung.imageUrl));
    }
  });

  it('gives each tier art nobody else is using', async () => {
    /* Tiers are told apart by silhouette before they are read by label, so two tiers sharing a
     * file would collapse that. Checked against the seeded catalogue too: a ladder rung and an
     * observed item drawing the same picture is the bug catalog-sprites.test.ts exists for. */
    const arts = new Set(UPGRADE_LADDER.map((rung) => rung.imageUrl));
    assert.equal(arts.size, 6, 'the six tiers do not have six distinct sprites');
    const seed = await readFile(path.join(REPO, 'services/api-gateway/scripts/dev-seed.ts'), 'utf8');
    for (const art of arts) assert.ok(!seed.includes(art), `${art} is also used by the seed`);
  });
});

describe('publishing the ladder', () => {
  it('is an admin action that carries a reason and no prices', async () => {
    const source = await readFile(
      path.join(REPO, 'services/api-gateway/src/routes/admin.ts'),
      'utf8',
    );
    const route = source.indexOf("'/v1/admin/catalog-ladder'");
    assert.ok(route > 0, 'the publish route is missing');
    const guard = source.indexOf('guards.requireAdmin', route);
    const parse = source.indexOf('catalogLadderSchema', route);
    assert.ok(guard > route && guard < route + 200, 'the route is not behind requireAdmin');
    assert.ok(parse > route, 'the route does not parse a body');

    /* The schema is the control. An endpoint that accepted figures would be exactly the bulk
     * price-setting tool that seed.ts and empty-catalog.test.ts exist to prevent — this one can
     * only ever write the values compiled into the service. */
    const schema = source.match(/const catalogLadderSchema = z\.object\(\{([^}]*)\}\)/);
    assert.ok(schema, 'catalogLadderSchema is not an object literal any more');
    assert.match(schema[1] ?? '', /^\s*reason: safeText\(3, 256\),?\s*$/);
  });

  it('records provenance for every price it sets', async () => {
    const source = await readFile(
      path.join(REPO, 'services/api-gateway/src/routes/admin.ts'),
      'utf8',
    );
    const route = source.indexOf("'/v1/admin/catalog-ladder'");
    const next = source.indexOf("'/v1/admin/catalog-items/:id'", route);
    const body = source.slice(route, next);
    /* Both halves. The audit entry says who published the ladder and why; the price-history rows
     * say what each individual rung was worth before and after. Losing either one is how a payout
     * ends up with no answer to "who set this". */
    assert.match(body, /catalog\.ladder_publish/);
    assert.ok(
      (body.match(/INSERT INTO catalog_price_history/g) ?? []).length === 2,
      'price history is not written on both the create and the reprice path',
    );
  });
});

describe('the client reads the whole catalogue', () => {
  it('pages instead of asking for one capped page', async () => {
    /* The server caps a page at 100 rows and orders them cheapest first. With fifty-one fixed
     * denominations stacked on the observed catalogue, a single request drops the expensive half
     * — and drops it silently, since a truncated page looks exactly like a complete one. */
    const store = await readFile(path.join(FRONTEND, 'assets/js/store.js'), 'utf8');
    assert.doesNotMatch(store, /catalog\/items\?limit=100'/);
    assert.match(store, /offset=' \+ page \* CATALOG_PAGE/);
    assert.match(store, /if \(batch\.length < CATALOG_PAGE\) break;/);
  });

  it('does not put catalogue text into markup', async () => {
    /* display_name and image_url arrive over the network. itemTile draws them on nearly every
     * surface of the site, so interpolating either into HTML makes one admin-set string a
     * site-wide stored-XSS payload. */
    const util = await readFile(path.join(FRONTEND, 'assets/js/util.js'), 'utf8');
    const tile = util.slice(util.indexOf('export function itemTile'));
    const body = tile.slice(0, tile.indexOf('\n}'));
    assert.doesNotMatch(body, /innerHTML/);
    assert.match(body, /name\.textContent = item\.name;/);
    assert.match(body, /img\.src = safeImage\(item\.img\);/);
  });
});
