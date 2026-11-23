/**
 * Unified incremental aggregate checkpoints for long-running scans.
 *
 * Coordinates analytical reducers (such as volume series and claim resolution latency)
 * across long-running scan pages with bounded state and deduplication to prevent
 * double-counting when resuming from overlapping pagination boundaries.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey, type DedupableEvent } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";
import {
  ResolutionLatencyReducer,
  type ResolutionLatencyCheckpoint,
  type ResolutionLatencyOptions,
  type ResolutionLatencyReport,
} from "./resolution-latency.js";
import {
  VolumeSeriesReducer,
  type VolumeSeriesCheckpoint,
  type VolumeSeriesOptions,
  type VolumeSeriesResult,
} from "./volume-series.js";

export const AGGREGATE_SCAN_CHECKPOINT_FORMAT = "mimir-aggregate-scan-checkpoint-v1";
export const AGGREGATE_SCAN_CHECKPOINT_VERSION = 1;

/**
 * Versioned, bounded checkpoint file schema for long-running aggregate scans.
 */
export interface AggregateScanCheckpoint {
  format: "mimir-aggregate-scan-checkpoint-v1";
  version: 1;
  updatedAt: string;
  cursor?: string | null;
  lastLedger?: number | null;
  pagesProcessed: number;
  totalEventsProcessed: number;
  totalDuplicates: number;
  volume?: VolumeSeriesCheckpoint | null;
  latency?: ResolutionLatencyCheckpoint | null;
  recentEventIds: string[];
  dedupCapacity: number;
  metadata?: Record<string, unknown>;
}

export interface AggregateScanOptions {
  /** Volume series configuration (or true for default hourly bucket). */
  volume?: VolumeSeriesOptions | boolean;
  /** Resolution latency configuration (or true for defaults). */
  latency?: ResolutionLatencyOptions | boolean;
  /** Optional persisted checkpoint to resume from. */
  checkpoint?: AggregateScanCheckpoint | null;
  /** Initial scan cursor, if starting or overriding. */
  cursor?: string | null;
  /** Initial scan ledger, if starting or overriding. */
  lastLedger?: number | null;
  /** Bounded deduplication capacity across pages (default: 256). */
  dedupCapacity?: number;
  /** Arbitrary caller metadata preserved across checkpoints. */
  metadata?: Record<string, unknown>;
}

export interface AggregateScanResults {
  volume?: VolumeSeriesResult;
  latency?: ResolutionLatencyReport;
  pagesProcessed: number;
  totalEventsProcessed: number;
  totalDuplicates: number;
  cursor: string | null;
  lastLedger: number | null;
  checkpoint: AggregateScanCheckpoint;
}

export class AggregateScanCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateScanCheckpointError";
  }
}

