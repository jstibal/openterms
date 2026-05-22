import type { VerifyError } from '@openterms-ai/sdk';

export type IngestErrorCode =
  | 'VALIDATION_ERROR'
  | 'HASH_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'UNKNOWN_ISSUER'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'INVALID_TOKEN'
  | 'REVOKED'
  | 'INTERNAL_ERROR';

// Map the internal six-code verifier vocabulary to the API-surface vocabulary
// from openapi.yaml. KEY_NOT_FOUND, UNSUPPORTED_KEY_TYPE, and INVALID_KEY_LENGTH
// all collapse to UNKNOWN_ISSUER: from the client's perspective the JWKS does
// not yield a usable key for this receipt's key_id, regardless of why. The
// distinction is preserved in the response details for operator debugging.
export function mapVerifyError(e: VerifyError): { code: IngestErrorCode; httpStatus: number } {
  switch (e) {
    case 'HASH_MISMATCH':
      return { code: 'HASH_MISMATCH', httpStatus: 422 };
    case 'KEY_NOT_FOUND':
    case 'UNSUPPORTED_KEY_TYPE':
    case 'INVALID_KEY_LENGTH':
      return { code: 'UNKNOWN_ISSUER', httpStatus: 422 };
    case 'INVALID_SIGNATURE_LENGTH':
    case 'INVALID_SIGNATURE':
      return { code: 'SIGNATURE_INVALID', httpStatus: 422 };
  }
}

export interface ErrorBody {
  error: {
    code: IngestErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function errorBody(
  code: IngestErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
