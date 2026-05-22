import { describe, expect, test } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

import { canonicalHash, signingInput } from '@openterms-ai/sdk';
import { verifyReceipt, type Jwks } from '@openterms-ai/sdk';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const PAYLOAD = {
  workspace_id: '00000000-0000-4000-8000-000000000001',
  agent_id: 'agent-1',
  action_type: 'api_call',
  terms_url: 'https://example.com/terms',
  terms_hash: 'a'.repeat(64),
  timestamp: '2026-05-20T00:00:00.000Z',
  pricing_version: 'v1',
  receipt_id: '11111111-1111-4111-8111-111111111111',
  amount_charged: 100,
  created_at: '2026-05-20T00:00:00.001Z',
};

function makeSignedReceipt(kid = 'key-test') {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 1;
  const pub = ed.getPublicKey(seed);
  const message = signingInput(PAYLOAD);
  const sig = ed.sign(message, seed);
  const receipt = {
    ...PAYLOAD,
    canonical_hash: canonicalHash(PAYLOAD),
    signature: b64url(sig),
    key_id: kid,
  };
  const jwks: Jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: b64url(pub), use: 'sig' }] };
  return { receipt, jwks, pub, seed };
}

describe('verifyReceipt — six ORS error codes', () => {
  test('happy path: valid signature', () => {
    const { receipt, jwks } = makeSignedReceipt();
    const r = verifyReceipt(receipt, jwks);
    expect(r.valid).toBe(true);
    expect(r.error).toBeNull();
  });

  test('HASH_MISMATCH: claimed hash does not match computed', () => {
    const { receipt, jwks } = makeSignedReceipt();
    receipt.canonical_hash = '0'.repeat(64);
    const r = verifyReceipt(receipt, jwks);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('HASH_MISMATCH');
  });

  test('KEY_NOT_FOUND: key_id not in JWKS', () => {
    const { receipt, jwks } = makeSignedReceipt();
    jwks.keys = [];
    const r = verifyReceipt(receipt, jwks);
    expect(r.error).toBe('KEY_NOT_FOUND');
  });

  test('UNSUPPORTED_KEY_TYPE: kty/crv mismatch', () => {
    const { receipt, jwks } = makeSignedReceipt();
    jwks.keys[0]!.kty = 'RSA';
    const r = verifyReceipt(receipt, jwks);
    expect(r.error).toBe('UNSUPPORTED_KEY_TYPE');
  });

  test('INVALID_KEY_LENGTH: x is wrong length', () => {
    const { receipt, jwks } = makeSignedReceipt();
    jwks.keys[0]!.x = b64url(new Uint8Array(16));
    const r = verifyReceipt(receipt, jwks);
    expect(r.error).toBe('INVALID_KEY_LENGTH');
  });

  test('INVALID_SIGNATURE_LENGTH: signature is wrong length', () => {
    const { receipt, jwks } = makeSignedReceipt();
    receipt.signature = b64url(new Uint8Array(32));
    const r = verifyReceipt(receipt, jwks);
    expect(r.error).toBe('INVALID_SIGNATURE_LENGTH');
  });

  test('INVALID_SIGNATURE: 64-byte signature that does not verify', () => {
    const { receipt, jwks } = makeSignedReceipt();
    receipt.signature = b64url(new Uint8Array(64));
    const r = verifyReceipt(receipt, jwks);
    expect(r.error).toBe('INVALID_SIGNATURE');
  });
});