export function serializeAggregateScanCheckpoint(checkpoint: AggregateScanCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export function deserializeAggregateScanCheckpoint(json: string): AggregateScanCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AggregateScanCheckpointError(
      `Malformed JSON in aggregate scan checkpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AggregateScanCheckpointError("Aggregate scan checkpoint must be a JSON object");
  }

  const cp = parsed as Partial<AggregateScanCheckpoint>;
  if (cp.format !== AGGREGATE_SCAN_CHECKPOINT_FORMAT || cp.version !== AGGREGATE_SCAN_CHECKPOINT_VERSION) {
    throw new AggregateScanCheckpointError(
      `Incompatible aggregate scan checkpoint format or version (expected ${AGGREGATE_SCAN_CHECKPOINT_FORMAT} v${AGGREGATE_SCAN_CHECKPOINT_VERSION}, got format=${String(cp.format)} version=${String(cp.version)})`,
    );
  }

  return {
    format: AGGREGATE_SCAN_CHECKPOINT_FORMAT,
    version: AGGREGATE_SCAN_CHECKPOINT_VERSION,
    updatedAt: typeof cp.updatedAt === "string" ? cp.updatedAt : new Date().toISOString(),
    cursor: typeof cp.cursor === "string" ? cp.cursor : null,
    lastLedger: typeof cp.lastLedger === "number" ? cp.lastLedger : null,
    pagesProcessed: typeof cp.pagesProcessed === "number" ? Math.max(0, cp.pagesProcessed) : 0,
    totalEventsProcessed: typeof cp.totalEventsProcessed === "number" ? Math.max(0, cp.totalEventsProcessed) : 0,
    totalDuplicates: typeof cp.totalDuplicates === "number" ? Math.max(0, cp.totalDuplicates) : 0,
    volume: cp.volume ?? null,
    latency: cp.latency ?? null,
    recentEventIds: Array.isArray(cp.recentEventIds)
      ? cp.recentEventIds.filter((id): id is string => typeof id === "string")
      : [],
    dedupCapacity: typeof cp.dedupCapacity === "number" ? cp.dedupCapacity : DEFAULT_DEDUP_WINDOW,
    metadata: cp.metadata && typeof cp.metadata === "object" ? cp.metadata : undefined,
  };
}

export async function saveAggregateScanCheckpoint(
  filePath: string,
  checkpoint: AggregateScanCheckpoint,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, serializeAggregateScanCheckpoint(checkpoint), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

export async function loadAggregateScanCheckpoint(
  filePath: string,
): Promise<AggregateScanCheckpoint | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new AggregateScanCheckpointError(
      `Cannot read aggregate scan checkpoint file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return deserializeAggregateScanCheckpoint(content);
  } catch (err) {
    if (err instanceof AggregateScanCheckpointError) {
      throw new AggregateScanCheckpointError(`In checkpoint file "${filePath}": ${err.message}`);
    }
    throw err;
  }
}

/**
 * Coordinator reducer that drives both volume series and latency reducers across
 * pages during long-running chain scans.
 */
export class AggregateScanReducer {
  private readonly volumeReducer?: VolumeSeriesReducer;
  private readonly latencyReducer?: ResolutionLatencyReducer;
  private readonly dedup: EventDedupWindow;
  private readonly checkpointDedup = new Set<string>();
  private readonly isResuming: boolean;
  private cursor: string | null = null;
  private lastLedger: number | null = null;
  private pagesProcessed = 0;
  private totalEventsProcessed = 0;
  private totalDuplicates = 0;
  private metadata?: Record<string, unknown>;

  constructor(options: AggregateScanOptions = {}) {
    const cp = options.checkpoint;
    this.isResuming = Boolean(cp);
    const dedupCap = options.dedupCapacity ?? cp?.dedupCapacity ?? DEFAULT_DEDUP_WINDOW;
    this.dedup = new EventDedupWindow(dedupCap);
    this.metadata = options.metadata ?? cp?.metadata;
    this.cursor = options.cursor ?? cp?.cursor ?? null;
    this.lastLedger = options.lastLedger ?? cp?.lastLedger ?? null;
    this.pagesProcessed = cp?.pagesProcessed ?? 0;
    this.totalEventsProcessed = cp?.totalEventsProcessed ?? 0;
    this.totalDuplicates = cp?.totalDuplicates ?? 0;

    if (cp?.recentEventIds) {
      for (const id of cp.recentEventIds) {
        if (typeof id === "string" && id !== "") {
          this.dedup.add(id);
          this.checkpointDedup.add(id);
        }
      }
    }

    // Configure volume reducer
    if (options.volume || cp?.volume) {
      const volOpts: VolumeSeriesOptions =
        typeof options.volume === "object"
          ? { ...options.volume }
          : { bucket: cp?.volume?.bucket ?? "hour" };

      if (cp?.volume && !volOpts.checkpoint) {
        volOpts.checkpoint = cp.volume;
      }
      volOpts.dedup = true;
      volOpts.includeCheckpoint = true;
      this.volumeReducer = new VolumeSeriesReducer(volOpts);
    }

    // Configure latency reducer
    if (options.latency || cp?.latency) {
      const latOpts: ResolutionLatencyOptions =
        typeof options.latency === "object" ? { ...options.latency } : {};

      if (cp?.latency && !latOpts.checkpoint) {
        latOpts.checkpoint = cp.latency;
      }
      latOpts.dedup = true;
      latOpts.includeCheckpoint = true;
      this.latencyReducer = new ResolutionLatencyReducer(latOpts);
    }
  }

