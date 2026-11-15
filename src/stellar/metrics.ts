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
 */

export type RpcOperation = "health" | "events";

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
}

const RPC_OPERATIONS: readonly RpcOperation[] = ["health", "events"];

function emptyOperation(): RpcOperationTiming {
  return { requests: 0, failures: 0, totalMs: 0, minMs: 0, maxMs: 0 };
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
   * clamped to 0 rather than poisoning the aggregate with `NaN`/negatives.
   */
  record(operation: RpcOperation, durationMs: number, ok: boolean): void {
    const aggregate = this.operations[operation];
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

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
    };
  }
}

/** One-line, secret-free timing string for logs and the scan summary. */
export function formatRpcTiming(summary: RpcTimingSummary): string {
  const { requests, failures, totalMs, avgMs, maxMs, operations } = summary;
  return (
    `rpc requests=${requests} failures=${failures} total=${totalMs}ms ` +
    `avg=${avgMs}ms max=${maxMs}ms ` +
    `health=${operations.health.requests} events=${operations.events.requests}`
  );
}

// ── Machine-readable service-level window report ─────────────────────────────

export const SERVICE_LEVEL_WINDOW_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SLI_WINDOW_MS = 3_600_000;
export const DEFAULT_SLI_MAX_SAMPLES = 256;

export type WindowIncompletenessReason =
  | "warming_up"
  | "sample_buffer_truncated"
  | "no_cycles_observed";

export interface DeliverySampleInput {
  ok: boolean;
  /** End-to-end delivery lag in ms, or null/undefined when ledger time is unavailable. */
  lagMs?: number | null;
  /** Sample timestamp in unix ms (defaults to the window's clock). */
  atMs?: number;
}

export interface CycleGapSampleInput {
  /** Whether a cursor retention gap / floor rewind occurred in this cycle. */
  gapDetected?: boolean;
  /** Ledgers missed below the RPC retention floor in this cycle. */
  missedLedgers?: number;
  /** Target scans stopped early by EVENT_MAX_PAGES in this cycle. */
  truncatedScans?: number;
  /** Failed target RPC scans in this cycle. */
  failedScans?: number;
  /** Sample timestamp in unix ms (defaults to the window's clock). */
  atMs?: number;
}

export interface ServiceLevelWindowReport {
  schemaVersion: typeof SERVICE_LEVEL_WINDOW_SCHEMA_VERSION;
  generatedAt: string;
  windowMs: number;
  observedDurationMs: number;
  /** Bounded `[0, 1]` fraction of `windowMs` covered by retained local history. */
  coverageRatio: number;
  /** False whenever the window is warming up, truncated by sample cap, or has 0 cycles. */
  complete: boolean;
  incompleteReasons: WindowIncompletenessReason[];
  sampleCapacity: number;
  indicators: {
    delivery: {
      attempts: number;
      succeeded: number;
      failed: number;
      successRatio: number | null;
    };
    lag: {
      samples: number;
      missingTimestampCount: number;
      minMs: number | null;
      p50Ms: number | null;
      p95Ms: number | null;
      maxMs: number | null;
    };
    dataGap: {
      cyclesObserved: number;
      gapEvents: number;
      missedLedgers: number;
      truncatedScans: number;
      failedScans: number;
      gapFree: boolean | null;
      healthyCycleRatio: number | null;
    };
  };
}

export interface ServiceLevelWindowOptions {
  /** Target rolling window duration in ms (default: 3_600_000 = 1h). */
  windowMs?: number;
  /** Maximum retained samples per ring buffer (default: 256). */
  maxSamples?: number;
  /** Clock returning unix milliseconds (default: `Date.now`). */
  clock?: () => number;
  /** Explicit observation start timestamp in unix ms (defaults to `clock()`). */
  startedAtMs?: number;
}

interface StoredDeliverySample {
  atMs: number;
  ok: boolean;
  lagMs: number | null;
}

interface StoredCycleSample {
  atMs: number;
  gapDetected: boolean;
  missedLedgers: number;
  truncatedScans: number;
  failedScans: number;
}

