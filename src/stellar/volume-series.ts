import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey, type DedupableEvent } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";

export type VolumeBucketUnit = "hour" | "day";

export const VOLUME_SERIES_CHECKPOINT_FORMAT = "mimir-volume-series-checkpoint-v1";
export const VOLUME_SERIES_CHECKPOINT_VERSION = 1;

export interface VolumeBucketCheckpointState {
  startAt: number;
  challengeStake: string;
  squadDeposit: string;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

/**
 * Versioned, bounded checkpoint state for volume series reducers.
 *
 * Persists intermediate bucket sums and a bounded deduplication window of recent
 * event identifiers to prevent double-counting when resuming across overlapping
 * pagination boundaries (e.g. inclusive Soroban `getEvents` cursors).
 */
export interface VolumeSeriesCheckpoint {
  format: "mimir-volume-series-checkpoint-v1";
  version: 1;
  bucket: VolumeBucketUnit;
  updatedAt: string;
  processedEvents: number;
  skippedWithoutAt: number;
  totalChallengeStake: string;
  totalSquadDeposit: string;
  minBucketStart: number | null;
  maxBucketStart: number | null;
  buckets: VolumeBucketCheckpointState[];
  recentEventIds: string[];
  lastProcessedEventId?: string | null;
  dedupCapacity: number;
}

export interface VolumeSeriesOptions {
  bucket: VolumeBucketUnit;
  /** Optional versioned checkpoint to resume from. */
  checkpoint?: VolumeSeriesCheckpoint | null;
  /** Deduplication window capacity for dropping overlapping events across scan pages (default: 256). */
  dedupCapacity?: number;
  /** Whether to drop duplicate event IDs within and across batches. Defaults to true when resuming from a checkpoint. */
  dedup?: boolean;
  /** Maximum number of buckets to retain in reducer state (bounded state). */
  maxBuckets?: number;
  /** Whether to include the checkpoint and resumedDuplicates in the returned VolumeSeriesResult. */
  includeCheckpoint?: boolean;
}

/**
 * Summary of the volume series. Conflicting terminal events are not silently
 * resolved; they are reported via `inconsistencies`.
 */

export interface VolumeBucket {
  /** UTC ISO string representing the start of the bucket. */
  timestamp: string;
  /** Unix timestamp in seconds for the start of the bucket. */
  startAt: number;
  /** Composite identity of the aggregate this bucket belongs to. */
  identityKey: string;
  challengeStakeTotal: string;
  squadDepositTotal: string;
  challengeStake: bigint;
  squadDeposit: bigint;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
  /**
   * True when no valid events fell into this bucket. Zero-filled buckets carry
   * `empty: true` so consumers can distinguish an absent observation from a
   * real zero total.
   */
  empty: boolean;
}

export interface VolumeSeriesResult {
  buckets: VolumeBucket[];
  totalChallengeStake: string;
  totalSquadDeposit: string;
  skippedWithoutAt: number;
  processedEvents: number;
  /** Optional versioned bounded checkpoint state representing this series, resumable for future pages. */
  checkpoint?: VolumeSeriesCheckpoint;
  /** Events skipped because they were already accounted for in a resumed checkpoint or earlier page. */
  resumedDuplicates?: number;
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

export class VolumeSeriesCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumeSeriesCheckpointError";
  }
}

/**
 * Floor unix timestamp in seconds to the start of the UTC bucket.
 */
