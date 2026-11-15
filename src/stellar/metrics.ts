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

// ── Filtered events vs. delivery attempts / failures ─────────────────────────

/**
 * Closed set of intentional event-filtering reasons.
 *
 * Keeping this set bounded prevents dynamic contract event names, user-supplied
 * category strings, or untrusted payloads from becoming Prometheus label values.
 */
export type EventFilterReason =
  | "feature_flag"
  | "category_filter"
  | "admin_event"
  | "unformatted"
  | "other";

export const EVENT_FILTER_REASONS: readonly EventFilterReason[] = [
  "feature_flag",
  "category_filter",
  "admin_event",
  "unformatted",
  "other",
] as const;

const EVENT_FILTER_REASON_SET = new Set<string>(EVENT_FILTER_REASONS);

/** Normalize an arbitrary filter reason into the bounded {@link EventFilterReason} set. */
export function normalizeEventFilterReason(reason: unknown): EventFilterReason {
  if (typeof reason !== "string") return "other";
  const normalized = reason.trim().toLowerCase();
  return EVENT_FILTER_REASON_SET.has(normalized)
    ? (normalized as EventFilterReason)
    : "other";
}

export function emptyEventFilterCounts(): Record<EventFilterReason, number> {
  return {
    feature_flag: 0,
    category_filter: 0,
    admin_event: 0,
    unformatted: 0,
    other: 0,
  };
}

export interface DeliveryOutcomeSnapshot {
  /** Counts of intentionally suppressed events keyed by bounded reason. */
  filteredByReason: Record<EventFilterReason, number>;
  /** Sum across all `filteredByReason` buckets (excluded from `deliveryAttempts`). */
  filteredTotal: number;
  /** Total actual delivery attempts (`deliverySucceeded + deliveryFailed`). */
  deliveryAttempts: number;
  /** Successful deliveries. */
  deliverySucceeded: number;
  /** Exhausted failed deliveries. */
  deliveryFailed: number;
  /**
   * Delivery failure rate `deliveryFailed / deliveryAttempts` rounded to 6
   * decimals, or `null` when `deliveryAttempts === 0`. Intentionally filtered
   * events never enter the numerator or denominator.
   */
  failureRate: number | null;
}

function assertNonNegativeDelta(delta: number, label: string): void {
  if (!Number.isFinite(delta) || delta < 0) {
    throw new RangeError(`${label} delta must be a finite number >= 0; got ${String(delta)}`);
  }
}

/**
 * Tracks intentionally filtered events separately from actual delivery attempts
 * and failures so filtered traffic never distorts the delivery failure-rate
 * denominator.
 */
export class DeliveryOutcomeTracker {
  private readonly filtered: Record<EventFilterReason, number> = emptyEventFilterCounts();
  private succeeded = 0;
  private failed = 0;

  recordFiltered(reason: unknown, delta = 1): void {
    assertNonNegativeDelta(delta, "recordFiltered");
    const key = normalizeEventFilterReason(reason);
    this.filtered[key] += delta;
  }

  recordDeliverySuccess(delta = 1): void {
    assertNonNegativeDelta(delta, "recordDeliverySuccess");
    this.succeeded += delta;
  }

  recordDeliveryFailure(delta = 1): void {
    assertNonNegativeDelta(delta, "recordDeliveryFailure");
    this.failed += delta;
  }

  filteredValue(reason?: unknown): number {
    if (reason === undefined) {
      return EVENT_FILTER_REASONS.reduce((sum, key) => sum + this.filtered[key], 0);
    }
    return this.filtered[normalizeEventFilterReason(reason)];
  }

  filteredReasons(): Record<EventFilterReason, number> {
    return { ...this.filtered };
  }

  attempts(): number {
    return this.succeeded + this.failed;
  }

  failureRate(): number | null {
    const totalAttempts = this.attempts();
    if (totalAttempts === 0) return null;
    return Math.round((this.failed / totalAttempts) * 1_000_000) / 1_000_000;
  }

  snapshot(): DeliveryOutcomeSnapshot {
    const filteredByReason = this.filteredReasons();
    const filteredTotal = this.filteredValue();
    const deliveryAttempts = this.attempts();
    return {
      filteredByReason,
      filteredTotal,
      deliveryAttempts,
      deliverySucceeded: this.succeeded,
      deliveryFailed: this.failed,
      failureRate: this.failureRate(),
    };
  }
}