function roundRatio6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function nearestRankQuantile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return round(sorted[idx]!);
}

function validatePositiveIntOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; got ${String(value)}`);
  }
  return value;
}

function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Bounded in-memory service-level window calculator for delivery success,
 * notification lag, and chain data-gap indicators.
 *
 * All storage is capped at `maxSamples` entries per ring, contains zero message
 * bodies or credentials, and explicitly flags incomplete windows (`warming_up`,
 * `sample_buffer_truncated`, `no_cycles_observed`).
 */
export class ServiceLevelWindow {
  readonly windowMs: number;
  readonly maxSamples: number;
  private readonly clock: () => number;
  private readonly startedAtMs: number;
  private readonly deliveries: StoredDeliverySample[] = [];
  private readonly cycles: StoredCycleSample[] = [];
  private latestEvictedDeliveryAtMs: number | null = null;
  private latestEvictedCycleAtMs: number | null = null;

  constructor(options: ServiceLevelWindowOptions = {}) {
    this.windowMs = validatePositiveIntOption(
      options.windowMs,
      DEFAULT_SLI_WINDOW_MS,
      "windowMs",
    );
    this.maxSamples = validatePositiveIntOption(
      options.maxSamples,
      DEFAULT_SLI_MAX_SAMPLES,
      "maxSamples",
    );
    this.clock = options.clock ?? Date.now;
    const initStart = options.startedAtMs ?? this.clock();
    this.startedAtMs = Number.isFinite(initStart) ? initStart : 0;
  }

  private pruneExpired(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.deliveries.length > 0 && this.deliveries[0]!.atMs < cutoff) {
      this.deliveries.shift();
    }
    while (this.cycles.length > 0 && this.cycles[0]!.atMs < cutoff) {
      this.cycles.shift();
    }
  }

  recordDelivery(input: DeliverySampleInput): void {
    const rawAt = input.atMs ?? this.clock();
    const atMs = Number.isFinite(rawAt) ? rawAt : this.clock();
    this.pruneExpired(atMs);

    if (this.deliveries.length >= this.maxSamples) {
      const evicted = this.deliveries.shift()!;
      this.latestEvictedDeliveryAtMs =
        this.latestEvictedDeliveryAtMs === null
          ? evicted.atMs
          : Math.max(this.latestEvictedDeliveryAtMs, evicted.atMs);
    }

    const lagMs =
      typeof input.lagMs === "number" && Number.isFinite(input.lagMs) && input.lagMs >= 0
        ? input.lagMs
        : null;

    this.deliveries.push({
      atMs,
      ok: Boolean(input.ok),
      lagMs,
    });
  }

  recordCycle(input: CycleGapSampleInput = {}): void {
    const rawAt = input.atMs ?? this.clock();
    const atMs = Number.isFinite(rawAt) ? rawAt : this.clock();
    this.pruneExpired(atMs);

    if (this.cycles.length >= this.maxSamples) {
      const evicted = this.cycles.shift()!;
      this.latestEvictedCycleAtMs =
        this.latestEvictedCycleAtMs === null
          ? evicted.atMs
          : Math.max(this.latestEvictedCycleAtMs, evicted.atMs);
    }

    const missedLedgers = nonNegativeInt(input.missedLedgers);
    this.cycles.push({
      atMs,
      gapDetected: Boolean(input.gapDetected) || missedLedgers > 0,
      missedLedgers,
      truncatedScans: nonNegativeInt(input.truncatedScans),
      failedScans: nonNegativeInt(input.failedScans),
    });
  }

  report(nowMs?: number): ServiceLevelWindowReport {
    const rawNow = nowMs ?? this.clock();
    const currentMs = Number.isFinite(rawNow) ? rawNow : 0;
    const windowStartMs = currentMs - this.windowMs;

    const inWindowDeliveries = this.deliveries.filter(
      (d) => d.atMs >= windowStartMs && d.atMs <= currentMs,
    );
    const inWindowCycles = this.cycles.filter(
      (c) => c.atMs >= windowStartMs && c.atMs <= currentMs,
    );

    const observedDurationMs = Math.max(0, currentMs - this.startedAtMs);
    const deliveryTruncated =
      this.latestEvictedDeliveryAtMs !== null &&
      this.latestEvictedDeliveryAtMs >= windowStartMs;
    const cycleTruncated =
      this.latestEvictedCycleAtMs !== null &&
      this.latestEvictedCycleAtMs >= windowStartMs;

    const incompleteReasons: WindowIncompletenessReason[] = [];
    if (observedDurationMs < this.windowMs) {
      incompleteReasons.push("warming_up");
    }
    if (deliveryTruncated || cycleTruncated) {
      incompleteReasons.push("sample_buffer_truncated");
    }
    if (inWindowCycles.length === 0) {
      incompleteReasons.push("no_cycles_observed");
    }

    let effectiveStartMs = Math.max(windowStartMs, this.startedAtMs);
    if (deliveryTruncated && inWindowDeliveries.length > 0) {
      effectiveStartMs = Math.max(effectiveStartMs, inWindowDeliveries[0]!.atMs);
    }
    if (cycleTruncated && inWindowCycles.length > 0) {
      effectiveStartMs = Math.max(effectiveStartMs, inWindowCycles[0]!.atMs);
    }

    const coveredMs = Math.min(this.windowMs, Math.max(0, currentMs - effectiveStartMs));
    const coverageRatio = Math.min(1, Math.max(0, roundRatio6(coveredMs / this.windowMs)));

    const attempts = inWindowDeliveries.length;
    const succeeded = inWindowDeliveries.reduce((n, d) => n + (d.ok ? 1 : 0), 0);
    const failed = attempts - succeeded;
    const successRatio = attempts > 0 ? roundRatio6(succeeded / attempts) : null;

    const validLags = inWindowDeliveries
      .map((d) => d.lagMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const missingTimestampCount = attempts - validLags.length;

    const cyclesObserved = inWindowCycles.length;
    const gapEvents = inWindowCycles.reduce((n, c) => n + (c.gapDetected ? 1 : 0), 0);
    const missedLedgers = inWindowCycles.reduce((n, c) => n + c.missedLedgers, 0);
    const truncatedScans = inWindowCycles.reduce((n, c) => n + c.truncatedScans, 0);
    const failedScans = inWindowCycles.reduce((n, c) => n + c.failedScans, 0);
    const healthyCycles = inWindowCycles.reduce(
      (n, c) => n + (!c.gapDetected && c.missedLedgers === 0 && c.failedScans === 0 ? 1 : 0),
      0,
    );

    return {
      schemaVersion: SERVICE_LEVEL_WINDOW_SCHEMA_VERSION,
      generatedAt: new Date(currentMs).toISOString(),
      windowMs: this.windowMs,
      observedDurationMs,
      coverageRatio,
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      sampleCapacity: this.maxSamples,
      indicators: {
        delivery: {
          attempts,
          succeeded,
          failed,
          successRatio,
        },
        lag: {
          samples: validLags.length,
          missingTimestampCount,
          minMs: validLags.length > 0 ? round(validLags[0]!) : null,
          p50Ms: nearestRankQuantile(validLags, 0.5),
          p95Ms: nearestRankQuantile(validLags, 0.95),
          maxMs: validLags.length > 0 ? round(validLags[validLags.length - 1]!) : null,
        },
        dataGap: {
          cyclesObserved,
          gapEvents,
          missedLedgers,
          truncatedScans,
          failedScans,
          gapFree:
            cyclesObserved > 0
              ? gapEvents === 0 && missedLedgers === 0 && failedScans === 0
              : null,
          healthyCycleRatio:
            cyclesObserved > 0 ? roundRatio6(healthyCycles / cyclesObserved) : null,
        },
      },
    };
  }

  renderJson(nowMs?: number): string {
    return `${JSON.stringify(this.report(nowMs))}\n`;
  }
}
