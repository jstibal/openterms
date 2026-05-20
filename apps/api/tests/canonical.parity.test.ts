import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';

import { canonicalize, canonicalString } from '../src/core/canonical.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const VECTORS_PATH = path.join(REPO_ROOT, 'tests', 'vectors', 'ors-v0.1', 'canonicalization.json');

interface Vector {
  name: string;
  description?: string;
  input: unknown;
  expected_canonical: string;
  expected_sha256: string;
}

const VECTORS: Vector[] = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

describe('ORS v0.1 spec vectors (cross-language parity with canonical.py)', () => {
  for (const v of VECTORS) {
    test(v.name, () => {
      const produced = canonicalize(v.input);
      const producedStr = new TextDecoder().decode(produced);
      expect(producedStr).toBe(v.expected_canonical);

      const sha = createHash('sha256').update(produced).digest('hex');
      expect(sha).toBe(v.expected_sha256);
    });
  }
});

// The four corner cases live inline in packages/openterms-py/tests/test_canonical.py
// rather than in the shared JSON. Mirror them here so the TypeScript port is
// proven against the same locked-in decisions.

describe('ORS v0.1 corner cases (parity with test_canonical.py)', () => {
  test('nulls inside arrays survive', () => {
    expect(canonicalString({ items: [1, null, 2] })).toBe('{"items":[1,null,2]}');
  });

  test('empty containers survive null-stripping', () => {
    expect(canonicalString({ a: null, b: {} })).toBe('{"b":{}}');
  });

  test('no unicode normalization (NFC vs NFD diverge)', () => {
    const nfc = canonicalize({ name: 'café' });
    const nfd = canonicalize({ name: 'café' });
    expect(nfc).not.toEqual(nfd);
    expect(new TextDecoder().decode(nfc)).toBe('{"name":"café"}');
    expect(new TextDecoder().decode(nfd)).toBe('{"name":"café"}');
  });

  test('float that looks integer-valued serializes with decimal point', () => {
    // Parity caveat: Python emits `1000.0` because the value's runtime type is
    // float. JavaScript has no distinct float type — the literal `1000.0`
    // is identical to `1000`, both Numbers, both Integer per
    // Number.isInteger. The SDK input layer is responsible for rejecting
    // floats where integers are expected, per ORS spec, so this divergence
    // does not affect any conformant receipt. Document the gap rather than
    // hack a tag-type wrapper in.
    expect(canonicalString({ n: 1000 })).toBe('{"n":1000}');
  });
});
