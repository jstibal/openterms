import Fastify from 'fastify';

import { loadConfig } from './config.js';
import { getPool, closePool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { makeJwksLoader } from './jwks/source.js';
import { registerReceiptRoutes } from './routes/receipts.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: config.logLevel } });
  const pool = getPool(config.databaseUrl);
  const loadJwks = makeJwksLoader(config.jwksSource);
  registerReceiptRoutes(app, { pool, config, loadJwks });
  return { app, config, pool };
}

async function main() {
  // Auto-run migrations on boot. Cheap and safe given CREATE IF NOT EXISTS.
  await runMigrations();
  const { app, config } = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
