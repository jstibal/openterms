// ORS v0.1 verification — TypeScript port of
// packages/openterms-py/openterms/verification.py.
//
// Behavior parity:
//   - The six error codes (HASH_MISMATCH, KEY_NOT_FOUND, UNSUPPORTED_KEY_TYPE,
//     INVALID_KEY_LENGTH, INVALID_SIGNATURE_LENGTH, INVALID_SIGNATURE) match
//     the Python reference exactly.
//   - Error precedence: hash → key lookup → kty/crv → key length → sig length
//     → signature verify. Identical to verification.py:43-90.
//   - INVALID_KEY_LENGTH / INVALID_SIGNATURE_LENGTH are returned as VerifyResult
//     errors, not thrown — matches the Python module's deliberate divergence
//     from the spec's raise-style pseudocode so all six are testable through
//     the same surface.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as ed from "@noble/ed25519";

import { DOMAIN_SEPARATOR, buildPayload, canonicalize } from "./canonical.js";

// @noble/ed25519 v2 requires a SHA-512 implementation to be supplied for the
// synchronous API. Pull it from @noble/hashes.
import { sha512 } from "@noble/hashes/sha2";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export type VerifyError =
  | "HASH_MISMATCH"
  | "KEY_NOT_FOUND"
  | "UNSUPPORTED_KEY_TYPE"
  | "INVALID_KEY_LENGTH"
  | "INVALID_SIGNATURE_LENGTH"
  | "INVALID_SIGNATURE";

export interface VerifyResult {
  valid: boolean;
  error: VerifyError | null;
  keyId: string | null;
  canonicalHash: string | null;
}

export interface Jwk {
  kty?: string;
  crv?: string;
  kid?: string;
  x?: string;
  use?: string;
}

export interface Jwks {
  keys: Jwk[];
}

function fail(
  error: VerifyError,
  keyId: string | null,
  hash: string | null,
): VerifyResult {
  return { valid: false, error, keyId, canonicalHash: hash };
}

function b64urlDecode(s: string): Uint8Array {
  // Convert base64url (RFC 4648 §5, no padding) to standard base64, then decode.
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  // Reject non-base64 characters explicitly so length errors aren't masked.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(std)) {
    throw new Error("invalid base64url");
  }
  const bin = Buffer.from(std, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

export function verifyReceipt(
  receipt: Record<string, unknown>,
  jwks: Jwks,
): VerifyResult {
  for (const k of ["canonical_hash", "signature", "key_id"] as const) {
    if (!(k in receipt)) {
      throw new Error(`Missing required signature metadata field: ${k}`);
    }
  }
  const keyId = receipt.key_id as string;
  const claimedHash = receipt.canonical_hash as string;

  const payload = buildPayload(receipt as Record<string, never>);
  const canonicalBytes = canonicalize(payload);
  const hashBytes = sha256(canonicalBytes);
  const hashHex = bytesToHex(hashBytes);

  if (hashHex !== claimedHash) {
    return fail("HASH_MISMATCH", keyId, hashHex);
  }

  const jwk = (jwks.keys ?? []).find((k) => k.kid === keyId);
  if (!jwk) {
    return fail("KEY_NOT_FOUND", keyId, hashHex);
  }

  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    return fail("UNSUPPORTED_KEY_TYPE", keyId, hashHex);
  }

  let pubBytes: Uint8Array;
  try {
    if (!jwk.x) return fail("INVALID_KEY_LENGTH", keyId, hashHex);
    pubBytes = b64urlDecode(jwk.x);
  } catch {
    return fail("INVALID_KEY_LENGTH", keyId, hashHex);
  }
  if (pubBytes.length !== 32) {
    return fail("INVALID_KEY_LENGTH", keyId, hashHex);
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(receipt.signature as string);
  } catch {
    return fail("INVALID_SIGNATURE_LENGTH", keyId, hashHex);
  }
  if (sigBytes.length !== 64) {
    return fail("INVALID_SIGNATURE_LENGTH", keyId, hashHex);
  }

  const message = new Uint8Array(DOMAIN_SEPARATOR.length + hashBytes.length);
  message.set(DOMAIN_SEPARATOR, 0);
  message.set(hashBytes, DOMAIN_SEPARATOR.length);

  let ok = false;
  try {
    ok = ed.verify(sigBytes, message, pubBytes);
  } catch {
    return fail("INVALID_SIGNATURE", keyId, hashHex);
  }
  if (!ok) {
    return fail("INVALID_SIGNATURE", keyId, hashHex);
  }

  return { valid: true, error: null, keyId, canonicalHash: hashHex };
}
