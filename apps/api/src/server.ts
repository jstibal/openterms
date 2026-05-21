import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { loadConfig, type AppConfig } from './config.js';
import { getPool, closePool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { makeJwksLoader } from './jwks/source.js';
import { PUBLIC_ROUTE, registerBearerAuth } from './auth/bearer.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerJwksRoute } from './routes/jwks.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { registerReceiptQueryRoutes } from './routes/receipts_query.js';
import { registerSimulateRoutes } from './routes/simulate.js';

export async function buildServer(opts?: { config?: AppConfig }) {
  const config = opts?.config ?? loadConfig();
  const app: FastifyInstance = Fastify({ logger: { level: config.logLevel } });
  const pool = getPool(config.databaseUrl);
  const loadJwks = makeJwksLoader(config.jwksSource);

  // CORS first — runs before auth so preflight OPTIONS requests are answered
  // without a 401. corsOrigin defaults to '*' (staging is permissive per the
  // session decision). Production hardening: lock this to the dashboard
  // origin once observe.openterms.com ships.
  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 600,
  });

  // Rate limiting. Keyed by workspace_id when authenticated, by IP when not.
  // The plugin's default emits draft-7 RateLimit-* headers. In-memory store
  // is correct for the staging single-instance deployment; horizontal scale
  // requires Redis (flagged in DEPLOYMENT.md).
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitAuthQuery,
    timeWindow: '1 minute',
    keyGenerator: (req: import('fastify').FastifyRequest) => req.workspaceId ?? req.ip,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  // Auth hook applies to every route unless the route opts out with
  // `config: { public: true }`.
  await registerBearerAuth(app, { pool, config });

  // Public health endpoint. Used by Render's healthcheck and by ops smoke
  // scripts. Returns minimal info — no version, no env — so it leaks
  // nothing about the deployment.
  app.get('/healthz', PUBLIC_ROUTE, async () => ({ ok: true }));

  registerJwksRoute(app, { loadJwks });
  registerReceiptRoutes(app, { pool, config, loadJwks });
  registerReceiptQueryRoutes(app, { pool, config });
  registerDecisionRoutes(app, { pool, config });
  registerSimulateRoutes(app, { pool, config });
  return { app, config, pool };
}

async function main() {
  // Migrations are owned by `preDeployCommand` in production (render.yaml)
  // so a failed migration blocks the deploy before traffic shifts. In
  // non-production we still auto-run on boot for local dev ergonomics.
  if (process.env.NODE_ENV !== 'production') {
    await runMigrations();
  }
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