export function floorToBucketUtc(unixSeconds: number, bucket: VolumeBucketUnit): number {
  if (bucket === "hour") {
    return Math.floor(unixSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  }
  return Math.floor(unixSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function serializeVolumeSeriesCheckpoint(checkpoint: VolumeSeriesCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export function deserializeVolumeSeriesCheckpoint(json: string): VolumeSeriesCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new VolumeSeriesCheckpointError(
      `Malformed JSON in volume series checkpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VolumeSeriesCheckpointError("Volume series checkpoint must be a JSON object");
  }

  const cp = parsed as Partial<VolumeSeriesCheckpoint>;
  if (cp.format !== VOLUME_SERIES_CHECKPOINT_FORMAT || cp.version !== VOLUME_SERIES_CHECKPOINT_VERSION) {
    throw new VolumeSeriesCheckpointError(
      `Incompatible volume series checkpoint format or version (expected ${VOLUME_SERIES_CHECKPOINT_FORMAT} v${VOLUME_SERIES_CHECKPOINT_VERSION}, got format=${String(cp.format)} version=${String(cp.version)})`,
    );
  }

  if (cp.bucket !== "hour" && cp.bucket !== "day") {
    throw new VolumeSeriesCheckpointError(`Invalid bucket unit in checkpoint: ${String(cp.bucket)}`);
  }

  if (!Array.isArray(cp.buckets)) {
    throw new VolumeSeriesCheckpointError("Checkpoint buckets must be an array");
  }

  return {
    format: VOLUME_SERIES_CHECKPOINT_FORMAT,
    version: VOLUME_SERIES_CHECKPOINT_VERSION,
    bucket: cp.bucket,
    updatedAt: typeof cp.updatedAt === "string" ? cp.updatedAt : new Date().toISOString(),
    processedEvents: typeof cp.processedEvents === "number" ? Math.max(0, cp.processedEvents) : 0,
    skippedWithoutAt: typeof cp.skippedWithoutAt === "number" ? Math.max(0, cp.skippedWithoutAt) : 0,
    totalChallengeStake: typeof cp.totalChallengeStake === "string" ? cp.totalChallengeStake : "0",
    totalSquadDeposit: typeof cp.totalSquadDeposit === "string" ? cp.totalSquadDeposit : "0",
    minBucketStart: typeof cp.minBucketStart === "number" ? cp.minBucketStart : null,
    maxBucketStart: typeof cp.maxBucketStart === "number" ? cp.maxBucketStart : null,
    buckets: cp.buckets.map((b) => ({
      startAt: Number(b.startAt),
      challengeStake: String(b.challengeStake ?? "0"),
      squadDeposit: String(b.squadDeposit ?? "0"),
      challengeCount: Number(b.challengeCount ?? 0),
      depositCount: Number(b.depositCount ?? 0),
      eventCount: Number(b.eventCount ?? 0),
    })),
    recentEventIds: Array.isArray(cp.recentEventIds)
      ? cp.recentEventIds.filter((id): id is string => typeof id === "string")
      : [],
    lastProcessedEventId: typeof cp.lastProcessedEventId === "string" ? cp.lastProcessedEventId : null,
    dedupCapacity: typeof cp.dedupCapacity === "number" ? cp.dedupCapacity : DEFAULT_DEDUP_WINDOW,
  };
}

export async function saveVolumeSeriesCheckpoint(
  filePath: string,
  checkpoint: VolumeSeriesCheckpoint,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, serializeVolumeSeriesCheckpoint(checkpoint), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

export async function loadVolumeSeriesCheckpoint(
  filePath: string,
): Promise<VolumeSeriesCheckpoint | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new VolumeSeriesCheckpointError(
      `Cannot read volume series checkpoint file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return deserializeVolumeSeriesCheckpoint(content);
  } catch (err) {
    if (err instanceof VolumeSeriesCheckpointError) {
      throw new VolumeSeriesCheckpointError(`In checkpoint file "${filePath}": ${err.message}`);
    }
    throw err;
  }
}

interface IntermediateBucket {
  startAt: number;
  challengeStake: bigint;
  squadDeposit: bigint;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

/**
 * Incremental, checkpointable reducer for time-bucketed volume series.
 *
 * Supports page-by-page feeding during long-running scans with a bounded
 * deduplication window so overlapping replay pages do not double-count events.
 */
export class VolumeSeriesReducer {
  readonly bucketUnit: VolumeBucketUnit;
  readonly dedupCapacity: number;
  private readonly maxBuckets?: number;
  private readonly dedup: EventDedupWindow;
  private readonly checkpointDedup = new Set<string>();
  private readonly isResuming: boolean;
  private readonly enableDedup: boolean;
  private bucketMap = new Map<number, IntermediateBucket>();
  private minBucketStart: number | null = null;
  private maxBucketStart: number | null = null;
  private totalChallengeStakeBigInt = 0n;
  private totalSquadDepositBigInt = 0n;
  private skippedWithoutAt = 0;
  private processedEvents = 0;
  private resumedDuplicates = 0;
  private lastProcessedEventId: string | null = null;
  private readonly hadInitialCheckpoint: boolean;

  constructor(options: VolumeSeriesOptions) {
    const bucketUnit = options?.bucket;
    if (bucketUnit !== "hour" && bucketUnit !== "day") {
      throw new Error(`Invalid bucket unit: expected "hour" or "day", got ${String(bucketUnit)}`);
    }
    this.bucketUnit = bucketUnit;
    this.dedupCapacity = options?.dedupCapacity ?? DEFAULT_DEDUP_WINDOW;
    this.dedup = new EventDedupWindow(this.dedupCapacity);
    this.maxBuckets = options?.maxBuckets;
    this.hadInitialCheckpoint = Boolean(options?.checkpoint);
    this.isResuming = Boolean(options?.checkpoint);
    this.enableDedup = options?.dedup ?? this.isResuming;

    if (options?.checkpoint) {
      this.restoreCheckpoint(options.checkpoint);
    }
  }

  private restoreCheckpoint(cp: VolumeSeriesCheckpoint): void {
    if (cp.format !== VOLUME_SERIES_CHECKPOINT_FORMAT || cp.version !== VOLUME_SERIES_CHECKPOINT_VERSION) {
      throw new VolumeSeriesCheckpointError(
        `Incompatible volume series checkpoint format or version (expected ${VOLUME_SERIES_CHECKPOINT_FORMAT} v${VOLUME_SERIES_CHECKPOINT_VERSION})`,
      );
    }
    if (cp.bucket !== this.bucketUnit) {
      throw new VolumeSeriesCheckpointError(
        `Cannot resume volume series checkpoint: bucket unit mismatch (checkpoint has "${cp.bucket}", options specified "${this.bucketUnit}")`,
      );
    }

    this.minBucketStart = cp.minBucketStart;
    this.maxBucketStart = cp.maxBucketStart;
    try {
      this.totalChallengeStakeBigInt = BigInt(cp.totalChallengeStake);
    } catch {
      this.totalChallengeStakeBigInt = 0n;
    }
    try {
      this.totalSquadDepositBigInt = BigInt(cp.totalSquadDeposit);
    } catch {
      this.totalSquadDepositBigInt = 0n;
    }
    this.skippedWithoutAt = cp.skippedWithoutAt;
    this.processedEvents = cp.processedEvents;
    this.lastProcessedEventId = cp.lastProcessedEventId ?? null;

    for (const b of cp.buckets) {
      try {
        this.bucketMap.set(b.startAt, {
          startAt: b.startAt,
          challengeStake: BigInt(b.challengeStake),
          squadDeposit: BigInt(b.squadDeposit),
          challengeCount: b.challengeCount,
          depositCount: b.depositCount,
          eventCount: b.eventCount,
        });
      } catch {
        // Skip malformed individual bucket if bigint parse fails
      }
    }

    if (Array.isArray(cp.recentEventIds)) {
      for (const id of cp.recentEventIds) {
        if (typeof id === "string" && id !== "") {
          this.dedup.add(id);
          this.checkpointDedup.add(id);
        }
      }
    }
  }

  get stats(): { processedEvents: number; skippedWithoutAt: number; resumedDuplicates: number } {
    return {
      processedEvents: this.processedEvents,
      skippedWithoutAt: this.skippedWithoutAt,
      resumedDuplicates: this.resumedDuplicates,
    };
    attachSeriesMetadata(emptyResult, 0n, 0n);
    return emptyResult;
  }

  /**
   * Ingest a single decoded event.
   *
   * Returns true if processed as a new event, false if dropped as a duplicate
   * or skipped due to invalid structure.
   */
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

    const at = (event as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      this.skippedWithoutAt++;
      if (key !== null) {
        this.dedup.add(key);
        this.lastProcessedEventId = key;
      }
      return false;
    }

    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      if (key !== null) {
        this.dedup.add(key);
        this.lastProcessedEventId = key;
      }
      return false;
    }

    const payloadName = (payload as { name?: unknown }).name;

    let challengeStakeDelta = 0n;
    let squadDepositDelta = 0n;
    let isChallenge = false;
    let isDeposit = false;

    if (payloadName === "claim_challenged") {
      const stake = (payload as { stake?: unknown }).stake;
      if (typeof stake === "bigint") challengeStakeDelta = stake;
      else if (typeof stake === "string" || typeof stake === "number") {
        try { challengeStakeDelta = BigInt(stake); } catch { challengeStakeDelta = 0n; }
      }
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amt = (payload as { amount?: unknown }).amount;
      if (typeof amt === "bigint") squadDepositDelta = amt;
      else if (typeof amt === "string" || typeof amt === "number") {
        try { squadDepositDelta = BigInt(amt); } catch { squadDepositDelta = 0n; }
      }
      isDeposit = true;
    }

    this.processedEvents++;
    if (key !== null) {
      this.dedup.add(key);
      this.lastProcessedEventId = key;
    }

    const bucketStart = floorToBucketUtc(Math.floor(at), this.bucketUnit);

    if (this.minBucketStart === null || bucketStart < this.minBucketStart) {
      this.minBucketStart = bucketStart;
    }
    if (this.maxBucketStart === null || bucketStart > this.maxBucketStart) {
      this.maxBucketStart = bucketStart;
    }

    this.totalChallengeStakeBigInt += challengeStakeDelta;
    this.totalSquadDepositBigInt += squadDepositDelta;

    let existing = this.bucketMap.get(bucketStart);
    if (!existing) {
      existing = {
        identityKey, startAt: bucketStart,
        challengeStake: 0n, squadDeposit: 0n,
        challengeCount: 0, depositCount: 0, eventCount: 0,
      };
      this.bucketMap.set(bucketStart, existing);
    }

    existing.challengeStake += challengeStakeDelta;
    existing.squadDeposit += squadDepositDelta;
    if (isChallenge) existing.challengeCount++;
    if (isDeposit) existing.depositCount++;
    existing.eventCount++;

    if (this.maxBuckets !== undefined && this.bucketMap.size > this.maxBuckets) {
      const sortedKeys = Array.from(this.bucketMap.keys()).sort((a, b) => a - b);
      const toEvict = sortedKeys.slice(0, this.bucketMap.size - this.maxBuckets);
      for (const k of toEvict) {
        this.bucketMap.delete(k);
      }
      if (sortedKeys.length > toEvict.length) {
        this.minBucketStart = sortedKeys[toEvict.length]!;
      }
    }

    return true;
  }

  addEvents(events: readonly DecodedEvent[] | null | undefined): {
    processed: number;
    duplicates: number;
    skippedWithoutAt: number;
  } {
    if (!events || !Array.isArray(events)) {
      return { processed: 0, duplicates: 0, skippedWithoutAt: 0 };
    }
    const prevProcessed = this.processedEvents;
    const prevDuplicates = this.resumedDuplicates;
    const prevSkipped = this.skippedWithoutAt;

    for (const ev of events) {
      this.addEvent(ev);
    }

    return {
      processed: this.processedEvents - prevProcessed,
      duplicates: this.resumedDuplicates - prevDuplicates,
      skippedWithoutAt: this.skippedWithoutAt - prevSkipped,
    };
  }

  toCheckpoint(): VolumeSeriesCheckpoint {
    const buckets: VolumeBucketCheckpointState[] = Array.from(this.bucketMap.values())
      .sort((a, b) => a.startAt - b.startAt)
      .map((b) => ({
        startAt: b.startAt,
        challengeStake: b.challengeStake.toString(),
        squadDeposit: b.squadDeposit.toString(),
        challengeCount: b.challengeCount,
        depositCount: b.depositCount,
        eventCount: b.eventCount,
      }));

    return {
      format: VOLUME_SERIES_CHECKPOINT_FORMAT,
      version: VOLUME_SERIES_CHECKPOINT_VERSION,
      bucket: this.bucketUnit,
      updatedAt: new Date().toISOString(),
      processedEvents: this.processedEvents,
      skippedWithoutAt: this.skippedWithoutAt,
      totalChallengeStake: this.totalChallengeStakeBigInt.toString(),
      totalSquadDeposit: this.totalSquadDepositBigInt.toString(),
      minBucketStart: this.minBucketStart,
      maxBucketStart: this.maxBucketStart,
      buckets,
      recentEventIds: this.dedup.toJSON(),
      lastProcessedEventId: this.lastProcessedEventId,
      dedupCapacity: this.dedupCapacity,
    };
  }
  buckets.sort((a, b) =>
    a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : a.startAt - b.startAt,
  );

  toResult(options?: { includeCheckpoint?: boolean }): VolumeSeriesResult {
    const stepSeconds = this.bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;
    const buckets: VolumeBucket[] = [];

    if (this.minBucketStart !== null && this.maxBucketStart !== null) {
      for (let t = this.minBucketStart; t <= this.maxBucketStart; t += stepSeconds) {
        const data = this.bucketMap.get(t);
        const challengeStake = data ? data.challengeStake : 0n;
        const squadDeposit = data ? data.squadDeposit : 0n;
        const challengeCount = data ? data.challengeCount : 0;
        const depositCount = data ? data.depositCount : 0;
        const eventCount = data ? data.eventCount : 0;

        buckets.push({
          timestamp: new Date(t * 1000).toISOString(),
          startAt: t,
          challengeStakeTotal: challengeStake.toString(),
          squadDepositTotal: squadDeposit.toString(),
          challengeStake,
          squadDeposit,
          challengeCount,
          depositCount,
          eventCount,
        });
      }
    }

    const baseResult: VolumeSeriesResult = {
      buckets,
      totalChallengeStake: this.totalChallengeStakeBigInt.toString(),
      totalSquadDeposit: this.totalSquadDepositBigInt.toString(),
      skippedWithoutAt: this.skippedWithoutAt,
      processedEvents: this.processedEvents,
    };

    if (options?.includeCheckpoint || this.hadInitialCheckpoint) {
      baseResult.checkpoint = this.toCheckpoint();
      baseResult.resumedDuplicates = this.resumedDuplicates;
    }

    return baseResult;
  }

  static fromCheckpoint(
    checkpoint: VolumeSeriesCheckpoint,
    options?: Partial<VolumeSeriesOptions>,
  ): VolumeSeriesReducer {
    return new VolumeSeriesReducer({
      bucket: options?.bucket ?? checkpoint.bucket,
      checkpoint,
      dedupCapacity: options?.dedupCapacity ?? checkpoint.dedupCapacity,
      maxBuckets: options?.maxBuckets,
      includeCheckpoint: options?.includeCheckpoint,
    });
  }
}

/**
 * Produce time-bucketed volume series for stakes and deposits.
 *
 * Empty buckets between earliest and latest events are filled with zero values.
 * Events without a valid `at` timestamp are skipped and counted in `skippedWithoutAt`.
 *
 * If a `checkpoint` is passed via `options`, reduces incrementally starting from the
 * checkpoint state and drops overlapping replay events seen in `recentEventIds`.
 */
export function volumeSeries(
  events: readonly DecodedEvent[] | null | undefined,
  options: VolumeSeriesOptions,
): VolumeSeriesResult {
  const reducer = new VolumeSeriesReducer(options);
  if (events && Array.isArray(events)) {
    reducer.addEvents(events);
  }
  return reducer.toResult({ includeCheckpoint: options?.includeCheckpoint });
}
