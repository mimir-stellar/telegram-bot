/**
 * RPC request timing metrics.
 *
 * The bot's only outbound calls are Soroban RPC `getHealth` and `getEvents`.
 * When either slows down or starts failing, an operator needs to see *that* and
 * roughly *how long* — from the scan output and the logs — without the metric
 * becoming a place a remote payload or a secret can land.
 *
 * The recorder keeps only fixed-size aggregates (per-operation request counts
 * and millisecond sums), never the request or response payloads, so memory is
 * O(1) in the number of requests and nothing sensitive is retained. The values
 * are wall-clock measurements of this process's own `await`, so they are safe to
 * log and to put in `/status`-style output.
 *
 * Dropped samples: observations with a non-finite or negative duration are still
 * counted as requests (so totals stay honest) but their duration is clamped to 0.
 * Each such drop is tallied under a bounded reason counter so operators can see
 * that clamping happened without any unbounded label cardinality.
 */

import {
  MetricLabelError,
  escapeMetricLabelValue,
  formatMetricLabels,
  validateMetricLabelKey,
  validateMetricName,
} from "../metrics.js";

export {
  MetricLabelError,
  escapeMetricLabelValue,
  formatMetricLabels,
  validateMetricLabelKey,
  validateMetricName,
};

export type RpcOperation = "health" | "events";

/** Bounded set of reasons a sample's duration was dropped/clamped. */
export type RpcDropReason = "non_finite" | "negative";

export const RPC_DROP_REASONS: readonly RpcDropReason[] = ["non_finite", "negative"];

/** Per-operation aggregate. Every quantity is a count or a duration in ms. */
export interface RpcOperationTiming {
  requests: number;
  failures: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

/** Bounded, secret-free timing summary for one scan (or one probe). */
export interface RpcTimingSummary {
  requests: number;
  failures: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  operations: Record<RpcOperation, RpcOperationTiming>;
  /** Count of samples whose duration was dropped, keyed by a fixed reason set. */
  droppedSamples: Record<RpcDropReason, number>;
}

const RPC_OPERATIONS: readonly RpcOperation[] = ["health", "events"];

function emptyOperation(): RpcOperationTiming {
  return { requests: 0, failures: 0, totalMs: 0, minMs: 0, maxMs: 0 };
}

function emptyDrops(): Record<RpcDropReason, number> {
  return { non_finite: 0, negative: 0 };
}

/** Round to at most 3 decimals so printed numbers stay short and stable. */
function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

export class RpcTiming {
  private readonly operations: Record<RpcOperation, RpcOperationTiming> = {
    health: emptyOperation(),
    events: emptyOperation(),
  };
  private readonly drops: Record<RpcDropReason, number> = emptyDrops();
  private readonly clock: () => number;

  /**
   * `clock` defaults to `performance.now()`; tests inject a deterministic
   * counter so aggregates are asserted exactly, with no real waiting.
   */
  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  /** Time one RPC await, recording success or failure, and rethrow on failure. */
  async measure<T>(operation: RpcOperation, fn: () => Promise<T>): Promise<T> {
    const start = this.clock();
    try {
      const result = await fn();
      this.record(operation, this.clock() - start, true);
      return result;
    } catch (error) {
      this.record(operation, this.clock() - start, false);
      throw error;
    }
  }

  /**
   * Record a completed observation. Non-finite or negative durations are
   * clamped to 0 rather than poisoning the aggregate with `NaN`/negatives, and
   * each clamp increments the matching bounded drop counter.
   */
  record(operation: RpcOperation, durationMs: number, ok: boolean): void {
    const aggregate = this.operations[operation];
    let duration = 0;
    if (!Number.isFinite(durationMs)) {
      this.drops.non_finite += 1;
    } else if (durationMs < 0) {
      this.drops.negative += 1;
    } else {
      duration = durationMs;
    }

    aggregate.requests += 1;
    if (!ok) aggregate.failures += 1;
    aggregate.totalMs += duration;
    if (aggregate.requests === 1 || duration < aggregate.minMs) aggregate.minMs = duration;
    if (duration > aggregate.maxMs) aggregate.maxMs = duration;
  }

