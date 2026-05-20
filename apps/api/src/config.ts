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
