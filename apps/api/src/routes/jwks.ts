// GET /.well-known/jwks.json — public, edge-cacheable JWKS distribution.
//
// Cache headers per BUILD_BRIEF Step 6 / red-team note: 24h max-age,
// with stale-while-revalidate to keep the endpoint resilient to brief
// upstream blips. The JWKS is intentionally re-read from the source on
// every request — for `file:` this is a fresh disk read, for `memory:`
// it's the captured object. Rotations therefore propagate without a
// server restart when JWKS_SOURCE points at a file.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { JwksLoader } from '../jwks/source.js';
import { PUBLIC_ROUTE } from '../auth/bearer.js';

interface Deps {
  loadJwks: JwksLoader;
}

export function registerJwksRoute(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/.well-known/jwks.json',
    PUBLIC_ROUTE,
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const jwks = await deps.loadJwks();
      reply
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
        .header('Content-Type', 'application/jwk-set+json; charset=utf-8');
      return jwks;
    },
  );
}
