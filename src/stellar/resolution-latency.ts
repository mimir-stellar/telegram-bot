import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey, type DedupableEvent } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";

export const RESOLUTION_LATENCY_CHECKPOINT_FORMAT = "mimir-resolution-latency-checkpoint-v1";
export const RESOLUTION_LATENCY_CHECKPOINT_VERSION = 1;
export const DEFAULT_MAX_PENDING_CLAIMS = 10000;

export interface LatencyDuration {
  seconds: number;
  ledgers: number;
}

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

export interface ClaimEventState {
  at: number;
  ledger: number;
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

export interface ResolutionLatencyReport {
  resolved: LatencyGroup;
  cancelled: LatencyGroup;
  excludedCount: number;
  /** Optional versioned bounded checkpoint state representing this latency tracker, resumable for future pages. */
  checkpoint?: ResolutionLatencyCheckpoint;
  /** Events skipped because they were already accounted for in a resumed checkpoint or earlier page. */
  resumedDuplicates?: number;
}

export class ResolutionLatencyCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionLatencyCheckpointError";
  }
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

export function serializeResolutionLatencyCheckpoint(checkpoint: ResolutionLatencyCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export function deserializeResolutionLatencyCheckpoint(json: string): ResolutionLatencyCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ResolutionLatencyCheckpointError(
      `Malformed JSON in resolution latency checkpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResolutionLatencyCheckpointError("Resolution latency checkpoint must be a JSON object");
  }

  const cp = parsed as Partial<ResolutionLatencyCheckpoint>;
  if (cp.format !== RESOLUTION_LATENCY_CHECKPOINT_FORMAT || cp.version !== RESOLUTION_LATENCY_CHECKPOINT_VERSION) {
    throw new ResolutionLatencyCheckpointError(
      `Incompatible resolution latency checkpoint format or version (expected ${RESOLUTION_LATENCY_CHECKPOINT_FORMAT} v${RESOLUTION_LATENCY_CHECKPOINT_VERSION}, got format=${String(cp.format)} version=${String(cp.version)})`,
    );
  }

  const parseEntries = (entries: unknown): [number, ClaimEventState][] => {
    if (!Array.isArray(entries)) return [];
    const valid: [number, ClaimEventState][] = [];
    for (const item of entries) {
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === "number" && item[1] && typeof item[1] === "object") {
        valid.push([
          item[0],
          {
            at: Number((item[1] as ClaimEventState).at ?? 0),
            ledger: Number((item[1] as ClaimEventState).ledger ?? 0),
          },
        ]);
      }
    }
    return valid;
  };

  return {
    format: RESOLUTION_LATENCY_CHECKPOINT_FORMAT,
    version: RESOLUTION_LATENCY_CHECKPOINT_VERSION,
    updatedAt: typeof cp.updatedAt === "string" ? cp.updatedAt : new Date().toISOString(),
    processedEvents: typeof cp.processedEvents === "number" ? Math.max(0, cp.processedEvents) : 0,
    creations: parseEntries(cp.creations),
    resolutions: parseEntries(cp.resolutions),
    cancellations: parseEntries(cp.cancellations),
    recentEventIds: Array.isArray(cp.recentEventIds)
      ? cp.recentEventIds.filter((id): id is string => typeof id === "string")
      : [],
    lastProcessedEventId: typeof cp.lastProcessedEventId === "string" ? cp.lastProcessedEventId : null,
    dedupCapacity: typeof cp.dedupCapacity === "number" ? cp.dedupCapacity : DEFAULT_DEDUP_WINDOW,
    maxPendingClaims: typeof cp.maxPendingClaims === "number" ? cp.maxPendingClaims : DEFAULT_MAX_PENDING_CLAIMS,
  };
}

export async function saveResolutionLatencyCheckpoint(
  filePath: string,
  checkpoint: ResolutionLatencyCheckpoint,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, serializeResolutionLatencyCheckpoint(checkpoint), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

export async function loadResolutionLatencyCheckpoint(
  filePath: string,
): Promise<ResolutionLatencyCheckpoint | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ResolutionLatencyCheckpointError(
      `Cannot read resolution latency checkpoint file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return deserializeResolutionLatencyCheckpoint(content);
  } catch (err) {
    if (err instanceof ResolutionLatencyCheckpointError) {
      throw new ResolutionLatencyCheckpointError(`In checkpoint file "${filePath}": ${err.message}`);
    }
    throw err;
  }
}

/**
 * Incremental, checkpointable reducer for claim resolution latencies.
 *
 * Supports page-by-page feeding during long-running scans with a bounded
 * deduplication window so overlapping replay pages do not double-count events.
 */
export class ResolutionLatencyReducer {
  readonly dedupCapacity: number;
  readonly maxPendingClaims: number;
  private readonly dedup: EventDedupWindow;
  private readonly checkpointDedup = new Set<string>();
  private readonly isResuming: boolean;
  private readonly enableDedup: boolean;
  private creations = new Map<number, ClaimEventState>();
  private resolutions = new Map<number, ClaimEventState>();
  private cancellations = new Map<number, ClaimEventState>();
  private processedEvents = 0;
  private resumedDuplicates = 0;
  private lastProcessedEventId: string | null = null;
  private readonly hadInitialCheckpoint: boolean;

