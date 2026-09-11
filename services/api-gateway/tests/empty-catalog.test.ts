import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('initial catalog policy', () => {
  it('ships without any configured Minecraft items', async () => {
    const filename = path.resolve(import.meta.dirname, '../../../config/development/catalog.json');
    const catalog = JSON.parse(await readFile(filename, 'utf8')) as unknown;

    assert.deepEqual(catalog, []);
  });

  it('does not insert catalog inventory from a database migration', async () => {
    const migrationsDirectory = path.resolve(import.meta.dirname, '../../../packages/db/migrations');
    const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
      name.endsWith('.sql'),
    );

    for (const migrationName of migrationNames) {
      const sql = await readFile(path.join(migrationsDirectory, migrationName), 'utf8');
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+catalog_items/i);
      assert.doesNotMatch(sql, /INSERT\s+INTO\s+inventory_lots/i);
    }
  });
});