  summary(): RpcTimingSummary {
    const operations = {} as Record<RpcOperation, RpcOperationTiming>;
    let requests = 0;
    let failures = 0;
    let totalMs = 0;
    let minMs = 0;
    let maxMs = 0;

    for (const operation of RPC_OPERATIONS) {
      const aggregate = this.operations[operation];
      operations[operation] = {
        requests: aggregate.requests,
        failures: aggregate.failures,
        totalMs: round(aggregate.totalMs),
        minMs: round(aggregate.minMs),
        maxMs: round(aggregate.maxMs),
      };
      requests += aggregate.requests;
      failures += aggregate.failures;
      totalMs += aggregate.totalMs;
      if (aggregate.requests > 0) {
        minMs = minMs === 0 ? aggregate.minMs : Math.min(minMs, aggregate.minMs);
        maxMs = Math.max(maxMs, aggregate.maxMs);
      }
    }

    return {
      requests,
      failures,
      totalMs: round(totalMs),
      minMs: round(minMs),
      maxMs: round(maxMs),
      avgMs: requests > 0 ? round(totalMs / requests) : 0,
      operations,
      droppedSamples: { ...this.drops },
    };
  }
}

/**
 * Bounded capacity gauge for a dead-letter queue.
 *
 * Reports only counts (used / max entries and a utilization ratio) and never
 * message bodies. When the queue is disabled (`maxEntries` of 0 or less, or
 * not finite), the gauge reports `enabled: false` with zero capacity and a
 * utilization of 0, so consumers can render "disabled" without dividing by zero.
 */
export interface DeadLetterCapacityGauge {
  enabled: boolean;
  used: number;
  max: number;
  utilization: number;
}

export function deadLetterCapacityGauge(
  used: number,
  maxEntries: number,
): DeadLetterCapacityGauge {
  const enabled = Number.isFinite(maxEntries) && maxEntries > 0;
  if (!enabled) {
    return { enabled: false, used: 0, max: 0, utilization: 0 };
  }
  const max = Math.floor(maxEntries);
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.min(Math.floor(used), max) : 0;
  return {
    enabled: true,
    used: safeUsed,
    max,
    utilization: round(safeUsed / max),
  };
}

/** One-line, secret-free timing string for logs and the scan summary. */
export function formatRpcTiming(summary: RpcTimingSummary): string {
  const { requests, failures, totalMs, avgMs, maxMs, operations, droppedSamples } = summary;
  // Drop counters are appended only when a sample was actually dropped, so the
  // common line stays unchanged and operators still see any clamping.
  const drops = droppedSamples ?? { non_finite: 0, negative: 0 };
  const dropSuffix =
    drops.non_finite > 0 || drops.negative > 0
      ? ` dropped_non_finite=${drops.non_finite} dropped_negative=${drops.negative}`
      : "";
  return (
    `rpc requests=${requests} failures=${failures} total=${totalMs}ms ` +
    `avg=${avgMs}ms max=${maxMs}ms ` +
    `health=${operations.health.requests} events=${operations.events.requests}` +
    dropSuffix
  );
}

// ── End-to-end notification age ───────────────────────────────────────────────

/**
 * Bounded, secret-free summary of end-to-end notification age from Stellar
 * ledger close time to confirmed Telegram send.
 */
export interface NotificationAgeSummary {
  /** Confirmed sends that had a valid ledger close time (includes 0ms lag). */
  samples: number;
  /** Confirmed sends whose event lacked a valid ledger close time. */
  missingLedgerTime: number;
  /** Cumulative end-to-end age in ms across all known-ledger-time samples. */
  totalMs: number;
  /** Minimum observed age in ms, or `null` when no known-ledger-time sample has been recorded. */
  minMs: number | null;
  /** Maximum observed age in ms, or `null` when no known-ledger-time sample has been recorded. */
  maxMs: number | null;
  /** Mean observed age in ms, or `null` when no known-ledger-time sample has been recorded. */
  avgMs: number | null;
  /** Most recent observed age in ms, or `null` when no known-ledger-time sample has been recorded. */
  lastMs: number | null;
}

/** Monotonic-anchored ingestion instant paired with a wall-clock timestamp. */
export interface NotificationIngestionMark {
  wallMs: number;
  monoMs: number;
}

/**
 * Tracks end-to-end notification age from ledger close time to confirmed send.
 *
 * Distinguishes missing ledger time (`ledgerTimeSec` absent, `<= 0`, or
 * non-finite) from zero delivery lag (`0` ms): missing ledger time increments
 * `missingLedgerTime` without altering `samples`, `minMs`, `maxMs`, `avgMs`,
 * or `lastMs` (which remain `null` until a known-ledger-time sample arrives).
 *
 * Uses a monotonic `clock` (defaulting to `performance.now()`) to measure
 * in-process elapsed time from ingestion to confirmed send so wall-clock
 * adjustments backwards during retries never reduce the measured send time.
 */
export class NotificationAge {
  private samples = 0;
  private missingLedgerTime = 0;
  private totalMs = 0;
  private minMs: number | null = null;
  private maxMs: number | null = null;
  private lastMs: number | null = null;
  private readonly clock: () => number;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  /**
   * Capture a wall-clock + monotonic-clock anchor at event ingestion so
   * {@link recordFromIngestion} can compute a monotonic confirmed-send time.
   */
  markIngested(wallNowMs: number): NotificationIngestionMark {
    return { wallMs: wallNowMs, monoMs: this.clock() };
  }