  constructor(options?: ResolutionLatencyOptions) {
    this.dedupCapacity = options?.dedupCapacity ?? DEFAULT_DEDUP_WINDOW;
    this.maxPendingClaims = options?.maxPendingClaims ?? DEFAULT_MAX_PENDING_CLAIMS;
    this.dedup = new EventDedupWindow(this.dedupCapacity);
    this.hadInitialCheckpoint = Boolean(options?.checkpoint);
    this.isResuming = Boolean(options?.checkpoint);
    this.enableDedup = options?.dedup ?? this.isResuming;

    if (options?.checkpoint) {
      this.restoreCheckpoint(options.checkpoint);
    }
  }

  private restoreCheckpoint(cp: ResolutionLatencyCheckpoint): void {
    if (cp.format !== RESOLUTION_LATENCY_CHECKPOINT_FORMAT || cp.version !== RESOLUTION_LATENCY_CHECKPOINT_VERSION) {
      throw new ResolutionLatencyCheckpointError(
        `Incompatible resolution latency checkpoint format or version (expected ${RESOLUTION_LATENCY_CHECKPOINT_FORMAT} v${RESOLUTION_LATENCY_CHECKPOINT_VERSION})`,
      );
    }

    this.processedEvents = cp.processedEvents;
    this.lastProcessedEventId = cp.lastProcessedEventId ?? null;
    this.creations = new Map(cp.creations);
    this.resolutions = new Map(cp.resolutions);
    this.cancellations = new Map(cp.cancellations);

    if (Array.isArray(cp.recentEventIds)) {
      for (const id of cp.recentEventIds) {
        if (typeof id === "string" && id !== "") {
          this.dedup.add(id);
          this.checkpointDedup.add(id);
        }
      }
    }
  }

  get stats(): { processedEvents: number; resumedDuplicates: number; trackedClaims: number } {
    return {
      processedEvents: this.processedEvents,
      resumedDuplicates: this.resumedDuplicates,
      trackedClaims: this.creations.size + this.resolutions.size + this.cancellations.size,
    };
  }

  addEvent(event: DecodedEvent): boolean {
    if (!event || typeof event !== "object") {
      return false;
    }

    const key = eventKey(event as DedupableEvent);
    if (key !== null) {
      if (this.isResuming && (this.checkpointDedup.has(key) || (this.lastProcessedEventId !== null && key === this.lastProcessedEventId))) {
        this.resumedDuplicates++;
        return false;
      }
      if (this.enableDedup && this.dedup.has(key)) {
        this.resumedDuplicates++;
        return false;
      }
    }

    this.processedEvents++;
    if (key !== null) {
      this.dedup.add(key);
      this.lastProcessedEventId = key;
    }

    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object" || !("name" in payload) || !("claimId" in payload)) {
      return true;
    }

    const claimId = (payload as { claimId?: unknown }).claimId;
    if (typeof claimId !== "number" || !Number.isFinite(claimId)) {
      return true;
    }

    const payloadName = (payload as { name?: unknown }).name;
    const at = Math.trunc(Number((event as { at?: unknown }).at ?? 0));
    const ledger = Math.trunc(Number((event as { ledger?: unknown }).ledger ?? 0));

    if (payloadName === "claim_created") {
      const existing = this.creations.get(claimId);
      if (!existing || ledger < existing.ledger || (ledger === existing.ledger && at < existing.at)) {
        this.creations.set(claimId, { at, ledger });
      }
    } else if (payloadName === "claim_resolved") {
      const existing = this.resolutions.get(claimId);
      if (!existing || ledger < existing.ledger || (ledger === existing.ledger && at < existing.at)) {
        this.resolutions.set(claimId, { at, ledger });
      }
    } else if (payloadName === "claim_cancelled") {
      const existing = this.cancellations.get(claimId);
      if (!existing || ledger < existing.ledger || (ledger === existing.ledger && at < existing.at)) {
        this.cancellations.set(claimId, { at, ledger });
      }
    }

    // Bounded check for creations
    if (this.creations.size > this.maxPendingClaims) {
      const oldestKeys = Array.from(this.creations.keys()).slice(0, this.creations.size - this.maxPendingClaims);
      for (const k of oldestKeys) {
        this.creations.delete(k);
      }
    }

