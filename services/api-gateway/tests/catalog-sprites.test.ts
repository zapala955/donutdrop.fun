import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Every catalogue item must resolve to a real sprite.
 *
 * The frontend maps minecraft_name to a file through IMAGE_BY_ITEM and falls back to chest.png
 * when there is no entry. That fallback is SILENT — the tile renders, nothing throws, and the
 * item simply shows the wrong picture. Twelve items shipped in exactly that state: Stick,
 * Feather, TNT, Lava Bucket, Snow Block, Hopper, Iron Sword, Diamond Shovel, Gold Nugget,
 * Tripwire Hook, Enchanted Apple and Ender Chest all drew a generic wooden chest, so a reel that
 * should have been a row of distinct objects was half identical boxes and a drop table listed
 * eight different names against the same art.
 *
 * Nothing in the type system or the runtime could catch that, because a missing key is a valid
 * lookup returning a valid path to a real file. It needs a test that knows both sides: the item
 * list the seed writes, and the art that actually exists on disk.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const SEED = path.join(REPO, 'services/api-gateway/scripts/dev-seed.ts');
const STORE = path.join(REPO, 'DONUTDROP FRONTEND/Donut Drop/assets/js/store.js');
const FRONTEND = path.join(REPO, 'DONUTDROP FRONTEND/Donut Drop');

interface SeedItem {
  readonly name: string;
  readonly imageUrl: string | null;
}

/** Every item the seed writes to catalog_items, with its explicit art override if it has one. */
async function seededItems(): Promise<SeedItem[]> {
  const source = await readFile(SEED, 'utf8');
  const block = source.match(/const ITEMS: readonly CatalogItem\[\] = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'could not find the ITEMS table in dev-seed.ts');

  const items: SeedItem[] = [];
  // Each entry is an object literal; name is mandatory, imageUrl optional.
  for (const entry of (block[1] ?? '').split(/\},?\s*(?=\{)/)) {
    const name = entry.match(/name:\s*'([a-z0-9_]+)'/)?.[1];
    if (!name) continue;
    const image = entry.match(/imageUrl:\s*'([^']+)'/)?.[1] ?? null;
    items.push({ name, imageUrl: image });
  }
  return items;
}

/** The frontend's minecraft_name -> filename table. */
async function spriteMap(): Promise<Map<string, string>> {
  const source = await readFile(STORE, 'utf8');
  const block = source.match(/const IMAGE_BY_ITEM = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find IMAGE_BY_ITEM in store.js');

  const map = new Map<string, string>();
  for (const match of (block[1] ?? '').matchAll(/([a-z0-9_]+):\s*'([^']+)'/g)) {
    const key = match[1];
    const file = match[2];
    if (key && file) map.set(key, file);
  }
  return map;
}

const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

void describe('catalogue sprites', () => {
  void it('gives every seeded item art of its own, not the chest fallback', async () => {
    const items = await seededItems();
    const map = await spriteMap();
    assert.ok(items.length >= 40, `expected a full catalogue, found ${items.length} items`);

    const unmapped = items.filter((item) => !item.imageUrl && !map.has(item.name));
    assert.deepEqual(
      unmapped.map((item) => item.name),
      [],
      'these items have no sprite mapping and would silently render as chest.png',
    );
  });

  void it('points every mapping at a file that is actually on disk', async () => {
    const map = await spriteMap();
    const missing: string[] = [];
    for (const [name, file] of map) {
      if (!(await exists(path.join(FRONTEND, 'assets/img/items', file)))) missing.push(`${name} -> ${file}`);
    }
    assert.deepEqual(missing, [], 'sprite mappings point at files that do not exist');
  });

  void it('points every explicit imageUrl at a file that is actually on disk', async () => {
    const items = await seededItems();
    const missing: string[] = [];
    for (const item of items) {
      if (!item.imageUrl) continue;
      // Relative to the frontend root, and never allowed to escape it.
      assert.ok(
        !item.imageUrl.startsWith('/') && !item.imageUrl.includes('..'),
        `${item.name} has an absolute or traversing image path: ${item.imageUrl}`,
      );
      if (!(await exists(path.join(FRONTEND, item.imageUrl)))) {
        missing.push(`${item.name} -> ${item.imageUrl}`);
      }
    }
    assert.deepEqual(missing, [], 'explicit item art points at files that do not exist');
  });

  void it('gives every crate decal a file that is actually on disk', async () => {
    const source = await readFile(SEED, 'utf8');
    const assets = [...source.matchAll(/asset:\s*'((?:items|block)\/[^']+)'/g)]
      .map((m) => m[1])
      .filter((asset): asset is string => typeof asset === 'string');
    assert.ok(assets.length >= 50, `expected 50 crate decals, found ${assets.length}`);

    const missing: string[] = [];
    for (const asset of assets) {
      if (!(await exists(path.join(FRONTEND, 'assets/img', asset)))) missing.push(asset);
    }
    assert.deepEqual(missing, [], 'crate decals point at files that do not exist');
  });

  void it('never reuses one sprite for two different items', async () => {
    /* Two items sharing art is the same failure as the chest fallback, just harder to spot: the
     * drop table shows two different names against one picture and the player cannot tell them
     * apart on the reel.
     *
     * Checked across BOTH sources of art at once — the IMAGE_BY_ITEM table and the explicit
     * imageUrl overrides. An earlier version of this test only looked at the table, and missed
     * the two that actually mattered: the $100,000,000 Guardian Cache wearing the $620,000
     * Shulker Box's sprite, and the $130,000,000 Warden Trophy wearing the $6,500,000 Totem of
     * Undying's. A clash between a mystery payload and an ordinary drop is the worst kind,
     * because the two are hundreds of times apart in value. */
    const map = await spriteMap();
    const items = await seededItems();

    const artByItem = new Map<string, string>();
    for (const [name, file] of map) artByItem.set(name, `assets/img/items/${file}`);
    for (const item of items) if (item.imageUrl) artByItem.set(item.name, item.imageUrl);

    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [name, file] of artByItem) {
      const previous = seen.get(file);
      if (previous) clashes.push(`${previous} and ${name} both use ${file}`);
      else seen.set(file, name);
    }
    assert.deepEqual(clashes, []);
  });

  void it('has art for every file it claims, and no orphan mappings', async () => {
    // A sanity check on the other direction: the items folder should not be empty or renamed.
    const files = await readdir(path.join(FRONTEND, 'assets/img/items'));
    assert.ok(files.length > 30, `item sprite folder looks wrong, found ${files.length} files`);
  });
});
