import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey, type DedupableEvent } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";
import {
  computeCaptureCompleteness,
  type CaptureCompleteness,
  type CaptureCompletenessOptions,
} from "./capture-completeness.js";

export {
  assertCompleteCapture,
  computeCaptureCompleteness,
  IncompleteCaptureError,
  type CaptureCompleteness,
  type CaptureCompletenessOptions,
  type CaptureGap,
  type CaptureGapInput,
  type LedgerRange,
} from "./capture-completeness.js";

export const RESOLUTION_LATENCY_CHECKPOINT_FORMAT = "mimir-resolution-latency-checkpoint-v1";
export const RESOLUTION_LATENCY_CHECKPOINT_VERSION = 1;
export const DEFAULT_MAX_PENDING_CLAIMS = 10000;

export interface LatencyDuration { seconds: number; ledgers: number; }
export interface ClaimLatency {
  claimId: number;
  creationLedger: number;
  creationAt: number;
  resolutionLedger: number;
  resolutionAt: number;
  duration: LatencyDuration;
}
export interface LatencySummary { p50: LatencyDuration; p90: LatencyDuration; max: LatencyDuration; }
export interface LatencyGroup { claims: ClaimLatency[]; summary: LatencySummary | null; }

export interface ResolutionLatencyOptions {
  /**
   * Builds a per-event identity component from a `DecodedEvent`. Defaults to
   * `${contractId}:${source}`, which keeps identical numeric claim IDs from
   * different contracts separate. Include the network when events from more
   * than one network can be mixed in the same call.
   */
  identity?: (event: DecodedEvent) => string;
}

/**
 * Versioned, bounded checkpoint state for claim resolution latency reducers.
 *
 * Persists pending creations, resolutions, and cancellations along with a bounded
 * deduplication window of recent event identifiers to prevent double-counting
 * when resuming across overlapping pagination boundaries.
 */
export interface ResolutionLatencyCheckpoint {
  format: "mimir-resolution-latency-checkpoint-v1";
  version: 1;
  updatedAt: string;
  processedEvents: number;
  creations: [number, ClaimEventState][];
  resolutions: [number, ClaimEventState][];
  cancellations: [number, ClaimEventState][];
  recentEventIds: string[];
  lastProcessedEventId?: string | null;
  dedupCapacity: number;
  maxPendingClaims: number;
}

export interface ResolutionLatencyOptions {
  /** Optional versioned checkpoint from a previous scan to resume from. */
  checkpoint?: ResolutionLatencyCheckpoint | null;
  /** Deduplication window capacity for dropping overlapping events across scan pages (default: 256). */
  dedupCapacity?: number;
  /** Whether to drop duplicate event IDs within and across batches. Defaults to true when resuming from a checkpoint. */
  dedup?: boolean;
  /** Maximum number of pending/unresolved claims to track in memory (default: 10000). */
  maxPendingClaims?: number;
  /** Whether to attach checkpoint state to the returned report. */
  includeCheckpoint?: boolean;
}

export interface ResolutionLatencyOptions extends CaptureCompletenessOptions {}

export interface ResolutionLatencyReport {
  resolved: LatencyGroup;
  cancelled: LatencyGroup;
  excludedCount: number;
  /** Capture completeness metadata including ledger range and gap information. */
  completeness: CaptureCompleteness;
  /** Alias for completeness metadata. */
  capture: CaptureCompleteness;
}

function nearestRank(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index]!;
}

function computeSummary(claims: ClaimLatency[]): LatencySummary | null {
  if (claims.length === 0) return null;
  const sortedSec = claims.map((c) => c.duration.seconds).sort((a, b) => a - b);
  const sortedLed = claims.map((c) => c.duration.ledgers).sort((a, b) => a - b);
  return {
    p50: { seconds: nearestRank(sortedSec, 50), ledgers: nearestRank(sortedLed, 50) },
    p90: { seconds: nearestRank(sortedSec, 90), ledgers: nearestRank(sortedLed, 90) },
    max: { seconds: sortedSec[sortedSec.length - 1]!, ledgers: sortedLed[sortedLed.length - 1]! },
  };
}

