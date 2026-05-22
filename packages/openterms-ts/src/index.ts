// Public surface of @openterms-ai/sdk.
//
// Re-exports the ORS v0.1 canonicalization, signing, verification, and policy
// evaluation modules previously housed inside apps/api/src/core. The API
// service imports from this package; downstream agent SDKs (LangChain, CrewAI
// adapters) also depend on it.

export {
  CanonicalizationError,
  DOMAIN_SEPARATOR,
  PAYLOAD_KEYS_OPTIONAL,
  PAYLOAD_KEYS_REQUIRED,
  PAYLOAD_KEYS_SIGNED_ENVELOPE,
  SIGNATURE_METADATA_KEYS,
  buildPayload,
  canonicalHash,
  canonicalString,
  canonicalize,
  signingInput,
  stripNulls,
} from "./canonical.js";

export { signReceipt, type SignedReceipt } from "./sign.js";

export {
  verifyReceipt,
  type Jwks,
  type Jwk,
  type VerifyError,
  type VerifyResult,
} from "./verify.js";

export { evaluate, evaluateWithContext } from "./policy.js";
export {
  policyFromDict,
  type Decision,
  type DecisionOutcome,
  type EvalContext,
  type Policy,
  type Rule,
} from "./policy_types.js";

export { IngestClient, IngestError, type IngestResponse } from "./client.js";
