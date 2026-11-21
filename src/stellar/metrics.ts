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
