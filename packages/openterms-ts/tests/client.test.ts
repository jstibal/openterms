// IngestClient unit tests — exercise the surface against a real local HTTP
// server. Mirrors packages/openterms-py/tests/test_client.py so behavioral
// parity between the Python and TS clients is enforceable by reading both files
// side by side.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

import { IngestClient, IngestError } from "../src/index.js";
import { publicKeyToJwk } from "../src/sign.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface Harness {
  baseUrl: string;
  server: Server;
  seed: Uint8Array;
  jwks: { keys: Record<string, string>[] };
  requests: RecordedRequest[];
  setCannedResponse(status: number, body: unknown): void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function startHarness(): Promise<Harness> {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seed[i] = (i * 13 + 5) & 0xff;
  const pub = ed.getPublicKey(seed);
  const jwks = { keys: [publicKeyToJwk(pub, "test-key")] };
  const requests: RecordedRequest[] = [];
  let canned: { status: number; body: unknown } | null = null;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(jwks));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/receipts/ingest") {
        const raw = await readBody(req);
        const body = JSON.parse(raw);
        requests.push({ headers: req.headers, body });
        if (canned) {
          res.statusCode = canned.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(canned.body));
          return;
        }
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            hash: body.canonical_hash,
            ingested_at: "2026-05-20T00:00:00.000Z",
            duplicate: false,
            receipt: body,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    seed,
    jwks,
    requests,
    setCannedResponse(status, body) {
      canned = { status, body };
    },
  };
}

function makeClient(
  h: Harness,
  overrides: Partial<ConstructorParameters<typeof IngestClient>[0]> = {},
): IngestClient {
  return new IngestClient({
    baseUrl: h.baseUrl,
    workspaceId: "11111111-1111-1111-1111-111111111111",
    keyId: "test-key",
    privateKey: h.seed,
    agentId: "agent-001",
    ...overrides,
  });
}

describe("IngestClient", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it("signs and posts a receipt", async () => {
    const client = makeClient(h);
    const result = await client.emitReceipt({
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "a".repeat(64),
      actionContext: { tool_id: "search" },
    });
    expect(result.status).toBe(201);
    expect(result.canonicalHash).toHaveLength(64);
    const sent = h.requests.at(-1)!.body;
    for (const k of [
      "workspace_id",
      "agent_id",
      "action_type",
      "terms_url",
      "terms_hash",
      "timestamp",
      "pricing_version",
      "receipt_id",
      "amount_charged",
      "created_at",
      "canonical_hash",
      "signature",
      "key_id",
    ]) {
      expect(sent[k]).toBeDefined();
    }
    expect(sent.action_context).toEqual({ tool_id: "search" });
    // Signature verifies against the JWKS.
    const verifyResult = await client.verify(sent, h.jwks as never);
    expect(verifyResult.valid).toBe(true);
  });

  it("passes idempotency key header", async () => {
    const client = makeClient(h);
    await client.emitReceipt({
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "b".repeat(64),
      idempotencyKey: "my-key-123",
    });
    expect(h.requests.at(-1)!.headers["idempotency-key"]).toBe("my-key-123");
  });

  it("packs post_state_hash into action_context for post-action receipts", async () => {
    const client = makeClient(h);
    const rid = "22222222-2222-4222-8222-222222222222";
    await client.emitPostActionReceipt({
      receiptId: rid,
      postStateHash: "c".repeat(64),
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "d".repeat(64),
    });
    const sent = h.requests.at(-1)!.body;
    expect(sent.receipt_id).toBe(rid);
    expect(
      (sent.action_context as Record<string, unknown>).post_state_hash,
    ).toBe("c".repeat(64));
  });

  it("passes through ORS v0.2 optional fields", async () => {
    const client = makeClient(h);
    await client.emitReceipt({
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "e".repeat(64),
      extra: {
        terms_type: "saas",
        terms_service: "example",
        terms_version: "2025-05-01",
      },
    });
    const sent = h.requests.at(-1)!.body;
    expect(sent.terms_type).toBe("saas");
    expect(sent.terms_service).toBe("example");
    expect(sent.terms_version).toBe("2025-05-01");
    const result = await client.verify(sent, h.jwks as never);
    expect(result.valid).toBe(true);
  });

  it("raises IngestError on HTTP failure", async () => {
    h.setCannedResponse(400, { code: "VALIDATION_ERROR", message: "nope" });
    const client = makeClient(h);
    await expect(
      client.emitReceipt({
        actionType: "tool_call",
        termsUrl: "https://example.com/terms",
        termsHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      name: "IngestError",
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("fetches JWKS and verifies a sent receipt", async () => {
    const client = makeClient(h, {
      jwksUrl: `${h.baseUrl}/.well-known/jwks.json`,
    });
    const jwks = await client.fetchJwks();
    expect(jwks.keys).toHaveLength(1);
    await client.emitReceipt({
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "0".repeat(64),
    });
    const sent = h.requests.at(-1)!.body;
    const result = await client.verify(sent);
    expect(result.valid).toBe(true);
  });

  it("verifies with an in-memory JWKS", async () => {
    const client = makeClient(h, { jwks: h.jwks as never });
    await client.emitReceipt({
      actionType: "tool_call",
      termsUrl: "https://example.com/terms",
      termsHash: "1".repeat(64),
    });
    const sent = h.requests.at(-1)!.body;
    expect((await client.verify(sent)).valid).toBe(true);
  });

  it("throws if agentId is not configured", async () => {
    const client = makeClient(h, { agentId: undefined });
    await expect(
      client.emitReceipt({
        actionType: "tool_call",
        termsUrl: "https://example.com/terms",
        termsHash: "2".repeat(64),
      }),
    ).rejects.toThrow(/agentId/);
  });

  // The verify error type matches what the Python SDK exposes —
  // verify.test.ts in apps/api covers the underlying verifyReceipt
  // behavior, so we don't re-test all six error codes here.
  it("exposes a non-null IngestError", () => {
    const e = new IngestError("boom", { status: 500, code: "X" });
    expect(e.message).toBe("boom");
    expect(e.status).toBe(500);
    expect(e.code).toBe("X");
  });
});
