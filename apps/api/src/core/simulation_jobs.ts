// Async simulation job store — stubbed in-memory implementation.
//
// The OpenAPI spec describes a 202 Accepted + GET /v1/simulate/{job_id}
// polling lifecycle for corpora larger than the sync threshold. In this
// build the sync threshold is 10,000 receipts and the fixture corpus is 500,
// so the async path is never reached. We keep the store as a stub so:
//
//   1. The GET endpoint has a single, intentional source for "no such job"
//      (always 404 in this session; not a logic bug).
//   2. When async lands later, the call sites in routes/simulate.ts already
//      thread through this module's surface area.
//
// Determinism note (in response to the call-out about Map iteration order
// drift): nothing in this build iterates the map. createJob / getJob are
// keyed lookups, and listJobs is intentionally not implemented yet. If a
// future PR adds listJobs it must sort explicitly — do not rely on Map
// insertion order being stable across processes.

import type { SimulationResult } from './simulation.js';

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface SimulationJob {
  job_id: string;
  status: JobStatus;
  result: SimulationResult | null;
  error: { code: string; message: string } | null;
}

const JOBS = new Map<string, SimulationJob>();

export function getJob(jobId: string): SimulationJob | null {
  return JOBS.get(jobId) ?? null;
}

// Reserved for the async wiring. Unused in this session — the sync path
// returns the SimulationResult directly without touching the store. Kept
// here so future async work has the obvious landing pad.
export function putJob(job: SimulationJob): void {
  JOBS.set(job.job_id, job);
}

// Test-only escape hatch. Production code must not call this.
export function _resetJobsForTests(): void {
  JOBS.clear();
}
