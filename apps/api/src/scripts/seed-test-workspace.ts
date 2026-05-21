// Idempotent seed for the staging test workspace + API key.
//
// Reads WORKSPACE_ID and TEST_API_KEY from the environment. If either is
// missing, the script exits 0 with a notice — it must be safe to invoke
// from preDeployCommand even before the secrets are populated (the
// operator wires them up on the first deploy and re-runs the seed).
//
// Run via:
//   node apps/api/dist/scripts/seed-test-workspace.js
//
// Re-running is safe:
//   - workspaces row uses INSERT ... ON CONFLICT DO NOTHING
//   - api_keys row uses INSERT ... ON CONFLICT (key_hash) DO NOTHING
// Rotating the key = generate a new TEST_API_KEY value, redeploy. The
// prior key remains valid until you mark it revoked manually.

import { closePool, getPool } from '../db/client.js';
import { createApiKey, ensureWorkspace } from '../db/api_keys.js';

async function main(): Promise<void> {
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
  try {
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
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