    return true;
  }

  addEvents(events: readonly DecodedEvent[] | null | undefined): {
    processed: number;
    duplicates: number;
  } {
    if (!events || !Array.isArray(events)) {
      return { processed: 0, duplicates: 0 };
    }
    const prevProcessed = this.processedEvents;
    const prevDuplicates = this.resumedDuplicates;

    for (const ev of events) {
      this.addEvent(ev);
    }

    return {
      processed: this.processedEvents - prevProcessed,
      duplicates: this.resumedDuplicates - prevDuplicates,
    };
  }

  toCheckpoint(): ResolutionLatencyCheckpoint {
    return {
      format: RESOLUTION_LATENCY_CHECKPOINT_FORMAT,
      version: RESOLUTION_LATENCY_CHECKPOINT_VERSION,
      updatedAt: new Date().toISOString(),
      processedEvents: this.processedEvents,
      creations: Array.from(this.creations.entries()).sort((a, b) => a[0] - b[0]),
      resolutions: Array.from(this.resolutions.entries()).sort((a, b) => a[0] - b[0]),
      cancellations: Array.from(this.cancellations.entries()).sort((a, b) => a[0] - b[0]),
      recentEventIds: this.dedup.toJSON(),
      lastProcessedEventId: this.lastProcessedEventId,
      dedupCapacity: this.dedupCapacity,
      maxPendingClaims: this.maxPendingClaims,
    };
  }

  toReport(options?: { includeCheckpoint?: boolean }): ResolutionLatencyReport {
    const allClaimIds = new Set<number>([
      ...this.creations.keys(),
      ...this.resolutions.keys(),
      ...this.cancellations.keys(),
    ]);

    const resolvedClaims: ClaimLatency[] = [];
    const cancelledClaims: ClaimLatency[] = [];
    let excludedCount = 0;

    for (const claimId of allClaimIds) {
      const creation = this.creations.get(claimId);
      const resolution = this.resolutions.get(claimId);
      const cancellation = this.cancellations.get(claimId);

      if (!creation) {
        excludedCount++;
        continue;
      }

      let endEvent: ClaimEventState | null = null;
      let endType: "resolved" | "cancelled" | null = null;

      if (resolution && cancellation) {
        if (
          resolution.ledger < cancellation.ledger ||
          (resolution.ledger === cancellation.ledger && resolution.at <= cancellation.at)
        ) {
          endEvent = resolution;
          endType = "resolved";
        } else {
          endEvent = cancellation;
          endType = "cancelled";
        }
      } else if (resolution) {
        endEvent = resolution;
        endType = "resolved";
      } else if (cancellation) {
        endEvent = cancellation;
        endType = "cancelled";
      }

      if (!endEvent || !endType) {
        excludedCount++;
        continue;
      }

      const durationSec = Math.max(0, Math.trunc(endEvent.at - creation.at));
      const durationLedgers = Math.max(0, Math.trunc(endEvent.ledger - creation.ledger));

      const claimLatency: ClaimLatency = {
        claimId,
        creationLedger: creation.ledger,
        creationAt: creation.at,
        resolutionLedger: endEvent.ledger,
        resolutionAt: endEvent.at,
        duration: {
          seconds: durationSec,
          ledgers: durationLedgers,
        },
      };

      if (endType === "resolved") {
        resolvedClaims.push(claimLatency);
      } else {
        cancelledClaims.push(claimLatency);
      }
    }

    resolvedClaims.sort((a, b) => a.claimId - b.claimId);
    cancelledClaims.sort((a, b) => a.claimId - b.claimId);

    const baseReport: ResolutionLatencyReport = {
      resolved: {
        claims: resolvedClaims,
        summary: computeSummary(resolvedClaims),
      },
      cancelled: {
        claims: cancelledClaims,
        summary: computeSummary(cancelledClaims),
      },
      excludedCount,
    };

    if (options?.includeCheckpoint || this.hadInitialCheckpoint) {
      baseReport.checkpoint = this.toCheckpoint();
      baseReport.resumedDuplicates = this.resumedDuplicates;
    }

    return baseReport;
  }

  static fromCheckpoint(
    checkpoint: ResolutionLatencyCheckpoint,
    options?: Partial<ResolutionLatencyOptions>,
  ): ResolutionLatencyReducer {
    return new ResolutionLatencyReducer({
      checkpoint,
      dedupCapacity: options?.dedupCapacity ?? checkpoint.dedupCapacity,
      maxPendingClaims: options?.maxPendingClaims ?? checkpoint.maxPendingClaims,
      includeCheckpoint: options?.includeCheckpoint,
    });
  }
}

/**
 * Computes durations from creation to resolution/cancellation per claim.
 *
 * Excludes claims missing either creation or resolution/cancellation event.
 * If multiple creation or resolution events exist for the same claimId, deterministic
 * earliest creation and earliest resolution/cancellation are used.
 *
 * If a `checkpoint` is passed via `options`, reduces incrementally starting from the
 * checkpoint state and drops overlapping replay events seen in `recentEventIds`.
 *
 * Uses integer math only.
 */
export function resolutionLatency(
  events: readonly DecodedEvent[],
  options?: ResolutionLatencyOptions,
): ResolutionLatencyReport {
  const reducer = new ResolutionLatencyReducer(options);
  if (events && Array.isArray(events)) {
    reducer.addEvents(events);
  }
  return reducer.toReport({ includeCheckpoint: options?.includeCheckpoint });
}
