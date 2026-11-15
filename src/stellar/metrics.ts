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

// ── Per-target RPC request budget saturation ─────────────────────────────────

/**
 * Closed set of target labels permitted on RPC budget metrics.
 *
 * Raw contract IDs, RPC URLs, chat IDs, or caller-supplied strings are never
 * placed in Prometheus labels; anything outside the known operational targets
 * collapses to `"other"` so label cardinality is strictly bounded at <= 4.
 */
export type RpcBudgetTarget = "market" | "squad" | "health" | "other";

export const RPC_BUDGET_TARGETS: readonly RpcBudgetTarget[] = [
  "market",
  "squad",
  "health",
  "other",
] as const;

/** Default fixed measurement window for RPC budget tracking (60 seconds). */
export const DEFAULT_RPC_BUDGET_WINDOW_MS = 60_000;

/** Default request budget per target per fixed window. */
export const DEFAULT_RPC_TARGET_BUDGET = 40;

/** Normalize an arbitrary target identifier into the bounded {@link RpcBudgetTarget} set. */
export function normalizeRpcBudgetTarget(target: unknown): RpcBudgetTarget {
  if (typeof target !== "string") return "other";
  const normalized = target.trim().toLowerCase();
  if (normalized === "market" || normalized === "squad" || normalized === "health") {
    return normalized;
  }
  return "other";
}

export interface RpcTargetBudgetSnapshot {
  target: RpcBudgetTarget;
  /** Requests consumed in the active fixed window. */
  used: number;
  /** Configured request budget for this target over `windowMs`. */
  configured: number;
  /** Remaining requests in the active fixed window (`max(0, configured - used)`). */
  remaining: number;
  /** Bounded `[0, 1]` saturation ratio (`min(1, used / configured)`). */
  saturation: number;
  /** Cumulative requests recorded above `configured` across all windows. */
  exceededTotal: number;
  /** Fixed window length in milliseconds. */
  windowMs: number;
}

export interface RpcBudgetSnapshot {
  windowMs: number;
  targets: Record<RpcBudgetTarget, RpcTargetBudgetSnapshot>;
}

export interface RpcBudgetTrackerOptions {
  /** Fixed window duration in milliseconds (default: 60_000). */
  windowMs?: number;
  /** Default per-target request budget per window (default: 40). */
  defaultBudget?: number;
  /** Optional per-target budget overrides. */
  targetBudgets?: Partial<Record<RpcBudgetTarget, number>>;
  /** Monotonic millisecond clock (defaults to `performance.now()`). */
  clock?: () => number;
}

interface TargetWindowState {
  configured: number;
  used: number;
  exceededTotal: number;
  windowStartMs: number | null;
}

function sanitizePositiveInt(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new RangeError(`${label} must be a positive integer; got ${String(value)}`);
  }
  return value;
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Fixed-window per-target RPC request budget tracker.
 *
 * Keeps O(1) state per bounded target (`market`, `squad`, `health`, `other`),
 * advancing windows arithmetically without retaining per-request timestamps or
 * payloads.
 */
export class RpcBudgetTracker {
  readonly windowMs: number;
  private readonly clock: () => number;
  private readonly states: Record<RpcBudgetTarget, TargetWindowState>;
  private readonly activeTargets = new Set<RpcBudgetTarget>(["market", "squad"]);

  constructor(options: RpcBudgetTrackerOptions = {}) {
    this.windowMs = sanitizePositiveInt(
      options.windowMs,
      DEFAULT_RPC_BUDGET_WINDOW_MS,
      "windowMs",
    );
    const defaultBudget = sanitizePositiveInt(
      options.defaultBudget,
      DEFAULT_RPC_TARGET_BUDGET,
      "defaultBudget",
    );
    this.clock = options.clock ?? (() => performance.now());

    this.states = {
      market: {
        configured: sanitizePositiveInt(
          options.targetBudgets?.market,
          defaultBudget,
          "targetBudgets.market",
        ),
        used: 0,
        exceededTotal: 0,
        windowStartMs: null,
      },
      squad: {
        configured: sanitizePositiveInt(
          options.targetBudgets?.squad,
          defaultBudget,
          "targetBudgets.squad",
        ),
        used: 0,
        exceededTotal: 0,
        windowStartMs: null,
      },
      health: {
        configured: sanitizePositiveInt(
          options.targetBudgets?.health,
          defaultBudget,
          "targetBudgets.health",
        ),
        used: 0,
        exceededTotal: 0,
        windowStartMs: null,
      },
      other: {
        configured: sanitizePositiveInt(
          options.targetBudgets?.other,
          defaultBudget,
          "targetBudgets.other",
        ),
        used: 0,
        exceededTotal: 0,
        windowStartMs: null,
      },
    };

    if (options.targetBudgets?.health !== undefined) this.activeTargets.add("health");
    if (options.targetBudgets?.other !== undefined) this.activeTargets.add("other");
  }