function defaultIdentity(event: DecodedEvent): string {
  const contract = typeof event.contractId === "string" ? event.contractId : "";
  const source = typeof event.source === "string" ? event.source : "";
  return `${contract}:${source}`;
}

export function resolutionLatency(
  events: readonly DecodedEvent[],
  options: ResolutionLatencyOptions = {},
): ResolutionLatencyReport {
  const identityOf = options.identity ?? defaultIdentity;

  type EndPoint = { at: number; ledger: number };
  const creations = new Map<string, EndPoint & { claimId: number }>();
  const resolutions = new Map<string, EndPoint & { claimId: number }>();
  const cancellations = new Map<string, EndPoint & { claimId: number }>();

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const payload = event.payload;
    if (!payload || !("name" in payload) || !("claimId" in payload)) continue;
    const claimId = payload.claimId;
    if (typeof claimId !== "number" || !Number.isFinite(claimId)) continue;

    const identityKey = `${identityOf(event as DecodedEvent)}:${claimId}`;
    const point = { at: Math.trunc(event.at), ledger: Math.trunc(event.ledger), claimId };

    const upsert = (map: Map<string, EndPoint & { claimId: number }>) => {
      const existing = map.get(identityKey);
      if (!existing || point.ledger < existing.ledger ||
          (point.ledger === existing.ledger && point.at < existing.at)) {
        map.set(identityKey, point);
      }
    };

    if (payload.name === "claim_created") upsert(creations);
    else if (payload.name === "claim_resolved") upsert(resolutions);
    else if (payload.name === "claim_cancelled") upsert(cancellations);
  }

  const allKeys = new Set<string>([
    ...creations.keys(), ...resolutions.keys(), ...cancellations.keys(),
  ]);

  const resolvedClaims: ClaimLatency[] = [];
  const cancelledClaims: ClaimLatency[] = [];
  let excludedCount = 0;

  for (const key of allKeys) {
    const creation = creations.get(key);
    const resolution = resolutions.get(key);
    const cancellation = cancellations.get(key);

    if (!creation) { excludedCount++; continue; }

    let endEvent: EndPoint | null = null;
    let endType: "resolved" | "cancelled" | null = null;

    if (resolution && cancellation) {
      if (resolution.ledger < cancellation.ledger ||
          (resolution.ledger === cancellation.ledger && resolution.at <= cancellation.at)) {
        endEvent = resolution; endType = "resolved";
      } else { endEvent = cancellation; endType = "cancelled"; }
    } else if (resolution) { endEvent = resolution; endType = "resolved"; }
    else if (cancellation) { endEvent = cancellation; endType = "cancelled"; }

    if (!endEvent || !endType) { excludedCount++; continue; }

    const claimLatency: ClaimLatency = {
      claimId: creation.claimId,
      creationLedger: creation.ledger,
      creationAt: creation.at,
      resolutionLedger: endEvent.ledger,
      resolutionAt: endEvent.at,
      duration: {
        seconds: Math.max(0, Math.trunc(endEvent.at - creation.at)),
        ledgers: Math.max(0, Math.trunc(endEvent.ledger - creation.ledger)),
      },
    };
    (endType === "resolved" ? resolvedClaims : cancelledClaims).push(claimLatency);
  }

  resolvedClaims.sort((a, b) => a.claimId - b.claimId);
  cancelledClaims.sort((a, b) => a.claimId - b.claimId);

  return {
    resolved: { claims: resolvedClaims, summary: computeSummary(resolvedClaims) },
    cancelled: { claims: cancelledClaims, summary: computeSummary(cancelledClaims) },
    excludedCount,
    completeness,
    capture: completeness,
  };
}
