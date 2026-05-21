// HTTP ingest client — TypeScript port of
// packages/openterms-py/openterms/client.py.
//
// Builds + signs + POSTs receipts to a configured OpenTerms ingest service.
// Uses the global fetch (Node 18+) to keep the package dependency-free beyond
// the @noble/* crypto packages.

import { buildPayload } from "./canonical.js";
import { signReceipt, type SignedReceipt } from "./sign.js";
import { verifyReceipt, type Jwks, type VerifyResult } from "./verify.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface IngestClientOptions {
  baseUrl: string;
  workspaceId: string;
  keyId: string;
  /** 32-byte Ed25519 seed. */
  privateKey: Uint8Array;
  agentId?: string;
  /** Bearer token placeholder. Sent if set; service does not yet enforce. */
  apiKey?: string;
  /** Pre-built JWKS for the local verify path. */
  jwks?: Jwks;
  /** URL of a /.well-known/jwks.json equivalent for fetchJwks() / verify() fallback. */
  jwksUrl?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional fetch override (for tests). Falls back to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface EmitReceiptOptions {
  actionType: string;
  termsUrl: string;
  termsHash: string;
  actionContext?: Record<string, unknown>;
  pricingVersion?: string;
  amountCharged?: number;
  agentId?: string;
  receiptId?: string;
  timestamp?: string;
  createdAt?: string;
  idempotencyKey?: string;
  /** Optional pass-through fields: ors_version, issuer, terms_type, etc. */
  extra?: Record<string, unknown>;
}

export interface EmitPostActionReceiptOptions {
  receiptId: string;
  postStateHash: string;
  actionType: string;
  termsUrl: string;
  termsHash: string;
  agentId?: string;
  amountCharged?: number;
  pricingVersion?: string;
  timestamp?: string;
  createdAt?: string;
  idempotencyKey?: string;
  extra?: Record<string, unknown>;
}

export interface IngestResponse {
  canonicalHash: string;
  ingestedAt: string;
  duplicate: boolean;
  receipt: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  status: number;
}

export class IngestError extends Error {
  status: number | null;
  body: string | null;
  code: string | null;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      body?: string | null;
      code?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "IngestError";
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
    this.code = opts.code ?? null;
  }
}

function utcNowIso(): string {
  // Match the Python client's format (millisecond + microsecond precision, Z suffix).
  // Use toISOString which gives YYYY-MM-DDTHH:mm:ss.sssZ — sufficient precision
  // for the ingest validator.
  return new Date().toISOString();
}

