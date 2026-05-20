import type { Policy } from './core/policy_types.js';

export interface AppConfig {
  databaseUrl: string;
  jwksSource: string;
  workspaceId: string;
  port: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const jwksSource = env.JWKS_SOURCE;
  const workspaceId = env.WORKSPACE_ID;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!jwksSource) throw new Error('JWKS_SOURCE is required (file:<path> or memory:<json>)');
  if (!workspaceId) throw new Error('WORKSPACE_ID is required');
  return {
    databaseUrl,
    jwksSource,
    workspaceId,
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
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
