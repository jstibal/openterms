import type { AppConfig } from '../../src/config.js';

// Shared AppConfig factory for in-process integration tests. Callers
// override the small set of fields the test cares about (databaseUrl,
// workspaceId, jwksSource); the rest get sensible non-production defaults
// so the AppConfig type stays exhaustive without every test needing to
// know about CORS, rate limit, or auth-fallback knobs.
export function testConfig(overrides: Partial<AppConfig> & Pick<AppConfig, 'databaseUrl' | 'workspaceId'>): AppConfig {
  return {
    jwksSource: 'memory:test',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
    apiKeySalt: 'test-salt-not-secret',
    allowDevWorkspaceFallback: true,
    corsOrigin: '*',
    rateLimitAuthIngest: 100000,
    rateLimitAuthQuery: 100000,
    rateLimitPublicPerIp: 100000,
    ...overrides,
  };
}
