// Runs all .sql files in src/db/migrations/ in lexical order. Idempotent —
// migrations use CREATE TABLE IF NOT EXISTS etc.
//
// tsc does not copy .sql files into dist/, so we resolve the migrations
// directory by walking up to the repo location of src/db/migrations/. This
// works from both `dist/db/migrate.js` (production) and `src/db/migrate.ts`
// (tsx dev) without a build step for migration files.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool, closePool } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveMigrationsDir(): string {
  // dist/db/ → ../../src/db/migrations | src/db/ → ./migrations
  const candidates = [
    path.join(here, 'migrations'),
    path.join(here, '..', '..', 'src', 'db', 'migrations'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Could not locate migrations dir; tried: ${candidates.join(', ')}`);
}

export async function runMigrations(databaseUrl?: string): Promise<string[]> {
  const pool = getPool(databaseUrl);
  const dir = resolveMigrationsDir();
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    await pool.query(sql);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((files) => {
      console.log('Applied migrations:', files);
      return closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
