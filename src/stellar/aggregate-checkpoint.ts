import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";
import type {
  ClaimLatency,
  LatencyDuration,
  LatencySummary,
  ResolutionLatencyReport,
} from "./resolution-latency.js";
import {
  floorToBucketUtc,
  type VolumeBucket,
  type VolumeBucketUnit,
  type VolumeSeriesResult,
} from "./volume-series.js";

export const AGGREGATE_CHECKPOINT_SCHEMA_VERSION = 1;

export const DEFAULT_MAX_VOLUME_BUCKETS = 720;
export const DEFAULT_MAX_OPEN_CLAIMS = 2048;
export const DEFAULT_MAX_COMPLETED_CLAIMS = 2048;
export const DEFAULT_CHECKPOINT_DEDUP_WINDOW = Math.max(DEFAULT_DEDUP_WINDOW, 1024);

const MAX_CURSOR_LENGTH = 256;
const FILE_MODE = 0o600;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

export class AggregateCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateCheckpointError";
  }
}

export interface IncrementalAggregatorBounds {
  maxBuckets: number;
  maxOpenClaims: number;
  maxCompletedClaims: number;
  dedupWindow: number;
}

export interface IncrementalAggregatorOptions {
  bucket?: VolumeBucketUnit;
  maxBuckets?: number;
  maxOpenClaims?: number;
  maxCompletedClaims?: number;
  dedupWindow?: number;
}

export interface IngestOptions {
  cursor?: string | null;
}

export interface IngestBatchStats {
  acceptedEvents: number;
  duplicatesSkipped: number;
  skippedWithoutAt: number;
}

export interface SerializedVolumeBucket {
  startAt: number;
  challengeStake: string;
  squadDeposit: string;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

export interface SerializedOpenClaim {
  claimId: number;
  creation: { at: number; ledger: number } | null;
  resolution: { at: number; ledger: number } | null;
  cancellation: { at: number; ledger: number } | null;
}

export interface AggregateCheckpoint {
  schemaVersion: number;
  updatedAt: string;
  bucketUnit: VolumeBucketUnit;
  bounds: IncrementalAggregatorBounds;
  cursor: string | null;
  firstLedger: number | null;
  lastLedger: number | null;
  duplicatesSkipped: number;
  recentEventIds: string[];
  volume: {
    buckets: SerializedVolumeBucket[];
    totalChallengeStake: string;
    totalSquadDeposit: string;
    skippedWithoutAt: number;
    processedEvents: number;
    evictedBuckets: number;
  };
  latency: {
    openClaims: SerializedOpenClaim[];
    resolvedClaims: ClaimLatency[];
    cancelledClaims: ClaimLatency[];
    evictedOpenClaims: number;
    evictedCompletedClaims: number;
  };
}

export interface LoadAggregatorOptions extends IncrementalAggregatorOptions {
  /**
   * When true, a corrupt or incompatible checkpoint file is quarantined to
   * `${filePath}.corrupt.<timestamp>` and a fresh aggregator is returned instead
   * of throwing `AggregateCheckpointError`. Defaults to false.
   */
  quarantineOnCorrupt?: boolean;
}

interface InternalBucket {
  startAt: number;
  challengeStake: bigint;
  squadDeposit: bigint;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

interface InternalOpenClaim {
  claimId: number;
  creation: { at: number; ledger: number } | null;
  resolution: { at: number; ledger: number } | null;
  cancellation: { at: number; ledger: number } | null;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new AggregateCheckpointError(`Expected positive integer bound, got ${String(value)}`);
  }
  return Math.floor(value);
}

function clampNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AggregateCheckpointError(`Expected non-negative integer bound, got ${String(value)}`);
  }
  return Math.floor(value);
}

function parseStrictBigIntString(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AggregateCheckpointError(`Invalid bigint string in '${field}'`);
  }
  return BigInt(value);
}

function assertNonNegSafeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AggregateCheckpointError(`Invalid non-negative integer in '${field}'`);
  }
  return value;
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
    p50: {
      seconds: nearestRank(sortedSec, 50),
      ledgers: nearestRank(sortedLed, 50),
    },
    p90: {
      seconds: nearestRank(sortedSec, 90),
      ledgers: nearestRank(sortedLed, 90),
    },
    max: {
      seconds: sortedSec[sortedSec.length - 1]!,
      ledgers: sortedLed[sortedLed.length - 1]!,
    },
  };
}