  private advanceWindow(state: TargetWindowState, nowMs: number): void {
    const safeNow = Number.isFinite(nowMs) ? nowMs : this.clock();
    if (state.windowStartMs === null) {
      state.windowStartMs = safeNow;
      return;
    }
    const elapsed = safeNow - state.windowStartMs;
    if (elapsed >= this.windowMs) {
      const steps = Math.floor(elapsed / this.windowMs);
      state.windowStartMs += steps * this.windowMs;
      state.used = 0;
    }
  }

  /** Update the configured request budget for a bounded target. */
  configureTarget(target: unknown, configuredBudget: number): void {
    const key = normalizeRpcBudgetTarget(target);
    const sanitized = sanitizePositiveInt(configuredBudget, DEFAULT_RPC_TARGET_BUDGET, "budget");
    this.states[key].configured = sanitized;
    this.activeTargets.add(key);
  }

  /** Record `requests` (default 1) spent against `target` in the current window. */
  record(target: unknown, requests = 1, nowMs?: number): RpcTargetBudgetSnapshot {
    if (!Number.isFinite(requests) || requests < 0 || !Number.isInteger(requests)) {
      throw new RangeError(`RpcBudgetTracker.record requests must be a non-negative integer; got ${String(requests)}`);
    }
    const key = normalizeRpcBudgetTarget(target);
    this.activeTargets.add(key);
    const state = this.states[key];
    const timestamp = nowMs ?? this.clock();
    this.advanceWindow(state, timestamp);

    const prevOverflow = Math.max(0, state.used - state.configured);
    state.used += requests;
    const nextOverflow = Math.max(0, state.used - state.configured);
    if (nextOverflow > prevOverflow) {
      state.exceededTotal += nextOverflow - prevOverflow;
    }

    return this.buildTargetSnapshot(key);
  }

  /** Targets that are configured by default (`market`, `squad`) or have recorded activity. */
  trackedTargets(): RpcBudgetTarget[] {
    return RPC_BUDGET_TARGETS.filter((t) => this.activeTargets.has(t));
  }

  private buildTargetSnapshot(target: RpcBudgetTarget): RpcTargetBudgetSnapshot {
    const state = this.states[target];
    const remaining = Math.max(0, state.configured - state.used);
    const saturation =
      state.used <= 0 ? 0 : Math.min(1, roundRatio(state.used / state.configured));
    return {
      target,
      used: state.used,
      configured: state.configured,
      remaining,
      saturation,
      exceededTotal: state.exceededTotal,
      windowMs: this.windowMs,
    };
  }

  /** Snapshot all bounded targets at `nowMs` (rolling over expired windows first). */
  snapshot(nowMs?: number): RpcBudgetSnapshot {
    const timestamp = nowMs ?? this.clock();
    const targets = {} as Record<RpcBudgetTarget, RpcTargetBudgetSnapshot>;
    for (const key of RPC_BUDGET_TARGETS) {
      this.advanceWindow(this.states[key], timestamp);
      targets[key] = this.buildTargetSnapshot(key);
    }
    return {
      windowMs: this.windowMs,
      targets,
    };
  }
}

/** One-line, secret-free summary of per-target RPC budget usage. */
export function formatRpcBudget(snapshot: RpcBudgetSnapshot): string {
  const parts = (["market", "squad"] as const).map((t) => {
    const s = snapshot.targets[t];
    return `${t}=${s.used}/${s.configured}`;
  });
  return `rpc_budget window=${snapshot.windowMs}ms ${parts.join(" ")}`;
}
