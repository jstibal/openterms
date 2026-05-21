// Cross-language parity for the deterministic policy engine.
//
// Each fixture under packages/openterms-py/tests/fixtures/policy/ describes a
// (policy, receipt, [aggregates], [force_timeout], expected) tuple. The Python
// reference asserts that fixtures pass when (a) the decision matches, (b) the
// triggered_rules array matches in order, and (c) each expected reason is a
// substring (by index) of the actual reason string. This test mirrors that
// contract on the TypeScript side — the two implementations agree iff they
// both pass the same fixture corpus.
//
// Reasons are matched as substrings, not byte-equal strings, to keep fixtures
// stable against minor wording changes while still pinning the structured
// uppercase prefix and the value substrings that downstream dashboards group
// by. See packages/openterms-py/tests/test_policy_integration.py:395-398.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluate, evaluateWithContext } from '@openterms/sdk';
import type { EvalContext } from '@openterms/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'openterms-py',
  'tests',
  'fixtures',
  'policy',
);

interface FixtureCase {
  name: string;
  policy: Record<string, unknown>;
  receipt: Record<string, unknown>;
  aggregates?: Record<string, number>;
  force_timeout?: boolean;
  expected: {
    decision: 'allow' | 'deny' | 'escalate';
    triggered_rules: string[];
    reasons: string[];
  };
}

function loadFixtures(): Array<{ file: string; case: FixtureCase }> {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => ({
    file: f,
    case: JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as FixtureCase,
  }));
}

const FIXTURES = loadFixtures();

describe('policy parity against the shared fixture corpus', () => {
  it('locates 14 fixtures (matches the Python suite acceptance bar)', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(14);
  });

  for (const { file, case: c } of FIXTURES) {
    it(file, () => {
      const d = c.force_timeout
        ? evaluateWithContext(c.receipt, c.policy, {
            aggregates: { ...(c.aggregates ?? {}) },
            deadlineMonotonic: 0,
            evaluatedAt: null,
          } satisfies EvalContext)
        : evaluate(c.receipt, c.policy, {
            aggregates: c.aggregates,
            // Tests assert rule logic, not timing. Disable the per-evaluation
            // budget so coverage instrumentation or a slow CI box cannot
            // perturb the asserted decision. Mirrors the Python _eval helper.
            budgetSeconds: 0,
          });

      expect(d.decision, `${file}: decision`).toBe(c.expected.decision);
      expect(d.triggered_rules, `${file}: triggered_rules`).toEqual(c.expected.triggered_rules);
      expect(d.reasons.length, `${file}: reasons length`).toBe(c.expected.reasons.length);
      for (let i = 0; i < c.expected.reasons.length; i += 1) {
        expect(
          d.reasons[i]!.includes(c.expected.reasons[i]!),
          `${file}: reasons[${i}] '${d.reasons[i]}' must contain '${c.expected.reasons[i]}'`,
        ).toBe(true);
      }
    });
  }
});