function parsePoint(raw: unknown, field: string): { at: number; ledger: number } | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") {
    throw new AggregateCheckpointError(`Invalid point in '${field}'`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    at: assertNonNegSafeInt(obj.at, `${field}.at`),
    ledger: assertNonNegSafeInt(obj.ledger, `${field}.ledger`),
  };
}

function parseCompletedClaim(raw: unknown, field: string): ClaimLatency {
  if (!raw || typeof raw !== "object") {
    throw new AggregateCheckpointError(`Invalid claim latency in '${field}'`);
  }
  const obj = raw as Record<string, unknown>;
  const durRaw = obj.duration;
  if (!durRaw || typeof durRaw !== "object") {
    throw new AggregateCheckpointError(`Invalid claim duration in '${field}.duration'`);
  }
  const durObj = durRaw as Record<string, unknown>;
  const duration: LatencyDuration = {
    seconds: assertNonNegSafeInt(durObj.seconds, `${field}.duration.seconds`),
    ledgers: assertNonNegSafeInt(durObj.ledgers, `${field}.duration.ledgers`),
  };
  return {
    claimId: assertNonNegSafeInt(obj.claimId, `${field}.claimId`),
    creationLedger: assertNonNegSafeInt(obj.creationLedger, `${field}.creationLedger`),
    creationAt: assertNonNegSafeInt(obj.creationAt, `${field}.creationAt`),
    resolutionLedger: assertNonNegSafeInt(obj.resolutionLedger, `${field}.resolutionLedger`),
    resolutionAt: assertNonNegSafeInt(obj.resolutionAt, `${field}.resolutionAt`),
    duration,
  };
}

/**
 * Validate and normalize an untrusted JSON object into a versioned `AggregateCheckpoint`.
 */
