// Idempotent seed for the staging test workspace + API key.
//
// Reads WORKSPACE_ID and TEST_API_KEY from the environment. If either is
// missing, exits 0 with a notice — it must be safe to invoke before the
// secrets are populated (the operator wires them up on the first deploy
// and the next restart re-runs the seed).
//
// Two entry points:
//   - `seedTestWorkspace()` is called from server startup in production;
//     it leaves the pool open so the server can keep using it.
//   - CLI (`node apps/api/dist/scripts/seed-test-workspace.js`) wraps it
//     and closes the pool when done.
//
// Re-running is safe:
//   - workspaces row uses INSERT ... ON CONFLICT DO NOTHING
//   - api_keys row uses INSERT ... ON CONFLICT (key_hash) DO NOTHING

import { closePool, getPool } from '../db/client.js';
import { createApiKey, ensureWorkspace } from '../db/api_keys.js';

export async function seedTestWorkspace(): Promise<void> {
  const workspaceId = process.env.WORKSPACE_ID;
  const testApiKey = process.env.TEST_API_KEY;
  const salt = process.env.API_KEY_SALT;

  if (!workspaceId || !testApiKey || !salt) {
    const missing = [
      !workspaceId && 'WORKSPACE_ID',
      !testApiKey && 'TEST_API_KEY',
      !salt && 'API_KEY_SALT',
    ].filter(Boolean);
    console.log(
      `[seed] skipping — missing env: ${missing.join(', ')}. ` +
        `Populate these in the Render dashboard and re-run.`,
    );
    return;
  }

  const pool = getPool();
  await ensureWorkspace(pool, workspaceId, 'staging-test-workspace');
  const result = await createApiKey(pool, salt, {
    workspaceId,
    env: testApiKey.startsWith('ot_test_') ? 'test' : 'live',
    token: testApiKey,
  });
  console.log(
    `[seed] workspace=${workspaceId} api_key_id=${result.id} ` +
      `prefix=${result.prefix} (idempotent)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedTestWorkspace()
    .then(() => closePool())
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