  /**
   * Compute confirmed-send wall-clock time from `ingested` using the monotonic
   * clock, then record the age from `ledgerTimeSec` (Unix seconds).
   * Returns the recorded age in ms, or `null` when ledger time is missing.
   */
  recordFromIngestion(
    ledgerTimeSec: number | null | undefined,
    ingested: NotificationIngestionMark,
  ): number | null {
    const elapsedMonoMs = Math.max(0, this.clock() - ingested.monoMs);
    const confirmedWallMs = ingested.wallMs + elapsedMonoMs;
    return this.record(ledgerTimeSec, confirmedWallMs);
  }

  /**
   * Record one confirmed send given `ledgerTimeSec` (Unix seconds; `<= 0` or
   * non-finite is treated as missing) and `confirmedWallMs` (Unix ms).
   * Negative age from slight chain-vs-host clock skew is clamped to `0` ms and
   * still counted as a valid `0` ms sample, distinct from missing ledger time.
   */
  record(ledgerTimeSec: number | null | undefined, confirmedWallMs: number): number | null {
    if (
      typeof ledgerTimeSec !== "number" ||
      !Number.isFinite(ledgerTimeSec) ||
      ledgerTimeSec <= 0 ||
      !Number.isFinite(confirmedWallMs)
    ) {
      this.missingLedgerTime += 1;
      return null;
    }

    const ledgerTimeMs = ledgerTimeSec * 1000;
    const ageMs = round(Math.max(0, confirmedWallMs - ledgerTimeMs));

    this.samples += 1;
    this.totalMs += ageMs;
    this.lastMs = ageMs;
    this.minMs = this.minMs === null ? ageMs : Math.min(this.minMs, ageMs);
    this.maxMs = this.maxMs === null ? ageMs : Math.max(this.maxMs, ageMs);
    return ageMs;
  }

