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

import type { Counter, Gauge, MetricsRegistry } from "../metrics.js";

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

/** Handles registered in a {@link MetricsRegistry} for Stellar RPC timing. */
export interface StellarRpcMetricHandles {
  healthRequests: Counter;
  healthFailures: Counter;
  eventsRequests: Counter;
  eventsFailures: Counter;
  maxDurationMs: Gauge;
  recordSummary(summary: RpcTimingSummary): void;
}

/**
 * Idempotently register Stellar RPC timing metrics into a {@link MetricsRegistry}.
 *
 * Calling this helper multiple times against the same registry returns the
 * existing metric handles without emitting duplicate `# HELP` or `# TYPE`
 * blocks. If any target metric name was already registered with a conflicting
 * `type` or `help` definition, the underlying `MetricRegistrationError` is
 * propagated before exposition can be corrupted.
 */
export function registerStellarRpcMetrics(
  registry: Pick<MetricsRegistry, "registerCounter" | "registerGauge">,
  prefix = "mimir_bot_stellar_rpc_",
): StellarRpcMetricHandles {
  const healthRequests = registry.registerCounter(
    `${prefix}health_requests_total`,
    "Total Soroban RPC getHealth requests recorded.",
  );
  const healthFailures = registry.registerCounter(
    `${prefix}health_failures_total`,
    "Total failed Soroban RPC getHealth requests recorded.",
  );
  const eventsRequests = registry.registerCounter(
    `${prefix}events_requests_total`,
    "Total Soroban RPC getEvents page requests recorded.",
  );
  const eventsFailures = registry.registerCounter(
    `${prefix}events_failures_total`,
    "Total failed Soroban RPC getEvents page requests recorded.",
  );
  const maxDurationMs = registry.registerGauge(
    `${prefix}max_duration_ms`,
    "Maximum single Soroban RPC request duration in milliseconds.",
  );

  return {
    healthRequests,
    healthFailures,
    eventsRequests,
    eventsFailures,
    maxDurationMs,
    recordSummary(summary: RpcTimingSummary): void {
      if (summary.operations.health.requests > 0) {
        healthRequests.inc(summary.operations.health.requests);
      }
      if (summary.operations.health.failures > 0) {
        healthFailures.inc(summary.operations.health.failures);
      }
      if (summary.operations.events.requests > 0) {
        eventsRequests.inc(summary.operations.events.requests);
      }
      if (summary.operations.events.failures > 0) {
        eventsFailures.inc(summary.operations.events.failures);
      }
      maxDurationMs.set(Math.max(maxDurationMs.value(), Math.round(summary.maxMs)));
    },
  };
}
