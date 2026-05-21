// Bearer-token authentication for the API.
//
// Behavior:
//   - On every request, look for `Authorization: Bearer <token>`.
//   - Token must start with `ot_live_` or `ot_test_`. Anything else → 401.
//   - HMAC the token under API_KEY_SALT, look up api_keys.key_hash.
//   - Attach the workspace_id to `request.workspaceId` for downstream
//     handlers; they read this instead of `config.workspaceId`.
//   - Routes opt out with `config: { public: true }` (see registerPublicRoute
//     below for the wrapper).
//
// Dev fallback:
//   - When `allowDevWorkspaceFallback` is true (non-production) and no
//     Authorization header is present, the request is allowed and
//     `workspaceId` falls back to `config.workspaceId`. This preserves the
//     existing local-dev / vitest flow that has no API key infrastructure.
//   - In production this fallback is OFF and missing/invalid tokens always
//     return 401. The config.ts loader enforces this — NODE_ENV=production
//     forces allowDevWorkspaceFallback=false.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { lookupApiKey, touchLastUsed } from '../db/api_keys.js';
import { errorBody } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    workspaceId?: string;
    apiKeyId?: string;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

interface Deps {
  pool: Pool;
  config: AppConfig;
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export async function registerBearerAuth(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  app.addHook(
    'onRequest',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const routeConfig = (req.routeOptions?.config ?? {}) as { public?: boolean };
      if (routeConfig.public) return;

      const header = req.headers.authorization;
      if (!header) {
        if (deps.config.allowDevWorkspaceFallback) {
          req.workspaceId = deps.config.workspaceId;
          return;
        }
        reply
          .status(401)
          .header('WWW-Authenticate', 'Bearer realm="openterms"')
          .send(errorBody('UNAUTHORIZED', 'Missing Authorization: Bearer header.'));
        return reply;
      }

      const match = BEARER_RE.exec(header);
      if (!match) {
        reply
          .status(401)
          .header('WWW-Authenticate', 'Bearer realm="openterms"')
          .send(
            errorBody(
              'INVALID_TOKEN',
              'Authorization header must be of the form "Bearer <token>".',
            ),
          );
        return reply;
      }

      const token = match[1]!;
      try {
        const row = await lookupApiKey(deps.pool, token, deps.config.apiKeySalt);
        if (!row) {
          reply
            .status(401)
            .header('WWW-Authenticate', 'Bearer realm="openterms"')
            .send(errorBody('INVALID_TOKEN', 'API key is not recognized.'));
          return reply;
        }
        if (row.revokedAt) {
          reply
            .status(401)
            .header('WWW-Authenticate', 'Bearer realm="openterms"')
            .send(errorBody('REVOKED', 'API key has been revoked.'));
          return reply;
        }
        req.workspaceId = row.workspaceId;
        req.apiKeyId = row.id;
        // Best-effort write of last_used_at — failure must not block the
        // request. We don't await on the critical path beyond a few ms.
        touchLastUsed(deps.pool, row.id).catch((err) => {
          req.log.warn({ err }, 'failed to update api_keys.last_used_at');
        });
      } catch (err) {
        req.log.error({ err }, 'auth lookup failed');
        reply
          .status(500)
          .send(errorBody('INTERNAL_ERROR', 'Failed to verify credentials.'));
        return reply;
      }
    },
  );
}

// Helper for route registrations that should be public (no auth). Marks the
// route's config so the onRequest hook short-circuits.
export const PUBLIC_ROUTE = { config: { public: true } } as const;