  summary(): NotificationAgeSummary {
    return {
      samples: this.samples,
      missingLedgerTime: this.missingLedgerTime,
      totalMs: round(this.totalMs),
      minMs: this.minMs === null ? null : round(this.minMs),
      maxMs: this.maxMs === null ? null : round(this.maxMs),
      avgMs: this.samples > 0 ? round(this.totalMs / this.samples) : null,
      lastMs: this.lastMs === null ? null : round(this.lastMs),
    };
  }
}

/** One-line, secret-free notification age string for logs and summaries. */
export function formatNotificationAge(summary: NotificationAgeSummary): string {
  const last = summary.lastMs === null ? "none" : `${summary.lastMs}ms`;
  const avg = summary.avgMs === null ? "none" : `${summary.avgMs}ms`;
  const max = summary.maxMs === null ? "none" : `${summary.maxMs}ms`;
  return (
    `notification_age samples=${summary.samples} missing=${summary.missingLedgerTime} ` +
    `last=${last} avg=${avg} max=${max}`
  );
}

// ── Service-level window report ───────────────────────────────────────────────

export const DEFAULT_SERVICE_LEVEL_WINDOW_SIZE = 100;

/** Reasons why a service-level window is marked incomplete. */
export type ServiceLevelIncompleteReason =
  | "insufficient_samples"
  | "data_gap"
  | "stale_cursor"
  | "missing_ledger_time";

/** A single bounded observation recorded into the service-level window. */
export interface ServiceLevelSample {
  /** Whether the notification delivery attempt succeeded. */
  success: boolean;
  /** End-to-end lag in milliseconds from ledger close time to confirmed send, or null. */
  ageMs: number | null;
  /** Whether this observation represents or encountered a data gap. */
  dataGap?: boolean | undefined;
  /** Specific reason for the gap, if any. */
  gapReason?: ServiceLevelIncompleteReason | undefined;
  /** Whether this sample counts as an active delivery attempt. Defaults to true. */
  isDeliveryAttempt?: boolean | undefined;
  /** Timestamp when the sample was recorded (ms). */
  recordedAt?: number | undefined;
}

/** Explicit completeness status of a service-level window. */
export interface ServiceLevelCompleteness {
  /** True iff the window has reached full capacity and is free of data gaps. */
  complete: boolean;
  /** True iff the window is incomplete (inverse of complete). */
  incomplete: boolean;
  /** Explicit list of reasons why the window is incomplete; empty when complete. */
  reasons: ServiceLevelIncompleteReason[];
}

/** Delivery success indicators computed over the bounded window. */
export interface ServiceLevelDeliverySuccess {
  /** Total delivery attempts in the window. */
  attempts: number;
  /** Successful deliveries in the window. */
  sent: number;
  /** Failed deliveries in the window. */
  failed: number;
  /**
   * Success rate over delivery attempts: `sent / attempts` (0.0 to 1.0).
   * `null` when no delivery attempts were recorded in the window.
   */
  successRate: number | null;
  /**
   * Failure rate over delivery attempts: `failed / attempts` (0.0 to 1.0).
   * 0 when no delivery attempts were recorded in the window.
   */
  failureRate: number;
}

/** Delivery lag indicators computed over the bounded window. */
export interface ServiceLevelLag {
  /** Confirmed delivery samples with a known ledger close time. */
  samples: number;
  /** Confirmed deliveries whose event lacked a valid ledger close time. */
  missingLedgerTime: number;
  /** Minimum observed delivery lag in milliseconds, or null if no samples. */
  minMs: number | null;
  /** Maximum observed delivery lag in milliseconds, or null if no samples. */
  maxMs: number | null;
  /** Arithmetic mean delivery lag in milliseconds, or null if no samples. */
  avgMs: number | null;
  /** 50th percentile (median) delivery lag in milliseconds, or null if no samples. */
  p50Ms: number | null;
  /** 90th percentile delivery lag in milliseconds, or null if no samples. */
  p90Ms: number | null;
  /** 95th percentile delivery lag in milliseconds, or null if no samples. */
  p95Ms: number | null;
  /** Most recent observed delivery lag in milliseconds, or null if no samples. */
  lastMs: number | null;
}

/** Data gap indicators computed over the bounded window. */
export interface ServiceLevelDataGap {
  /** Total data gap events observed in the window. */
  totalGaps: number;
  /** Stale-cursor occurrences observed in the window. */
  staleCursorEvents: number;
  /** Observations lacking a valid ledger close time. */
  missingLedgerTime: number;
  /** Whether any data gaps were observed in the current window. */
  hasGaps: boolean;
}

/**
 * Machine-readable service-level window report.
 *
 * All indicators are computed over a bounded FIFO window of local samples
 * (at most `windowSize` samples). Incomplete windows (warming up, insufficient
 * samples, or data gaps) are marked explicitly.
 */
export interface ServiceLevelWindowReport {
  /** Fixed schema identifier for machine-readable parsing. */
  schema: "mimir.service-level-window";
  /** Schema version. */
  schemaVersion: 1;
  /** Window capacity (max samples retained). */
  windowSize: number;
  /** Current number of samples retained in the window (0 <= sampleCount <= windowSize). */
  sampleCount: number;
  /** Explicit completeness status of the window. */
  completeness: ServiceLevelCompleteness;
  /** Direct boolean indicator of completeness for consumer convenience. */
  complete: boolean;
  /** Direct boolean indicator of incompleteness for consumer convenience. */
  incomplete: boolean;
  /** Delivery success indicators over the bounded window. */
  delivery: ServiceLevelDeliverySuccess;
  /** Notification delivery lag indicators over the bounded window. */
  lag: ServiceLevelLag;
  /** Data gap indicators over the bounded window. */
  dataGap: ServiceLevelDataGap;
}

export interface ServiceLevelWindowOptions {
  /**
   * Capacity of the bounded rolling sample window.
   * Defaults to DEFAULT_SERVICE_LEVEL_WINDOW_SIZE (100).
   * Must be a positive integer >= 1.
   */
  windowSize?: number | undefined;
  /** Optional clock returning timestamp in milliseconds. */
  clock?: (() => number) | undefined;
}

/** Round to at most 4 decimals for rate ratios. */
function roundRate(rate: number): number {
  return Math.round(rate * 10000) / 10000;
}

/**
 * Calculates the p-th percentile (0 <= p <= 100) using nearest-rank integer indexing.
 */
function nearestRank(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index]!;
}

