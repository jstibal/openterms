// ORS v0.1 canonicalization — TypeScript port of packages/openterms-py/openterms/canonical.py.
//
// Behavior parity is enforced by the shared vectors at
// tests/vectors/ors-v0.1/canonicalization.json (the canonical-parity test reads
// the exact same file the Python suite reads).
//
// Cross-language sort note: this implementation sorts object keys by the
// default JavaScript string comparator, which compares UTF-16 code units.
// Python's json.dumps(sort_keys=True) sorts by Unicode code point. The two
// orderings agree for any key whose characters are entirely within the Basic
// Multilingual Plane (U+0000 - U+FFFF). Supplementary-plane keys would sort
// differently across languages and silently produce divergent canonical
// output, so canonicalize() rejects them explicitly (see assertBmpKey).
//
// Numeric handling is also strict: floats, NaN, Infinity, and integers
// outside Number.MAX_SAFE_INTEGER cannot round-trip identically between
// Python and JavaScript, so they are rejected at canonicalization time
// rather than silently emitted as divergent bytes.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export const DOMAIN_SEPARATOR = new Uint8Array([
  0x4f, 0x52, 0x53, 0x76, 0x30, 0x2e, 0x31, 0x00,
]);
// ASCII "ORSv0.1" + 0x00 = 8 bytes. Sanity: matches b"ORSv0.1\x00" in canonical.py.

export const PAYLOAD_KEYS_REQUIRED = [
  "workspace_id",
  "agent_id",
  "action_type",
  "terms_url",
  "terms_hash",
  "timestamp",
  "pricing_version",
] as const;

export const PAYLOAD_KEYS_SIGNED_ENVELOPE = [
  "receipt_id",
  "amount_charged",
  "created_at",
] as const;

export const PAYLOAD_KEYS_OPTIONAL = [
  "action_context",
  "ors_version",
  "issuer",
  "provider",
  "decision",
  "request_binding",
] as const;

export const SIGNATURE_METADATA_KEYS = [
  "canonical_hash",
  "signature",
  "key_id",
] as const;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function assertBmpKey(key: string): void {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    // Surrogate pair => supplementary-plane code point (U+10000+).
    if (code >= 0xd800 && code <= 0xdbff) {
      throw new CanonicalizationError(
        `Object key contains a non-BMP (supplementary-plane) character; not supported by ORS v0.1 canonicalization: ${JSON.stringify(key)}`,
      );
    }
  }
}

export function stripNulls(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

// RFC 8785 JSON Canonicalization Scheme, applied to a payload that has already
// been null-stripped. Matches json.dumps(sort_keys=True, separators=(",", ":"),
// ensure_ascii=False, allow_nan=False) in canonical.py.
function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new CanonicalizationError("NaN is not a valid canonical value");
    }
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        "Infinity is not a valid canonical value",
      );
    }
    if (!Number.isInteger(value)) {
      // Floats cannot round-trip identically between Python's repr() and
      // JavaScript's Number.prototype.toString in all cases. Reject rather
      // than emit divergent bytes. Negative zero falls under this branch
      // (it is not Number.isInteger) and is also rejected.
      throw new CanonicalizationError(
        `Float values are not allowed in ORS v0.1 canonical receipts (got ${value})`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        `Integer ${value} exceeds Number.MAX_SAFE_INTEGER; encode as a string instead`,
      );
    }
    return value.toString(10);
  }
  if (typeof value === "string") {
    // JSON.stringify produces RFC 8259-compliant escaping. JCS (RFC 8785)
    // additionally requires that non-ASCII characters appear literally, not
    // as \uXXXX escapes. JSON.stringify in Node escapes only the mandatory
    // control characters and quote/backslash, leaving the rest literal, which
    // matches Python's ensure_ascii=False. Verified by vectors 8 and 11.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalSerialize(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      assertBmpKey(k);
      parts.push(JSON.stringify(k) + ":" + canonicalSerialize(obj[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

export function canonicalize(payload: unknown): Uint8Array {
  const cleaned = stripNulls(payload);
  const str = canonicalSerialize(cleaned);
  return new TextEncoder().encode(str);
}

export function canonicalString(payload: unknown): string {
  return canonicalSerialize(stripNulls(payload));
}

export function canonicalHash(payload: unknown): string {
  return bytesToHex(sha256(canonicalize(payload)));
}

export function signingInput(payload: unknown): Uint8Array {
  const digest = sha256(canonicalize(payload));
  const out = new Uint8Array(DOMAIN_SEPARATOR.length + digest.length);
  out.set(DOMAIN_SEPARATOR, 0);
  out.set(digest, DOMAIN_SEPARATOR.length);
  return out;
}

export function buildPayload(
  receipt: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const k of PAYLOAD_KEYS_REQUIRED) {
    if (!(k in receipt)) {
      throw new Error(`Missing required payload field: ${k}`);
    }
    payload[k] = receipt[k] as JsonValue;
  }
  for (const k of PAYLOAD_KEYS_SIGNED_ENVELOPE) {
    if (!(k in receipt)) {
      throw new Error(`Missing required signed envelope field: ${k}`);
    }
    payload[k] = receipt[k] as JsonValue;
  }
  for (const k of PAYLOAD_KEYS_OPTIONAL) {
    if (k in receipt && receipt[k] !== null && receipt[k] !== undefined) {
      payload[k] = receipt[k] as JsonValue;
    }
  }
  // v0.2 optional signed fields — pass through if present.
  for (const k of ["terms_type", "terms_service", "terms_version"] as const) {
    if (k in receipt && receipt[k] !== null && receipt[k] !== undefined) {
      payload[k] = receipt[k] as JsonValue;
    }
  }
  return payload;
}