  /**
   * Process a single decoded event.
   *
   * Returns true if processed as a new event, false if dropped as an overlapping duplicate.
   */
  addEvent(event: DecodedEvent): boolean {
    if (!event || typeof event !== "object") {
      return false;
    }

    const key = eventKey(event as DedupableEvent);
    if (key !== null) {
      if (this.isResuming && this.checkpointDedup.has(key)) {
        this.totalDuplicates++;
        return false;
      }
      if (this.dedup.has(key)) {
        this.totalDuplicates++;
        return false;
      }
      this.dedup.add(key);
    }

    this.totalEventsProcessed++;
    if (typeof (event as { ledger?: unknown }).ledger === "number") {
      const l = (event as { ledger: number }).ledger;
      if (this.lastLedger === null || l > this.lastLedger) {
        this.lastLedger = l;
      }
    }

    if (this.volumeReducer) {
      this.volumeReducer.addEvent(event);
    }
    if (this.latencyReducer) {
      this.latencyReducer.addEvent(event);
    }

    return true;
  }

  /**
   * Process an entire page of events from a scan or replay walk.
   */
  addPage(
    events: readonly DecodedEvent[] | null | undefined,
    pageMeta?: { cursor?: string | null; ledger?: number | null },
  ): { processed: number; duplicates: number } {
    this.pagesProcessed++;
    if (pageMeta?.cursor !== undefined) {
      this.cursor = pageMeta.cursor;
    }
    if (pageMeta?.ledger !== undefined && pageMeta.ledger !== null) {
      this.lastLedger = pageMeta.ledger;
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return { processed: 0, duplicates: 0 };
    }

    let processed = 0;
    let duplicates = 0;

    for (const ev of events) {
      if (this.addEvent(ev)) {
        processed++;
      } else {
        duplicates++;
      }
    }

    return { processed, duplicates };
  }

  toCheckpoint(): AggregateScanCheckpoint {
    return {
      format: AGGREGATE_SCAN_CHECKPOINT_FORMAT,
      version: AGGREGATE_SCAN_CHECKPOINT_VERSION,
      updatedAt: new Date().toISOString(),
      cursor: this.cursor,
      lastLedger: this.lastLedger,
      pagesProcessed: this.pagesProcessed,
      totalEventsProcessed: this.totalEventsProcessed,
      totalDuplicates: this.totalDuplicates,
      volume: this.volumeReducer ? this.volumeReducer.toCheckpoint() : null,
      latency: this.latencyReducer ? this.latencyReducer.toCheckpoint() : null,
      recentEventIds: this.dedup.toJSON(),
      dedupCapacity: this.dedup.capacity,
      metadata: this.metadata,
    };
  }

  toResults(): AggregateScanResults {
    const checkpoint = this.toCheckpoint();
    return {
      volume: this.volumeReducer?.toResult(),
      latency: this.latencyReducer?.toReport(),
      pagesProcessed: this.pagesProcessed,
      totalEventsProcessed: this.totalEventsProcessed,
      totalDuplicates: this.totalDuplicates,
      cursor: this.cursor,
      lastLedger: this.lastLedger,
      checkpoint,
    };
  }

  static fromCheckpoint(
    checkpoint: AggregateScanCheckpoint,
    options?: Partial<AggregateScanOptions>,
  ): AggregateScanReducer {
    return new AggregateScanReducer({
      ...options,
      checkpoint,
    });
  }
}