function randomUuid(): string {
  // Node 19+ and modern browsers expose crypto.randomUUID. Avoids a dependency.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: build a v4 UUID from getRandomValues. Matches RFC 4122 §4.4.
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class IngestClient {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly keyId: string;
  readonly agentId: string | undefined;
  readonly apiKey: string | undefined;
  readonly jwksUrl: string | undefined;
  readonly timeoutMs: number;

  private readonly _privateKey: Uint8Array;
  private _jwks: Jwks | undefined;
  private readonly _fetch: typeof fetch;

  constructor(opts: IngestClientOptions) {
    if (!opts.baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.workspaceId = opts.workspaceId;
    this.keyId = opts.keyId;
    this._privateKey = opts.privateKey;
    this.agentId = opts.agentId;
    this.apiKey = opts.apiKey;
    this._jwks = opts.jwks;
    this.jwksUrl = opts.jwksUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async emitReceipt(opts: EmitReceiptOptions): Promise<IngestResponse> {
    const agent = opts.agentId ?? this.agentId;
    if (!agent) {
      throw new Error("agentId must be provided either at init or per-call");
    }
    const ts = opts.timestamp ?? utcNowIso();
    const receipt: Record<string, unknown> = {
      workspace_id: this.workspaceId,
      agent_id: agent,
      action_type: opts.actionType,
      terms_url: opts.termsUrl,
      terms_hash: opts.termsHash,
      timestamp: ts,
      pricing_version: opts.pricingVersion ?? "v1",
      receipt_id: opts.receiptId ?? randomUuid(),
      amount_charged: opts.amountCharged ?? 0,
      created_at: opts.createdAt ?? ts,
    };
    if (opts.actionContext !== undefined) {
      receipt.action_context = opts.actionContext;
    }
    if (opts.extra) {
      for (const [k, v] of Object.entries(opts.extra)) {
        if (v !== null && v !== undefined) receipt[k] = v;
      }
    }
    const payload = buildPayload(receipt as Record<string, never>);
    const signed = signReceipt(payload, this._privateKey, this.keyId);
    return this._post(signed, opts.idempotencyKey);
  }

  async emitPostActionReceipt(
    opts: EmitPostActionReceiptOptions,
  ): Promise<IngestResponse> {
    const ctx: Record<string, unknown> = {
      post_state_hash: opts.postStateHash,
    };
    let extra = opts.extra;
    if (
      extra &&
      typeof extra.action_context === "object" &&
      extra.action_context !== null
    ) {
      Object.assign(ctx, extra.action_context as Record<string, unknown>, {
        post_state_hash: opts.postStateHash,
      });
      const { action_context: _drop, ...rest } = extra;
      extra = rest;
    }
    return this.emitReceipt({
      actionType: opts.actionType,
      termsUrl: opts.termsUrl,
      termsHash: opts.termsHash,
      actionContext: ctx,
      agentId: opts.agentId,
      amountCharged: opts.amountCharged,
      pricingVersion: opts.pricingVersion,
      receiptId: opts.receiptId,
      timestamp: opts.timestamp,
      createdAt: opts.createdAt,
      idempotencyKey: opts.idempotencyKey,
      extra,
    });
  }

  async fetchJwks(url?: string): Promise<Jwks> {
    const target = url ?? this.jwksUrl;
    if (!target) {
      throw new Error(
        "no jwksUrl configured; pass url= or set jwksUrl at init",
      );
    }
    const res = await this._withTimeout(
      this._fetch(target, { headers: { Accept: "application/json" } }),
    );
    if (!res.ok) {
      throw new IngestError(
        `failed to fetch JWKS from ${target}: HTTP ${res.status}`,
        {
          status: res.status,
        },
      );
    }
    const jwks = (await res.json()) as Jwks;
    this._jwks = jwks;
    return jwks;
  }

  async verify(
    receipt: Record<string, unknown>,
    jwks?: Jwks,
  ): Promise<VerifyResult> {
    let keys = jwks ?? this._jwks;
    if (!keys) {
      if (this.jwksUrl) {
        keys = await this.fetchJwks();
      } else {
        throw new Error(
          "no JWKS available; pass jwks= or configure jwksUrl / jwks at init",
        );
      }
    }
    return verifyReceipt(receipt as Record<string, never>, keys);
  }

  private async _post(
    signed: SignedReceipt,
    idempotencyKey: string | undefined,
  ): Promise<IngestResponse> {
    const url = `${this.baseUrl}/v1/receipts/ingest`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await this._withTimeout(
      this._fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(signed),
      }),
    );
    const text = await res.text();
    if (!res.ok) {
      let code: string | null = null;
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null;
      } catch {
        // ignore — body is not JSON
      }
      throw new IngestError(`ingest failed with HTTP ${res.status}`, {
        status: res.status,
        body: text,
        code,
      });
    }
    const parsed = JSON.parse(text) as {
      hash: string;
      ingested_at: string;
      duplicate?: boolean;
      receipt: Record<string, unknown>;
      decision?: Record<string, unknown>;
    };
    return {
      canonicalHash: parsed.hash,
      ingestedAt: parsed.ingested_at,
      duplicate: parsed.duplicate ?? false,
      receipt: parsed.receipt ?? {},
      decision: parsed.decision ?? null,
      status: res.status,
    };
  }

  private async _withTimeout<T>(p: Promise<T>): Promise<T> {
    // Cheap timeout shim. fetch in Node 18+ supports AbortController, but
    // wrapping with Promise.race keeps the API identical regardless of how
    // the consumer's fetch impl handles aborts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new IngestError(`request exceeded ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
