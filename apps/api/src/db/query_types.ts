// Shared enum types used across the query layer and the route parsers.

export type DecisionOutcome = 'allow' | 'deny' | 'escalate';

export type ReceiptActionType =
  | 'api_call'
  | 'data_access'
  | 'purchase'
  | 'custom'
  | 'model_training';

export type AggregateMode =
  | 'none'
  | 'count_by_decision'
  | 'count_by_rule'
  | 'count_by_tool'
  | 'count_by_agent'
  | 'count_by_hour'
  | 'count_by_day';

export interface AggregateBucket {
  key: string;
  count: number;
}

export interface Filters {
  agent_id?: string;
  action_type?: ReceiptActionType;
  tool_id?: string;
  decision?: DecisionOutcome;
  triggered_rule?: string;
  chain_id?: string;
  issuer?: string;
  policy_version?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface ParsedCursor {
  t: string;
  i: string;
}

export function encodeCursor(c: ParsedCursor): string {
  const json = JSON.stringify({ t: c.t, i: c.i });
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(raw: string): ParsedCursor | null {
  try {
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.t !== 'string' || typeof o.i !== 'string') return null;
    if (!o.t || !o.i) return null;
    const d = new Date(o.t);
    if (Number.isNaN(d.getTime())) return null;
    return { t: d.toISOString(), i: o.i };
  } catch {
    return null;
  }
}
