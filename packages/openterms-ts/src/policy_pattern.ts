// Constrained pattern language for args_pattern_match — TypeScript port of
// packages/openterms-py/openterms/policy_pattern.py. No regex, no fnmatch,
// hand-rolled two-pointer glob for bounded linear-time matching.

export const VALID_OPS = [
  "equals",
  "prefix",
  "suffix",
  "contains",
  "glob",
] as const;
export type PatternOp = (typeof VALID_OPS)[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function resolvePath(
  receipt: Record<string, unknown>,
  path: string,
): unknown {
  if (!path) return null;
  let cur: unknown = receipt;
  for (const part of path.split(".")) {
    if (isPlainObject(cur) && part in cur) {
      cur = cur[part];
    } else {
      return null;
    }
  }
  return cur;
}

function globMatch(pattern: string, target: string): boolean {
  let pI = 0;
  let tI = 0;
  let star = -1;
  let match = 0;
  while (tI < target.length) {
    if (pI < pattern.length && pattern[pI] === "*") {
      star = pI;
      match = tI;
      pI += 1;
    } else if (
      pI < pattern.length &&
      (pattern[pI] === "?" || pattern[pI] === target[tI])
    ) {
      pI += 1;
      tI += 1;
    } else if (star !== -1) {
      pI = star + 1;
      match += 1;
      tI = match;
    } else {
      return false;
    }
  }
  while (pI < pattern.length && pattern[pI] === "*") {
    pI += 1;
  }
  return pI === pattern.length;
}

export function matchOne(op: string, value: string, target: unknown): boolean {
  if (!(VALID_OPS as readonly string[]).includes(op)) {
    throw new Error(`Unknown pattern operator: '${op}'`);
  }
  if (target === null || target === undefined) return false;
  const targetStr = typeof target === "string" ? target : String(target);
  switch (op as PatternOp) {
    case "equals":
      return targetStr === value;
    case "prefix":
      return targetStr.startsWith(value);
    case "suffix":
      return targetStr.endsWith(value);
    case "contains":
      return targetStr.includes(value);
    case "glob":
      return globMatch(value, targetStr);
  }
}
