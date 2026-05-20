import { readFile } from 'node:fs/promises';

import type { Jwks } from '../core/verify.js';

// JWKS source loader. Scheme-prefixed string:
//   file:<path>         Re-read on every call. Suitable for dev and tests
//                       where the JWKS may change during the run.
//   memory:<json>       Inline JWKS as URL-encoded JSON. Tests only.
//
// HTTP fetching is deliberately not implemented yet — production wiring lands
// with the JWKS-publication step (BUILD_BRIEF Step 6).

export type JwksLoader = () => Promise<Jwks>;

export function makeJwksLoader(source: string): JwksLoader {
  if (source.startsWith('file:')) {
    const filePath = source.slice('file:'.length);
    return async () => {
      const text = await readFile(filePath, 'utf8');
      return JSON.parse(text) as Jwks;
    };
  }
  if (source.startsWith('memory:')) {
    const encoded = source.slice('memory:'.length);
    const decoded = decodeURIComponent(encoded);
    const parsed = JSON.parse(decoded) as Jwks;
    return async () => parsed;
  }
  throw new Error(`Unsupported JWKS source scheme: ${source}`);
}
