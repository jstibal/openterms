// Ed25519 signing — TypeScript port of packages/openterms-py/openterms/signing.py.
//
// Produces a signed receipt by appending the Section 3c metadata
// (canonical_hash, signature, key_id) to a Section 3a + 3b payload.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import {
  PAYLOAD_KEYS_OPTIONAL,
  PAYLOAD_KEYS_REQUIRED,
  PAYLOAD_KEYS_SIGNED_ENVELOPE,
  SIGNATURE_METADATA_KEYS,
  canonicalHash,
  signingInput,
} from './canonical.js';

// @noble/ed25519 v2 needs a SHA-512 implementation injected for the sync API.
// Idempotent across modules — the assignment is a no-op if another module
// already wired it up (e.g. verify.ts).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const SIGNED_KEYS = new Set<string>([
  ...PAYLOAD_KEYS_REQUIRED,
  ...PAYLOAD_KEYS_SIGNED_ENVELOPE,
  ...PAYLOAD_KEYS_OPTIONAL,
  // v0.2 optional signed fields — accepted as pass-through, same as
  // canonical.ts buildPayload.
  'terms_type',
  'terms_service',
  'terms_version',
]);
const METADATA_KEYS = new Set<string>(SIGNATURE_METADATA_KEYS);

export interface SignedReceipt {
  [k: string]: unknown;
  canonical_hash: string;
  signature: string;
  key_id: string;
}

function b64url(bytes: Uint8Array): string {
  // Node's Buffer.toString('base64') is fine here; @noble/hashes does not
  // ship a base64url helper. This matches the encoding used in
  // packages/openterms-py/openterms/_b64.py.
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function coerceSeed(privateKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array)) {
    throw new TypeError('private_key must be a Uint8Array (32-byte Ed25519 seed)');
  }
  if (privateKey.length !== 32) {
    throw new Error(`Ed25519 private key seed must be 32 bytes, got ${privateKey.length}`);
  }
  return privateKey;
}

export function signReceipt(
  payload: Record<string, unknown>,
  privateKey: Uint8Array,
  keyId: string,
): SignedReceipt {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('payload must be an object');
  }
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new Error('keyId must be a non-empty string');
  }

  const leaked = Object.keys(payload).filter((k) => METADATA_KEYS.has(k));
  if (leaked.length > 0) {
    throw new Error(
      `payload must not contain signature metadata keys: ${JSON.stringify(leaked.sort())}`,
    );
  }
  const unknown = Object.keys(payload).filter((k) => !SIGNED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`payload contains unknown keys: ${JSON.stringify(unknown.sort())}`);
  }

  const seed = coerceSeed(privateKey);
  const sig = ed.sign(signingInput(payload), seed);

  return {
    ...payload,
    canonical_hash: canonicalHash(payload),
    signature: b64url(sig),
    key_id: keyId,
  };
}

export function publicKeyToJwk(publicKey: Uint8Array, kid: string): Record<string, string> {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: b64url(publicKey),
    kid,
    use: 'sig',
  };
}

export function generateSeed(rng: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32))): Uint8Array {
  return rng();
}

// Re-exported for callers that want to feed signingInput / canonicalHash directly.
export { canonicalHash, signingInput, bytesToHex };