/**
 * Bounded rolling window of local service-level observations.
 *
 * Computes delivery success, lag, and data-gap indicators from at most
 * `windowSize` local samples in O(1) space, explicitly marking incomplete
 * windows during warm-up or after data gaps.
 */
export class ServiceLevelWindow {
  private readonly windowSize: number;
  private readonly clock: () => number;
  private readonly samples: ServiceLevelSample[] = [];

  constructor(options: ServiceLevelWindowOptions = {}) {
    if (options.windowSize !== undefined) {
      if (
        typeof options.windowSize !== "number" ||
        !Number.isInteger(options.windowSize) ||
        options.windowSize <= 0
      ) {
        throw new RangeError(
          `ServiceLevelWindow windowSize must be a positive integer >= 1; got ${options.windowSize}`,
        );
      }
      this.windowSize = options.windowSize;
    } else {
      this.windowSize = DEFAULT_SERVICE_LEVEL_WINDOW_SIZE;
    }
    this.clock = options.clock ?? (() => performance.now());
  }

  /** Capacity of the bounded rolling window. */
  get capacity(): number {
    return this.windowSize;
  }

  /** Current number of samples retained. */
  get count(): number {
    return this.samples.length;
  }

  /** Record a raw observation sample into the bounded window. */
  record(sample: ServiceLevelSample): void {
    const ageMs =
      sample.ageMs !== null && typeof sample.ageMs === "number" && Number.isFinite(sample.ageMs)
        ? round(Math.max(0, sample.ageMs))
        : null;

    const dataGap = sample.dataGap === true || sample.gapReason !== undefined;
    const gapReason = sample.gapReason ?? (dataGap ? "data_gap" : undefined);
    const isDeliveryAttempt = sample.isDeliveryAttempt !== false;

    this.samples.push({
      success: sample.success,
      ageMs,
      dataGap,
      gapReason,
      isDeliveryAttempt,
      recordedAt: sample.recordedAt ?? this.clock(),
    });

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  /**
   * Record a delivery attempt.
   *
   * @param success Whether Telegram send succeeded.
   * @param ageMs End-to-end lag in ms from ledger close time to confirmed send,
   *              or `null` when ledger time was missing.
   * @param dataGap Optional boolean indicating if a data gap occurred.
   * @param gapReason Optional specific reason if a gap occurred.
   */
  recordDelivery(
    success: boolean,
    ageMs: number | null = null,
    dataGap = false,
    gapReason?: ServiceLevelIncompleteReason,
  ): void {
    let resolvedDataGap = dataGap;
    let resolvedGapReason = gapReason;

    // If delivery is successful but ageMs is missing/null, this indicates missing ledger time
    if (success && (ageMs === null || typeof ageMs !== "number" || !Number.isFinite(ageMs))) {
      resolvedDataGap = true;
      resolvedGapReason = resolvedGapReason ?? "missing_ledger_time";
    }

    this.record({
      success,
      ageMs,
      dataGap: resolvedDataGap,
      gapReason: resolvedGapReason,
      isDeliveryAttempt: true,
    });
  }

