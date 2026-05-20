# OpenTerms fixture corpus

500 signed ORS receipts plus their decisions under a demo policy. The corpus
exists so the Python SDK, the TypeScript API, and the future Polsia dashboard
can be exercised against realistic data without each consumer having to
fabricate its own.

## Files

| File | Purpose |
| --- | --- |
| `scenario.json` | Input config: seed, counts, bucket sizes, time window, agents, tools, URLs. |
| `policy_v1.json` | Demo policy used to compute every entry in `decisions.json`. Contains all 10 rule types. |
| `policy_v2.json` | Candidate policy used by the simulation oracle. Differs from v1 in two known ways. |
| `receipts.json` | 500 signed receipts, sorted by `created_at` ascending. |
| `decisions.json` | One decision per receipt, in lockstep order, keyed by `receipt_hash`. |
| `jwks.json` | Two-key JWKS (`ot-corpus-2026a` active, `ot-corpus-2025z` retired @ 5%). |
| `simulation_expected_diffs.json` | Receipts whose decision or triggered rules change between `policy_v1` and `policy_v2`. |
| `manifest.json` | Counts, distributions, scenario hash, `openterms` module tree SHA at generation time. |

## Regenerating

From the repo root:

```sh
python3 packages/openterms-py/scripts/generate_corpus.py
```

The generator is fully deterministic — running it twice produces byte-identical
files. The pytest suite includes a `--check` mode invocation that fails CI if
the committed files do not match a fresh generation. If that check fails, you
have changed something (engine behaviour, generator logic, scenario inputs)
that affects the corpus output and must regenerate explicitly.

## Loading the corpus

### Python

```python
import json
from pathlib import Path

corpus = Path("tests/fixtures/corpus")
receipts = json.loads((corpus / "receipts.json").read_text())
decisions = json.loads((corpus / "decisions.json").read_text())
jwks = json.loads((corpus / "jwks.json").read_text())
```

See [`packages/openterms-py/tests/test_corpus.py`](../../../packages/openterms-py/tests/test_corpus.py)
for verification and reproducibility patterns.

### TypeScript

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const corpus = resolve('tests/fixtures/corpus');
const receipts = JSON.parse(readFileSync(resolve(corpus, 'receipts.json'), 'utf8'));
```

See [`apps/api/tests/corpus.test.ts`](../../../apps/api/tests/corpus.test.ts)
for an end-to-end ingest + query example against a real Postgres.

### Dashboard (future)

The corpus is plain JSON. The dashboard can `fetch()` `receipts.json` from its
dev server or copy the files into its `public/` directory at build time.

## Coverage

The corpus exercises:

- All 5 ORS action types (`api_call`, `data_access`, `purchase`, `custom`, `model_training`).
- All 10 policy rule types in `policy_v1`, each firing on ≥10 receipts.
- Decision outcomes roughly 70 % `allow` / 20 % `deny` / 10 % `escalate`, within ±5 %.
- Receipts with and without `action_context.ors.commitments`, with and without `chain` membership, with and without `provider`, `request_binding`, and `ors_version`.
- Receipts that fire 0, 1, 2, and 3+ rules (the `stress` bucket triggers four rules at once).
- Multi-key JWKS resolution: 5 % of receipts are signed with the retired key.
- A `simulation_expected_diffs.json` oracle so the simulation endpoint (planned
  next session) has a known counterfactual against `policy_v2`.

## Caveats

- **Single workspace**: every receipt uses the workspace ID
  `9b8c2a48-2f9a-4d3b-a3a3-3e0c1c1a8d31`. This is a v1 simplification; multi-
  workspace coverage will land when policies become per-workspace.
- **API ingest decisions ≠ corpus decisions**: when the corpus is ingested
  through `apps/api/`, decisions are computed under the API's hardcoded policy
  in [`apps/api/src/config.ts`](../../../apps/api/src/config.ts), not under
  `policy_v1`. The corpus `decisions.json` is the ground truth for the
  reference engine; the integration test verifies the API can ingest and query
  the receipts but does not compare its decisions to `decisions.json`.
- **v0.2 fields not yet signable**: the SDK's signed key allowlist
  (`packages/openterms-py/openterms/canonical.py`) does not include
  `terms_type`, `terms_service`, or `terms_version`. Receipts that mark
  `ors_version: "0.2"` therefore only set the version flag; the v0.2 terms
  fields will be backfilled when the SDK is updated.
- **Determinism vs evolving SDK**: any change to the engine (a new rule, a
  tweaked reason string) will produce different decisions, and the regeneration
  test will surface that on the next PR. Treat fixture churn as a signal that
  output has shifted, not as a regression.
