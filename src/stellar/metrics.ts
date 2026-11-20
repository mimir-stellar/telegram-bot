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

import type { ContractSource } from "./decode.js";

export type RpcOperation = "health" | "events";

/** Supported target sources for RPC budget saturation measurements. */
export const KNOWN_TARGET_SOURCES: readonly ContractSource[] = ["market", "squad"] as const;

/**
 * Normalise a raw target identifier to a bounded, known target label.
 * Returns `"unknown"` if the target identifier is unbounded or not in the allowlist.
 */
export function normalizeTargetSource(raw: unknown): ContractSource | "unknown" {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "market") return "market";
  if (trimmed === "squad") return "squad";
  return "unknown";
}

/** Configuration options for tracking RPC budget saturation. */
export interface RpcBudgetOptions {
  /** Configured request budget limit per target across the fixed window. Defaults to 20. */
  budgetLimit?: number;
  /** Fixed sliding or reset window duration in milliseconds. Defaults to 60,000 (1 minute). */
  windowMs?: number;
  /** Injected clock for deterministic testing (defaults to Date.now). */
  now?: () => number;
}

/** Snapshot of RPC budget usage and saturation for one target. */
export interface RpcTargetBudgetSnapshot {
  target: ContractSource | "unknown";
  used: number;
  budget: number;
  /** Saturation ratio: used / budget (clamped at >= 0, rounded to 4 decimal places). */
  saturation: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/**
 * Tracks RPC request budget saturation per target over a fixed window.
 *
 * Guarantees:
 * - O(1) memory per target by pruning timestamps outside the fixed window.
 * - Bounded label space: target identifiers are strictly bounded to known targets
 *   or "unknown" to prevent high-cardinality label explosion in metric registries.
 * - Handles boundary cases: zero or negative budget (saturation clamped cleanly without NaN/Infinity),
 *   window rollovers, and empty usage.
 */
export class RpcBudgetSaturationTracker {
  private readonly budgetLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly requestsByTarget: Map<ContractSource | "unknown", number[]> = new Map();

  constructor(opts: RpcBudgetOptions = {}) {
    const rawBudget = opts.budgetLimit ?? 20;
    this.budgetLimit = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 0;
    const rawWindow = opts.windowMs ?? 60_000;
    this.windowMs = Number.isFinite(rawWindow) && rawWindow > 0 ? Math.floor(rawWindow) : 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record an RPC request consumed against a target's budget.
   * Target is bounded to prevent unbounded metric label cardinality.
   */
  record(rawTarget: unknown, count = 1): void {
    if (!Number.isFinite(count) || count <= 0) return;
    const target = normalizeTargetSource(rawTarget);
    const currentTime = this.now();
    let timestamps = this.requestsByTarget.get(target);
    if (!timestamps) {
      timestamps = [];
      this.requestsByTarget.set(target, timestamps);
    }
    for (let i = 0; i < Math.floor(count); i++) {
      timestamps.push(currentTime);
    }
    this.prune(target, currentTime);
  }

  /** Prune requests older than the fixed window. */
  private prune(target: ContractSource | "unknown", currentTime: number): void {
    const timestamps = this.requestsByTarget.get(target);
    if (!timestamps || timestamps.length === 0) return;
    const threshold = currentTime - this.windowMs;
    let keepFrom = 0;
    while (keepFrom < timestamps.length && (timestamps[keepFrom] ?? 0) <= threshold) {
      keepFrom++;
    }
    if (keepFrom > 0) {
      timestamps.splice(0, keepFrom);
    }
  }

  /** Get the used request count for a target in the current window. */
  getUsed(rawTarget: unknown): number {
    const target = normalizeTargetSource(rawTarget);
    const currentTime = this.now();
    this.prune(target, currentTime);
    return this.requestsByTarget.get(target)?.length ?? 0;
  }

  /** Get the snapshot of used, configured budget, and saturation for a target. */
  getSnapshot(rawTarget: unknown): RpcTargetBudgetSnapshot {
    const target = normalizeTargetSource(rawTarget);
    const used = this.getUsed(target);
    const budget = this.budgetLimit;
    let saturation = 0;
    if (budget > 0) {
      saturation = round(used / budget);
    } else {
      saturation = used > 0 ? 1 : 0;
    }
    return {
      target,
      used,
      budget,
      saturation,
      windowMs: this.windowMs,
    };
  }

  /** Get snapshots for all tracked known targets plus unknown if present. */
  getAllSnapshots(): RpcTargetBudgetSnapshot[] {
    const targets: Array<ContractSource | "unknown"> = [...KNOWN_TARGET_SOURCES];
    if (this.requestsByTarget.has("unknown")) {
      targets.push("unknown");
    }
    return targets.map((t) => this.getSnapshot(t));
  }

  /** Reset all tracked requests. */
  reset(): void {
    this.requestsByTarget.clear();
  }
}

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