  /**
   * Record a delivery from an ingestion mark and ledger time.
   */
  recordFromIngestion(
    ledgerTimeSec: number | null | undefined,
    ingested: NotificationIngestionMark,
    success = true,
  ): number | null {
    if (
      typeof ledgerTimeSec !== "number" ||
      !Number.isFinite(ledgerTimeSec) ||
      ledgerTimeSec <= 0 ||
      !Number.isFinite(ingested.wallMs)
    ) {
      this.recordDelivery(success, null, true, "missing_ledger_time");
      return null;
    }

    const elapsedMonoMs = Math.max(0, this.clock() - ingested.monoMs);
    const confirmedWallMs = ingested.wallMs + elapsedMonoMs;
    const ledgerTimeMs = ledgerTimeSec * 1000;
    const ageMs = round(Math.max(0, confirmedWallMs - ledgerTimeMs));

    this.recordDelivery(success, ageMs, false);
    return ageMs;
  }

  /**
   * Record a data gap event (e.g. stale cursor, missed ledgers).
   */
  recordDataGap(reason: ServiceLevelIncompleteReason = "data_gap"): void {
    this.record({
      success: false,
      ageMs: null,
      dataGap: true,
      gapReason: reason,
      isDeliveryAttempt: false,
    });
  }

  /**
   * Reset / clear all samples in the window.
   */
  reset(): void {
    this.samples.length = 0;
  }

