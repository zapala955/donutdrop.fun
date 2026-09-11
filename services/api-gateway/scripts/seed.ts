import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

const itemSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  minecraftName: z.string().regex(/^[a-z0-9_.:-]{1,128}$/),
  displayName: z.string().min(1).max(128),
  imageUrl: z.url().startsWith('https://').max(2048).nullable().default(null),
  unitValueMinor: z.string().regex(/^[1-9]\d{0,15}$/),
  enabled: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const catalogFile = path.resolve(
  process.env['CATALOG_SEED_FILE'] ?? 'config/development/catalog.json',
);
const items = z.array(itemSchema).parse(JSON.parse(await readFile(catalogFile, 'utf8')));

if (items.length !== 0) {
  throw new Error(
    'Direct catalog seeding is disabled because it bypasses authenticated audit logging; use the admin API',
  );
}
process.stdout.write(`Catalog is empty; no items or users were created from ${catalogFile}\n`);