export function parseAggregateCheckpoint(input: unknown): AggregateCheckpoint {
  const parsed =
    typeof input === "string"
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch (err) {
            throw new AggregateCheckpointError(
              `Malformed checkpoint JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })()
      : input;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AggregateCheckpointError("Checkpoint root must be a JSON object");
  }

  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== AGGREGATE_CHECKPOINT_SCHEMA_VERSION) {
    throw new AggregateCheckpointError(
      `Unsupported checkpoint schemaVersion: expected ${AGGREGATE_CHECKPOINT_SCHEMA_VERSION}, got ${String(root.schemaVersion)}`,
    );
  }

  const bucketUnit = root.bucketUnit;
  if (bucketUnit !== "hour" && bucketUnit !== "day") {
    throw new AggregateCheckpointError(`Invalid bucketUnit: ${String(bucketUnit)}`);
  }

  if (!root.bounds || typeof root.bounds !== "object") {
    throw new AggregateCheckpointError("Missing 'bounds' object in checkpoint");
  }
  const boundsObj = root.bounds as Record<string, unknown>;
  const bounds: IncrementalAggregatorBounds = {
    maxBuckets: clampPositiveInt(boundsObj.maxBuckets as number, DEFAULT_MAX_VOLUME_BUCKETS),
    maxOpenClaims: clampPositiveInt(boundsObj.maxOpenClaims as number, DEFAULT_MAX_OPEN_CLAIMS),
    maxCompletedClaims: clampPositiveInt(
      boundsObj.maxCompletedClaims as number,
      DEFAULT_MAX_COMPLETED_CLAIMS,
    ),
    dedupWindow: clampNonNegativeInt(
      boundsObj.dedupWindow as number,
      DEFAULT_CHECKPOINT_DEDUP_WINDOW,
    ),
  };

  const cursor =
    root.cursor === null
      ? null
      : typeof root.cursor === "string" && root.cursor.length <= MAX_CURSOR_LENGTH
        ? root.cursor
        : (() => {
            throw new AggregateCheckpointError("Invalid 'cursor' in checkpoint");
          })();

  const firstLedger =
    root.firstLedger === null ? null : assertNonNegSafeInt(root.firstLedger, "firstLedger");
  const lastLedger =
    root.lastLedger === null ? null : assertNonNegSafeInt(root.lastLedger, "lastLedger");
  const duplicatesSkipped = assertNonNegSafeInt(root.duplicatesSkipped, "duplicatesSkipped");

  if (!Array.isArray(root.recentEventIds)) {
    throw new AggregateCheckpointError("Missing 'recentEventIds' array in checkpoint");
  }
  const recentEventIds: string[] = [];
  for (const item of root.recentEventIds) {
    if (typeof item !== "string" || item.length === 0) {
      throw new AggregateCheckpointError("Invalid entry in 'recentEventIds'");
    }
    recentEventIds.push(item);
  }

  if (!root.volume || typeof root.volume !== "object") {
    throw new AggregateCheckpointError("Missing 'volume' state in checkpoint");
  }
  const volObj = root.volume as Record<string, unknown>;
  if (!Array.isArray(volObj.buckets)) {
    throw new AggregateCheckpointError("Missing 'volume.buckets' array in checkpoint");
  }

  const stepSeconds = bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;
  const serializedBuckets: SerializedVolumeBucket[] = volObj.buckets.map((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      throw new AggregateCheckpointError(`Invalid bucket at volume.buckets[${idx}]`);
    }
    const b = raw as Record<string, unknown>;
    const startAt = assertNonNegSafeInt(b.startAt, `volume.buckets[${idx}].startAt`);
    if (startAt % stepSeconds !== 0) {
      throw new AggregateCheckpointError(`Unaligned bucket startAt at volume.buckets[${idx}]`);
    }
    parseStrictBigIntString(b.challengeStake, `volume.buckets[${idx}].challengeStake`);
    parseStrictBigIntString(b.squadDeposit, `volume.buckets[${idx}].squadDeposit`);
    return {
      startAt,
      challengeStake: b.challengeStake as string,
      squadDeposit: b.squadDeposit as string,
      challengeCount: assertNonNegSafeInt(b.challengeCount, `volume.buckets[${idx}].challengeCount`),
      depositCount: assertNonNegSafeInt(b.depositCount, `volume.buckets[${idx}].depositCount`),
      eventCount: assertNonNegSafeInt(b.eventCount, `volume.buckets[${idx}].eventCount`),
    };
  });

  parseStrictBigIntString(volObj.totalChallengeStake, "volume.totalChallengeStake");
  parseStrictBigIntString(volObj.totalSquadDeposit, "volume.totalSquadDeposit");

  if (!root.latency || typeof root.latency !== "object") {
    throw new AggregateCheckpointError("Missing 'latency' state in checkpoint");
  }
  const latObj = root.latency as Record<string, unknown>;
  if (
    !Array.isArray(latObj.openClaims) ||
    !Array.isArray(latObj.resolvedClaims) ||
    !Array.isArray(latObj.cancelledClaims)
  ) {
    throw new AggregateCheckpointError("Missing claim arrays in 'latency' checkpoint state");
  }

  const openClaims: SerializedOpenClaim[] = latObj.openClaims.map((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      throw new AggregateCheckpointError(`Invalid openClaim at latency.openClaims[${idx}]`);
    }
    const o = raw as Record<string, unknown>;
    return {
      claimId: assertNonNegSafeInt(o.claimId, `latency.openClaims[${idx}].claimId`),
      creation: parsePoint(o.creation, `latency.openClaims[${idx}].creation`),
      resolution: parsePoint(o.resolution, `latency.openClaims[${idx}].resolution`),
      cancellation: parsePoint(o.cancellation, `latency.openClaims[${idx}].cancellation`),
    };
  });

  const resolvedClaims = latObj.resolvedClaims.map((raw, idx) =>
    parseCompletedClaim(raw, `latency.resolvedClaims[${idx}]`),
  );
  const cancelledClaims = latObj.cancelledClaims.map((raw, idx) =>
    parseCompletedClaim(raw, `latency.cancelledClaims[${idx}]`),
  );

  return {
    schemaVersion: AGGREGATE_CHECKPOINT_SCHEMA_VERSION,
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : new Date(0).toISOString(),
    bucketUnit,
    bounds,
    cursor,
    firstLedger,
    lastLedger,
    duplicatesSkipped,
    recentEventIds: recentEventIds.slice(-bounds.dedupWindow),
    volume: {
      buckets: serializedBuckets.slice(-bounds.maxBuckets),
      totalChallengeStake: volObj.totalChallengeStake as string,
      totalSquadDeposit: volObj.totalSquadDeposit as string,
      skippedWithoutAt: assertNonNegSafeInt(volObj.skippedWithoutAt, "volume.skippedWithoutAt"),
      processedEvents: assertNonNegSafeInt(volObj.processedEvents, "volume.processedEvents"),
      evictedBuckets: assertNonNegSafeInt(volObj.evictedBuckets, "volume.evictedBuckets"),
    },
    latency: {
      openClaims: openClaims.slice(-bounds.maxOpenClaims),
      resolvedClaims: resolvedClaims.slice(-bounds.maxCompletedClaims),
      cancelledClaims: cancelledClaims.slice(-bounds.maxCompletedClaims),
      evictedOpenClaims: assertNonNegSafeInt(latObj.evictedOpenClaims, "latency.evictedOpenClaims"),
      evictedCompletedClaims: assertNonNegSafeInt(
        latObj.evictedCompletedClaims,
        "latency.evictedCompletedClaims",
      ),
    },
  };
}

export function serializeAggregateCheckpoint(checkpoint: AggregateCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export async function saveAggregateCheckpoint(
  filePath: string,
  checkpoint: AggregateCheckpoint,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = serializeAggregateCheckpoint(checkpoint);
  await writeFile(tmpPath, payload, { encoding: "utf8", mode: FILE_MODE });
  try {
    await chmod(tmpPath, FILE_MODE);
  } catch {
    // Ignore on filesystems without POSIX mode bits
  }
  await rename(tmpPath, filePath);
}

export async function loadAggregateCheckpoint(filePath: string): Promise<AggregateCheckpoint> {
  const raw = await readFile(filePath, "utf8");
  return parseAggregateCheckpoint(raw);
}

/**
 * Incremental, checkpointable reducer for long-running scans that maintains bounded
 * volume-series and resolution-latency state while suppressing overlapping replay pages.
 */
export class IncrementalAggregator {
  readonly bucketUnit: VolumeBucketUnit;
  readonly bounds: IncrementalAggregatorBounds;

  private dedup: EventDedupWindow;
  private cursorValue: string | null = null;
  private firstLedgerValue: number | null = null;
  private lastLedgerValue: number | null = null;
  private duplicatesSkippedCount = 0;

  private readonly bucketMap = new Map<number, InternalBucket>();
  private totalChallengeStake = 0n;
  private totalSquadDeposit = 0n;
  private skippedWithoutAtCount = 0;
  private processedEventsCount = 0;
  private evictedBucketsCount = 0;

  private readonly openClaims = new Map<number, InternalOpenClaim>();
  private readonly completedResolved = new Map<number, ClaimLatency>();
  private readonly completedCancelled = new Map<number, ClaimLatency>();
  private evictedOpenClaimsCount = 0;
  private evictedCompletedClaimsCount = 0;

  constructor(options: IncrementalAggregatorOptions = {}) {
    const unit = options.bucket ?? "hour";
    if (unit !== "hour" && unit !== "day") {
      throw new AggregateCheckpointError(
        `Invalid bucket unit: expected "hour" or "day", got ${String(unit)}`,
      );
    }
    this.bucketUnit = unit;
    this.bounds = {
      maxBuckets: clampPositiveInt(options.maxBuckets, DEFAULT_MAX_VOLUME_BUCKETS),
      maxOpenClaims: clampPositiveInt(options.maxOpenClaims, DEFAULT_MAX_OPEN_CLAIMS),
      maxCompletedClaims: clampPositiveInt(
        options.maxCompletedClaims,
        DEFAULT_MAX_COMPLETED_CLAIMS,
      ),
      dedupWindow: clampNonNegativeInt(options.dedupWindow, DEFAULT_CHECKPOINT_DEDUP_WINDOW),
    };
    this.dedup = new EventDedupWindow(this.bounds.dedupWindow);
  }

  static fromCheckpoint(input: unknown): IncrementalAggregator {
    const cp = parseAggregateCheckpoint(input);
    const agg = new IncrementalAggregator({
      bucket: cp.bucketUnit,
      maxBuckets: cp.bounds.maxBuckets,
      maxOpenClaims: cp.bounds.maxOpenClaims,
      maxCompletedClaims: cp.bounds.maxCompletedClaims,
      dedupWindow: cp.bounds.dedupWindow,
    });

    agg.cursorValue = cp.cursor;
    agg.firstLedgerValue = cp.firstLedger;
    agg.lastLedgerValue = cp.lastLedger;
    agg.duplicatesSkippedCount = cp.duplicatesSkipped;
    agg.dedup = EventDedupWindow.fromJSON(cp.recentEventIds, cp.bounds.dedupWindow);

    agg.totalChallengeStake = BigInt(cp.volume.totalChallengeStake);
    agg.totalSquadDeposit = BigInt(cp.volume.totalSquadDeposit);
    agg.skippedWithoutAtCount = cp.volume.skippedWithoutAt;
    agg.processedEventsCount = cp.volume.processedEvents;
    agg.evictedBucketsCount = cp.volume.evictedBuckets;

    for (const b of cp.volume.buckets) {
      agg.bucketMap.set(b.startAt, {
        startAt: b.startAt,
        challengeStake: BigInt(b.challengeStake),
        squadDeposit: BigInt(b.squadDeposit),
        challengeCount: b.challengeCount,
        depositCount: b.depositCount,
        eventCount: b.eventCount,
      });
    }
    agg.enforceBucketBounds();

    agg.evictedOpenClaimsCount = cp.latency.evictedOpenClaims;
    agg.evictedCompletedClaimsCount = cp.latency.evictedCompletedClaims;
    for (const o of cp.latency.openClaims) {
      agg.openClaims.set(o.claimId, {
        claimId: o.claimId,
        creation: o.creation ? { ...o.creation } : null,
        resolution: o.resolution ? { ...o.resolution } : null,
        cancellation: o.cancellation ? { ...o.cancellation } : null,
      });
    }
    for (const c of cp.latency.resolvedClaims) {
      agg.completedResolved.set(c.claimId, { ...c, duration: { ...c.duration } });
    }
    for (const c of cp.latency.cancelledClaims) {
      agg.completedCancelled.set(c.claimId, { ...c, duration: { ...c.duration } });
    }
    agg.enforceClaimBounds();

    return agg;
  }

  get cursor(): string | null {
    return this.cursorValue;
  }

  get firstLedger(): number | null {
    return this.firstLedgerValue;
  }

  get lastLedger(): number | null {
    return this.lastLedgerValue;
  }

  get duplicatesSkipped(): number {
    return this.duplicatesSkippedCount;
  }

  ingest(
    events: readonly DecodedEvent[] | null | undefined,
    options: IngestOptions = {},
  ): IngestBatchStats {
    let acceptedEvents = 0;
    let duplicatesSkipped = 0;
    let skippedWithoutAt = 0;

    if (Array.isArray(events)) {
      for (const event of events) {
        if (!event || typeof event !== "object") {
          continue;
        }

        const key = eventKey(event);
        if (!this.dedup.add(key)) {
          duplicatesSkipped++;
          this.duplicatesSkippedCount++;
          continue;
        }

        acceptedEvents++;

        if (typeof event.ledger === "number" && Number.isFinite(event.ledger) && event.ledger >= 0) {
          const led = Math.trunc(event.ledger);
          if (this.firstLedgerValue === null || led < this.firstLedgerValue) {
            this.firstLedgerValue = led;
          }
          if (this.lastLedgerValue === null || led > this.lastLedgerValue) {
            this.lastLedgerValue = led;
          }
        }

        if (!this.ingestVolumeEvent(event)) {
          skippedWithoutAt++;
        }
        this.ingestLatencyEvent(event);
      }
    }

    if (options.cursor !== undefined) {
      this.cursorValue =
        options.cursor === null
          ? null
          : String(options.cursor).slice(0, MAX_CURSOR_LENGTH);
    }

    this.enforceBucketBounds();
    this.enforceClaimBounds();

    return {
      acceptedEvents,
      duplicatesSkipped,
      skippedWithoutAt,
    };
  }

  private ingestVolumeEvent(event: DecodedEvent): boolean {
    const at = (event as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      this.skippedWithoutAtCount++;
      return false;
    }

    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      return true;
    }

    const payloadName = (payload as { name?: unknown }).name;
    let challengeStakeDelta = 0n;
    let squadDepositDelta = 0n;
    let isChallenge = false;
    let isDeposit = false;

    if (payloadName === "claim_challenged") {
      const stake = (payload as { stake?: unknown }).stake;
      if (typeof stake === "bigint") {
        challengeStakeDelta = stake;
      } else if (typeof stake === "string" || typeof stake === "number") {
        try {
          challengeStakeDelta = BigInt(stake);
        } catch {
          challengeStakeDelta = 0n;
        }
      }
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amount = (payload as { amount?: unknown }).amount;
      if (typeof amount === "bigint") {
        squadDepositDelta = amount;
      } else if (typeof amount === "string" || typeof amount === "number") {
        try {
          squadDepositDelta = BigInt(amount);
        } catch {
          squadDepositDelta = 0n;
        }
      }
      isDeposit = true;
    }

    this.processedEventsCount++;
    const bucketStart = floorToBucketUtc(Math.floor(at), this.bucketUnit);

    this.totalChallengeStake += challengeStakeDelta;
    this.totalSquadDeposit += squadDepositDelta;

    let bucket = this.bucketMap.get(bucketStart);
    if (!bucket) {
      bucket = {
        startAt: bucketStart,
        challengeStake: 0n,
        squadDeposit: 0n,
        challengeCount: 0,
        depositCount: 0,
        eventCount: 0,
      };
      this.bucketMap.set(bucketStart, bucket);
    }

    bucket.challengeStake += challengeStakeDelta;
    bucket.squadDeposit += squadDepositDelta;
    if (isChallenge) bucket.challengeCount++;
    if (isDeposit) bucket.depositCount++;
    bucket.eventCount++;

    return true;
  }

  private ingestLatencyEvent(event: DecodedEvent): void {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || !("name" in payload) || !("claimId" in payload)) {
      return;
    }

    const claimId = payload.claimId;
    if (typeof claimId !== "number" || !Number.isFinite(claimId) || claimId < 0) {
      return;
    }
    if (
      typeof event.ledger !== "number" ||
      !Number.isFinite(event.ledger) ||
      typeof event.at !== "number" ||
      !Number.isFinite(event.at)
    ) {
      return;
    }

    const name = payload.name;
    if (name !== "claim_created" && name !== "claim_resolved" && name !== "claim_cancelled") {
      return;
    }

    const ledger = Math.trunc(event.ledger);
    const at = Math.trunc(event.at);
    const normalizedId = Math.trunc(claimId);

    // Rehydrate if an earlier arrival already completed this claim and an earlier creation/terminal arrives
    let entry = this.openClaims.get(normalizedId);
    if (!entry) {
      const existingResolved = this.completedResolved.get(normalizedId);
      const existingCancelled = this.completedCancelled.get(normalizedId);
      if (existingResolved) {
        this.completedResolved.delete(normalizedId);
        entry = {
          claimId: normalizedId,
          creation: { at: existingResolved.creationAt, ledger: existingResolved.creationLedger },
          resolution: {
            at: existingResolved.resolutionAt,
            ledger: existingResolved.resolutionLedger,
          },
          cancellation: null,
        };
      } else if (existingCancelled) {
        this.completedCancelled.delete(normalizedId);
        entry = {
          claimId: normalizedId,
          creation: { at: existingCancelled.creationAt, ledger: existingCancelled.creationLedger },
          resolution: null,
          cancellation: {
            at: existingCancelled.resolutionAt,
            ledger: existingCancelled.resolutionLedger,
          },
        };
      } else {
        entry = {
          claimId: normalizedId,
          creation: null,
          resolution: null,
          cancellation: null,
        };
      }
      this.openClaims.set(normalizedId, entry);
    }

    const isEarlier = (
      candLedger: number,
      candAt: number,
      cur: { at: number; ledger: number } | null,
    ): boolean => !cur || candLedger < cur.ledger || (candLedger === cur.ledger && candAt < cur.at);

    if (name === "claim_created" && isEarlier(ledger, at, entry.creation)) {
      entry.creation = { at, ledger };
    } else if (name === "claim_resolved" && isEarlier(ledger, at, entry.resolution)) {
      entry.resolution = { at, ledger };
    } else if (name === "claim_cancelled" && isEarlier(ledger, at, entry.cancellation)) {
      entry.cancellation = { at, ledger };
    }

    if (entry.creation && (entry.resolution || entry.cancellation)) {
      let endEvent: { at: number; ledger: number };
      let endType: "resolved" | "cancelled";

      if (entry.resolution && entry.cancellation) {
        if (
          entry.resolution.ledger < entry.cancellation.ledger ||
          (entry.resolution.ledger === entry.cancellation.ledger &&
            entry.resolution.at <= entry.cancellation.at)
        ) {
          endEvent = entry.resolution;
          endType = "resolved";
        } else {
          endEvent = entry.cancellation;
          endType = "cancelled";
        }
      } else if (entry.resolution) {
        endEvent = entry.resolution;
        endType = "resolved";
      } else {
        endEvent = entry.cancellation!;
        endType = "cancelled";
      }

      const completed: ClaimLatency = {
        claimId: normalizedId,
        creationLedger: entry.creation.ledger,
        creationAt: entry.creation.at,
        resolutionLedger: endEvent.ledger,
        resolutionAt: endEvent.at,
        duration: {
          seconds: Math.max(0, Math.trunc(endEvent.at - entry.creation.at)),
          ledgers: Math.max(0, Math.trunc(endEvent.ledger - entry.creation.ledger)),
        },
      };

      this.openClaims.delete(normalizedId);
      if (endType === "resolved") {
        this.completedResolved.set(normalizedId, completed);
      } else {
        this.completedCancelled.set(normalizedId, completed);
      }
    }
  }

  private enforceBucketBounds(): void {
    if (this.bucketMap.size === 0) return;
    const stepSeconds = this.bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;
    let maxStart = -Infinity;
    for (const startAt of this.bucketMap.keys()) {
      if (startAt > maxStart) maxStart = startAt;
    }

    // Bound contiguous span to at most `maxBuckets` buckets ending at `maxStart`
    const minRetainedStart = maxStart - (this.bounds.maxBuckets - 1) * stepSeconds;
    for (const startAt of [...this.bucketMap.keys()]) {
      if (startAt < minRetainedStart) {
        this.bucketMap.delete(startAt);
        this.evictedBucketsCount++;
      }
    }

    while (this.bucketMap.size > this.bounds.maxBuckets) {
      const oldest = [...this.bucketMap.keys()].sort((a, b) => a - b)[0];
      if (oldest === undefined) break;
      this.bucketMap.delete(oldest);
      this.evictedBucketsCount++;
    }
  }

  private enforceClaimBounds(): void {
    while (this.openClaims.size > this.bounds.maxOpenClaims) {
      const oldestKey = this.openClaims.keys().next().value;
      if (oldestKey === undefined) break;
      this.openClaims.delete(oldestKey);
      this.evictedOpenClaimsCount++;
    }

    while (this.completedResolved.size > this.bounds.maxCompletedClaims) {
      const oldestKey = this.completedResolved.keys().next().value;
      if (oldestKey === undefined) break;
      this.completedResolved.delete(oldestKey);
      this.evictedCompletedClaimsCount++;
    }

    while (this.completedCancelled.size > this.bounds.maxCompletedClaims) {
      const oldestKey = this.completedCancelled.keys().next().value;
      if (oldestKey === undefined) break;
      this.completedCancelled.delete(oldestKey);
      this.evictedCompletedClaimsCount++;
    }
  }

  volumeResult(): VolumeSeriesResult {
    if (this.bucketMap.size === 0) {
      return {
        buckets: [],
        totalChallengeStake: this.totalChallengeStake.toString(),
        totalSquadDeposit: this.totalSquadDeposit.toString(),
        skippedWithoutAt: this.skippedWithoutAtCount,
        processedEvents: this.processedEventsCount,
      };
    }

    const stepSeconds = this.bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;
    const starts = [...this.bucketMap.keys()].sort((a, b) => a - b);
    const minStart = starts[0]!;
    const maxStart = starts[starts.length - 1]!;

    const buckets: VolumeBucket[] = [];
    for (let t = minStart; t <= maxStart; t += stepSeconds) {
      const data = this.bucketMap.get(t);
      const challengeStake = data ? data.challengeStake : 0n;
      const squadDeposit = data ? data.squadDeposit : 0n;
      buckets.push({
        timestamp: new Date(t * 1000).toISOString(),
        startAt: t,
        challengeStakeTotal: challengeStake.toString(),
        squadDepositTotal: squadDeposit.toString(),
        challengeStake,
        squadDeposit,
        challengeCount: data ? data.challengeCount : 0,
        depositCount: data ? data.depositCount : 0,
        eventCount: data ? data.eventCount : 0,
      });
    }

    return {
      buckets,
      totalChallengeStake: this.totalChallengeStake.toString(),
      totalSquadDeposit: this.totalSquadDeposit.toString(),
      skippedWithoutAt: this.skippedWithoutAtCount,
      processedEvents: this.processedEventsCount,
    };
  }

  latencyReport(): ResolutionLatencyReport {
    const resolvedClaims = [...this.completedResolved.values()].sort(
      (a, b) => a.claimId - b.claimId,
    );
    const cancelledClaims = [...this.completedCancelled.values()].sort(
      (a, b) => a.claimId - b.claimId,
    );
    const excludedCount = this.openClaims.size + this.evictedOpenClaimsCount;

    return {
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
  }

  toCheckpoint(nowMs: number = Date.now()): AggregateCheckpoint {
    const sortedBuckets = [...this.bucketMap.values()]
      .sort((a, b) => a.startAt - b.startAt)
      .map((b) => ({
        startAt: b.startAt,
        challengeStake: b.challengeStake.toString(),
        squadDeposit: b.squadDeposit.toString(),
        challengeCount: b.challengeCount,
        depositCount: b.depositCount,
        eventCount: b.eventCount,
      }));

    const openClaims = [...this.openClaims.values()].map((o) => ({
      claimId: o.claimId,
      creation: o.creation ? { ...o.creation } : null,
      resolution: o.resolution ? { ...o.resolution } : null,
      cancellation: o.cancellation ? { ...o.cancellation } : null,
    }));

    const resolvedClaims = [...this.completedResolved.values()].sort(
      (a, b) => a.claimId - b.claimId,
    );
    const cancelledClaims = [...this.completedCancelled.values()].sort(
      (a, b) => a.claimId - b.claimId,
    );

    return {
      schemaVersion: AGGREGATE_CHECKPOINT_SCHEMA_VERSION,
      updatedAt: new Date(nowMs).toISOString(),
      bucketUnit: this.bucketUnit,
      bounds: { ...this.bounds },
      cursor: this.cursorValue,
      firstLedger: this.firstLedgerValue,
      lastLedger: this.lastLedgerValue,
      duplicatesSkipped: this.duplicatesSkippedCount,
      recentEventIds: this.dedup.toJSON(),
      volume: {
        buckets: sortedBuckets,
        totalChallengeStake: this.totalChallengeStake.toString(),
        totalSquadDeposit: this.totalSquadDeposit.toString(),
        skippedWithoutAt: this.skippedWithoutAtCount,
        processedEvents: this.processedEventsCount,
        evictedBuckets: this.evictedBucketsCount,
      },
      latency: {
        openClaims,
        resolvedClaims,
        cancelledClaims,
        evictedOpenClaims: this.evictedOpenClaimsCount,
        evictedCompletedClaims: this.evictedCompletedClaimsCount,
      },
    };
  }

  async save(filePath: string, nowMs: number = Date.now()): Promise<AggregateCheckpoint> {
    const cp = this.toCheckpoint(nowMs);
    await saveAggregateCheckpoint(filePath, cp);
    return cp;
  }
}

export function createIncrementalAggregator(
  options: IncrementalAggregatorOptions = {},
): IncrementalAggregator {
  return new IncrementalAggregator(options);
}

/**
 * Resume an `IncrementalAggregator` from `filePath` if present, or initialize a
 * cold aggregator when `filePath` does not yet exist (`ENOENT`).
 */
export async function loadOrCreateIncrementalAggregator(
  filePath: string,
  options: LoadAggregatorOptions = {},
): Promise<{ aggregator: IncrementalAggregator; resumed: boolean; quarantinedPath: string | null }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        aggregator: new IncrementalAggregator(options),
        resumed: false,
        quarantinedPath: null,
      };
    }
    throw err;
  }

  try {
    const aggregator = IncrementalAggregator.fromCheckpoint(raw);
    return { aggregator, resumed: true, quarantinedPath: null };
  } catch (err) {
    if (!options.quarantineOnCorrupt) {
      throw err;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinedPath = `${filePath}.corrupt.${stamp}`;
    await rename(filePath, quarantinedPath);
    return {
      aggregator: new IncrementalAggregator(options),
      resumed: false,
      quarantinedPath,
    };
  }
}