  /**
   * Calculate and return the machine-readable service-level window report.
   */
  report(): ServiceLevelWindowReport {
    const total = this.samples.length;
    let sent = 0;
    let failed = 0;
    let attempts = 0;

    let missingLedgerTime = 0;
    let staleCursorEvents = 0;
    let totalGaps = 0;

    const validLags: number[] = [];
    let lastValidLag: number | null = null;
    let sumLags = 0;

    const reasonsSet = new Set<ServiceLevelIncompleteReason>();

    if (total < this.windowSize) {
      reasonsSet.add("insufficient_samples");
    }

    for (const sample of this.samples) {
      if (sample.isDeliveryAttempt !== false) {
        attempts += 1;
        if (sample.success) {
          sent += 1;
        } else {
          failed += 1;
        }
      }

      if (sample.dataGap) {
        totalGaps += 1;
        if (sample.gapReason === "stale_cursor") {
          staleCursorEvents += 1;
          reasonsSet.add("stale_cursor");
        } else if (sample.gapReason === "missing_ledger_time") {
          missingLedgerTime += 1;
          reasonsSet.add("missing_ledger_time");
        } else {
          reasonsSet.add(sample.gapReason ?? "data_gap");
        }
      }

      if (sample.ageMs !== null && Number.isFinite(sample.ageMs) && sample.ageMs >= 0) {
        validLags.push(sample.ageMs);
        lastValidLag = sample.ageMs;
        sumLags += sample.ageMs;
      } else if (sample.success && sample.ageMs === null) {
        if (!sample.dataGap) {
          missingLedgerTime += 1;
          totalGaps += 1;
          reasonsSet.add("missing_ledger_time");
        }
      }
    }

    const sortedLags = [...validLags].sort((a, b) => a - b);
    const lagCount = sortedLags.length;

    const minMs = lagCount > 0 ? round(sortedLags[0]!) : null;
    const maxMs = lagCount > 0 ? round(sortedLags[lagCount - 1]!) : null;
    const avgMs = lagCount > 0 ? round(sumLags / lagCount) : null;
    const p50Ms = lagCount > 0 ? round(nearestRank(sortedLags, 50)) : null;
    const p90Ms = lagCount > 0 ? round(nearestRank(sortedLags, 90)) : null;
    const p95Ms = lagCount > 0 ? round(nearestRank(sortedLags, 95)) : null;
    const lastMs = lastValidLag !== null ? round(lastValidLag) : null;

    const successRate = attempts > 0 ? roundRate(sent / attempts) : null;
    const failureRate = attempts > 0 ? roundRate(failed / attempts) : 0;

    const reasons = Array.from(reasonsSet);
    const complete = reasons.length === 0 && total >= this.windowSize;
    const incomplete = !complete;

    return {
      schema: "mimir.service-level-window",
      schemaVersion: 1,
      windowSize: this.windowSize,
      sampleCount: total,
      complete,
      incomplete,
      completeness: {
        complete,
        incomplete,
        reasons,
      },
      delivery: {
        attempts,
        sent,
        failed,
        successRate,
        failureRate,
      },
      lag: {
        samples: lagCount,
        missingLedgerTime,
        minMs,
        maxMs,
        avgMs,
        p50Ms,
        p90Ms,
        p95Ms,
        lastMs,
      },
      dataGap: {
        totalGaps,
        staleCursorEvents,
        missingLedgerTime,
        hasGaps: totalGaps > 0,
      },
    };
  }
}

/** One-line, secret-free service-level window string for logs and summaries. */
export function formatServiceLevelWindow(report: ServiceLevelWindowReport): string {
  const status = report.complete
    ? "complete"
    : `incomplete(${report.completeness.reasons.join(",") || "partial"})`;
  const succ =
    report.delivery.successRate === null
      ? "none"
      : `${round(report.delivery.successRate * 100)}%`;
  const avgLag = report.lag.avgMs === null ? "none" : `${report.lag.avgMs}ms`;
  const maxLag = report.lag.maxMs === null ? "none" : `${report.lag.maxMs}ms`;
  return (
    `service_level status=${status} samples=${report.sampleCount}/${report.windowSize} ` +
    `delivery_success=${succ} attempts=${report.delivery.attempts} ` +
    `avg_lag=${avgLag} max_lag=${maxLag} gaps=${report.dataGap.totalGaps}`
  );
}

/**
 * Render an {@link RpcTimingSummary} as Prometheus text exposition lines with
 * validated label keys and escaped label values (rejecting control-character
 * injection before exposition).
 */
export function renderRpcTimingMetrics(
  summary: RpcTimingSummary,
  extraLabels: Readonly<Record<string, string>> = {},
): string {
  for (const key of Object.keys(extraLabels)) {
    validateMetricLabelKey(key);
    if (key === "operation") {
      throw new MetricLabelError(
        "INVALID_LABEL_KEY",
        'extraLabels must not override reserved RPC metric label "operation"',
      );
    }
  }

  const lines: string[] = [
    `# HELP mimir_stellar_rpc_operation_requests_total Total Soroban RPC calls by operation`,
    `# TYPE mimir_stellar_rpc_operation_requests_total counter`,
  ];
  for (const op of RPC_OPERATIONS) {
    const labels = formatMetricLabels({ ...extraLabels, operation: op });
    lines.push(`mimir_stellar_rpc_operation_requests_total${labels} ${summary.operations[op].requests}`);
  }

  lines.push(
    `# HELP mimir_stellar_rpc_operation_failures_total Total failed Soroban RPC calls by operation`,
    `# TYPE mimir_stellar_rpc_operation_failures_total counter`,
  );
  for (const op of RPC_OPERATIONS) {
    const labels = formatMetricLabels({ ...extraLabels, operation: op });
    lines.push(`mimir_stellar_rpc_operation_failures_total${labels} ${summary.operations[op].failures}`);
  }

  lines.push(
    `# HELP mimir_stellar_rpc_operation_duration_ms_total Cumulative Soroban RPC call duration in ms by operation`,
    `# TYPE mimir_stellar_rpc_operation_duration_ms_total counter`,
  );
  for (const op of RPC_OPERATIONS) {
    const labels = formatMetricLabels({ ...extraLabels, operation: op });
    lines.push(`mimir_stellar_rpc_operation_duration_ms_total${labels} ${summary.operations[op].totalMs}`);
  }

  return `${lines.join("\n")}\n`;
}
