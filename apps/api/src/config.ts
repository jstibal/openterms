import type { Policy } from '@openterms/sdk';

export interface AppConfig {
  databaseUrl: string;
  jwksSource: string;
  workspaceId: string;
  port: number;
  logLevel: string;
  nodeEnv: 'production' | 'development' | 'test';
  apiKeySalt: string;
  // When true (non-production and no bearer token presented), the auth
  // plugin falls back to `workspaceId` so the existing local dev flow
  // continues to work without an API key. Always false in production.
  allowDevWorkspaceFallback: boolean;
  // CORS allowlist. For staging this is '*'; for production it should be a
  // comma-separated list of origins or '*' if we explicitly keep it open.
  corsOrigin: string;
  // Rate-limit knobs (per minute).
  rateLimitAuthIngest: number;
  rateLimitAuthQuery: number;
  rateLimitPublicPerIp: number;
}

// Fail fast at boot. Missing required env vars produce a single error log
// that names which vars are missing — never the values of vars that ARE set.
// This is the only function in the service that reads process.env directly.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const isProd = nodeEnv === 'production';

  const required: Record<string, string | undefined> = {
    DATABASE_URL: env.DATABASE_URL,
    JWKS_SOURCE: env.JWKS_SOURCE,
    WORKSPACE_ID: env.WORKSPACE_ID,
    API_KEY_SALT: env.API_KEY_SALT,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `See DEPLOYMENT.md for the full list.`,
    );
  }

  return {
    databaseUrl: required.DATABASE_URL!,
    jwksSource: required.JWKS_SOURCE!,
    workspaceId: required.WORKSPACE_ID!,
    apiKeySalt: required.API_KEY_SALT!,
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    nodeEnv,
    allowDevWorkspaceFallback: !isProd && env.DISABLE_DEV_AUTH_FALLBACK !== '1',
    corsOrigin: env.CORS_ORIGIN ?? '*',
    rateLimitAuthIngest: Number(env.RATE_LIMIT_AUTH_INGEST ?? 600),
    rateLimitAuthQuery: Number(env.RATE_LIMIT_AUTH_QUERY ?? 120),
    rateLimitPublicPerIp: Number(env.RATE_LIMIT_PUBLIC_PER_IP ?? 60),
  };
}

// Hardcoded active policy for this session. A future step will load policies
// from a per-workspace table or a control-plane API; for now the engine has a
// single fixed policy so the ingest path can evaluate-and-store decisions
// without taking on policy management as part of the same change. The rules
// below are deliberately wide: any well-formed receipt with a known
// action_type lands an `allow` decision unless the amount exceeds
// MAX_AMOUNT_DEFAULT, in which case the engine returns `deny`.
export const MAX_AMOUNT_DEFAULT = 10_000_000;

export function getActivePolicy(_config: AppConfig): Policy {
  return {
    version: 'session-test-policy-v1',
    rules: [
      {
        id: 'action_type_allowlist',
        type: 'action_type_allowlist',
        outcome: 'deny',
        parameters: {
          allowed: ['api_call', 'data_access', 'purchase', 'custom', 'model_training'],
        },
      },
      {
        id: 'max_amount_default',
        type: 'max_amount',
        outcome: 'deny',
        parameters: { threshold: MAX_AMOUNT_DEFAULT },
      },
    ],
  };
}
