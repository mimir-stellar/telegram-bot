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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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

// ── Versioned metrics reset marker ───────────────────────────────────────────

/** Schema version for persisted metrics reset markers. */
export const METRICS_RESET_MARKER_VERSION = 1 as const;

export const METRICS_RESET_REASONS = [
  "initial",
  "process_restart",
  "corrupt_state",
  "contract_changed",
  "manual_reset",
] as const;

export type MetricsResetReason = (typeof METRICS_RESET_REASONS)[number];

/**
 * Versioned marker persisted alongside retained operational counters so
 * operators and Prometheus scrapers can distinguish a process restart or
 * counter reset (`resetGeneration` increments) from a genuine chain activity
 * drop (`resetGeneration` remains constant while event rate is zero).
 */
export interface MetricsResetMarker {
  version: typeof METRICS_RESET_MARKER_VERSION;
  /** Monotonic generation incremented on every process boot or counter reset. */
  resetGeneration: number;
  /** Monotonic epoch incremented only when retained cumulative counters reset. */
  retainedEpoch: number;
  /** ISO-8601 timestamp of the latest boot/reset transition. */
  lastResetAt: string;
  /** Bounded machine-readable cause of the latest `resetGeneration` advance. */
  lastResetReason: MetricsResetReason;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isMetricsResetReason(value: unknown): value is MetricsResetReason {
  return (
    typeof value === "string" &&
    (METRICS_RESET_REASONS as readonly string[]).includes(value)
  );
}

/** Strict schema check for a persisted {@link MetricsResetMarker}. */
export function isValidMetricsResetMarker(value: unknown): value is MetricsResetMarker {
  if (!isPlainRecord(value)) return false;
  if (value.version !== METRICS_RESET_MARKER_VERSION) return false;
  if (!isPositiveSafeInt(value.resetGeneration)) return false;
  if (!isPositiveSafeInt(value.retainedEpoch)) return false;
  if (typeof value.lastResetAt !== "string" || value.lastResetAt.length === 0) return false;
  if (!isMetricsResetReason(value.lastResetReason)) return false;
  return true;
}

/** Parse and validate a standalone JSON reset marker file body. */
export function parseMetricsResetMarker(raw: string): MetricsResetMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("metrics reset marker root must be a JSON object");
  }
  if ("version" in parsed && parsed.version !== METRICS_RESET_MARKER_VERSION) {
    throw new Error(
      `metrics reset marker: unsupported schema version ${String(parsed.version)} ` +
        `(this build understands version ${METRICS_RESET_MARKER_VERSION})`,
    );
  }
  if (!isValidMetricsResetMarker(parsed)) {
    throw new Error("metrics reset marker failed schema validation");
  }
  return {
    version: METRICS_RESET_MARKER_VERSION,
    resetGeneration: parsed.resetGeneration,
    retainedEpoch: parsed.retainedEpoch,
    lastResetAt: parsed.lastResetAt,
    lastResetReason: parsed.lastResetReason,
  };
}

/**
 * Produce the next {@link MetricsResetMarker} for a startup or reset transition.
 *
 * - First boot (`previous == null`): starts at `resetGeneration: 1, retainedEpoch: 1`.
 * - Normal restart (`reason === "process_restart"`): increments `resetGeneration`
 *   while keeping `retainedEpoch` unchanged because retained counters survived.
 * - Counter-wiping transition (`"contract_changed" | "corrupt_state" | "manual_reset"`):
 *   increments both `resetGeneration` and `retainedEpoch`.
 */
export function advanceMetricsResetMarker(
  previous: MetricsResetMarker | null | undefined,
  reason: MetricsResetReason,
  nowMs: number = Date.now(),
): MetricsResetMarker {
  const iso = new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString();
  if (!previous || !isValidMetricsResetMarker(previous)) {
    const initialReason: MetricsResetReason =
      reason === "process_restart" ? "initial" : reason;
    return {
      version: METRICS_RESET_MARKER_VERSION,
      resetGeneration: 1,
      retainedEpoch: 1,
      lastResetAt: iso,
      lastResetReason: initialReason,
    };
  }

  const wipesRetained =
    reason === "contract_changed" ||
    reason === "corrupt_state" ||
    reason === "manual_reset";

  return {
    version: METRICS_RESET_MARKER_VERSION,
    resetGeneration: previous.resetGeneration + 1,
    retainedEpoch: wipesRetained ? previous.retainedEpoch + 1 : previous.retainedEpoch,
    lastResetAt: iso,
    lastResetReason: reason,
  };
}

/** Atomically write a {@link MetricsResetMarker} to disk (`write-then-rename`). */
export async function writeMetricsResetMarker(
  filePath: string,
  marker: MetricsResetMarker,
): Promise<boolean> {
  if (!isValidMetricsResetMarker(marker)) {
    throw new Error("cannot persist invalid MetricsResetMarker");
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load an existing reset marker file (if any), advance it for this boot or
 * reset reason, and persist the updated marker atomically. Corrupt or
 * unsupported files never block startup: they recover cleanly with
 * `lastResetReason: "corrupt_state"` and `corrupted: true`.
 */
export async function loadAndAdvanceMetricsResetMarker(
  filePath: string,
  options: {
    reason?: MetricsResetReason;
    now?: () => number;
  } = {},
): Promise<{ marker: MetricsResetMarker; corrupted: boolean; persisted: boolean }> {
  const nowFn = options.now ?? Date.now;
  let previous: MetricsResetMarker | null = null;
  let corrupted = false;
  let effectiveReason: MetricsResetReason = options.reason ?? "process_restart";

  try {
    const raw = await readFile(filePath, "utf8");
    try {
      previous = parseMetricsResetMarker(raw);
    } catch {
      corrupted = true;
      effectiveReason = "corrupt_state";
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      if (effectiveReason === "process_restart") {
        effectiveReason = "initial";
      }
    } else {
      corrupted = true;
      effectiveReason = "corrupt_state";
    }
  }

  const marker = advanceMetricsResetMarker(previous, effectiveReason, nowFn());
  const persisted = await writeMetricsResetMarker(filePath, marker);
  return { marker, corrupted, persisted };
}
