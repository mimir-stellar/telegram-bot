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
 * Observations can optionally be mirrored into a fixed-bucket latency
 * histogram. Its only series labels are a constant provider identity and the
 * bounded operation class (`health` / `events` / `other`); the configured RPC
 * URL — including any query string — is never a label.
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

/**
 * Stable identity for the one RPC endpoint configured for this process.
 *
 * It is intentionally a constant: `STELLAR_RPC_URL` can carry query strings or
 * operator-specific hosts, neither of which belongs in a metric label. Every
 * observation is attributed to this identity regardless of the URL used.
 */
export const RPC_PROVIDER_ID = "soroban-rpc" as const;
export type RpcProviderId = typeof RPC_PROVIDER_ID;

/** Bounded operation classes used by the latency histogram. */
export const RPC_LATENCY_OPERATIONS = ["health", "events", "other"] as const;
export type RpcLatencyOperation = (typeof RPC_LATENCY_OPERATIONS)[number];

/**
 * Finite upper bounds (ms) for RPC latency buckets. The final `+Inf` bucket is
 * emitted by the renderer, not stored here; times beyond 15s (the client's
 * request timeout) still count, they just land in `+Inf`.
 */
export const DEFAULT_RPC_LATENCY_BUCKETS_MS = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  5_000,
  15_000,
] as const;

/** Minimal sink for latency observations; implemented by {@link RpcLatencyHistogram}. */
export interface RpcLatencyObserver {
  observe(operation: unknown, durationMs: number): void;
}

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
  private readonly latency?: RpcLatencyObserver;

  /**
   * `clock` defaults to `performance.now()`; tests inject a deterministic
   * counter so aggregates are asserted exactly, with no real waiting. An
   * optional `latency` sink mirrors each observation into a bounded histogram.
   */
  constructor(clock: () => number = () => performance.now(), latency?: RpcLatencyObserver) {
    this.clock = clock;
    this.latency = latency;
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
    this.latency?.observe(operation, duration);
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

// ── Fixed-bucket RPC latency histogram ───────────────────────────────────────

/**
 * Validate histogram upper bounds: a non-empty, strictly increasing sequence
 * of positive finite integer milliseconds. Invalid bounds would produce
 * malformed Prometheus exposition, so they fail fast at construction time.
 */
export function validateFiniteLatencyBucketsMs(bucketsMs: readonly number[]): number[] {
  if (!Array.isArray(bucketsMs) || bucketsMs.length === 0) {
    throw new RangeError("Latency buckets must be a non-empty array of finite positive numbers");
  }
  const validated: number[] = [];
  let previous = 0;
  for (const raw of bucketsMs) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new RangeError("Latency bucket bound must be a finite positive number");
    }
    const bound = Math.round(raw);
    if (bound <= previous) {
      throw new RangeError("Latency bucket bounds must be strictly increasing positive integers");
    }
    validated.push(bound);
    previous = bound;
  }
  return validated;
}

/** Map any raw operation hint into the fixed, bounded label set. */
export function classifyRpcLatencyOperation(raw: unknown): RpcLatencyOperation {
  if (typeof raw !== "string") return "other";
  const operation = raw.trim().toLowerCase();
  return operation === "health" || operation === "events" ? operation : "other";
}

export interface RpcLatencyBucketSnapshot {
  operation: RpcLatencyOperation;
  /** Cumulative counts keyed by the finite upper bounds in the parent snapshot. */
  bucketCounts: number[];
  /** Total observations, including those above the last finite bound. */
  count: number;
  /** Sum of observed integer millisecond durations. */
  sumMs: number;
}

export interface RpcLatencySnapshot {
  /** Always {@link RPC_PROVIDER_ID}; never a URL, host, or query string. */
  provider: RpcProviderId;
  bucketsMs: number[];
  operations: Record<RpcLatencyOperation, RpcLatencyBucketSnapshot>;
}

/**
 * Fixed-bucket latency histogram for the single configured RPC provider.
 *
 * Label cardinality is constant: one provider identity and three operation
 * classes, with one cumulative counter per finite bucket plus `+Inf`. URLs and
 * other untrusted strings cannot become labels.
 */
export class RpcLatencyHistogram implements RpcLatencyObserver {
  readonly bucketsMs: readonly number[];
  private readonly states: Record<
    RpcLatencyOperation,
    { cumulativeBuckets: number[]; count: number; sumMs: number }
  >;

  constructor(bucketsMs: readonly number[] = DEFAULT_RPC_LATENCY_BUCKETS_MS) {
    this.bucketsMs = validateFiniteLatencyBucketsMs(bucketsMs);
    const states = {} as Record<
      RpcLatencyOperation,
      { cumulativeBuckets: number[]; count: number; sumMs: number }
    >;
    for (const operation of RPC_LATENCY_OPERATIONS) {
      states[operation] = {
        cumulativeBuckets: new Array<number>(this.bucketsMs.length).fill(0),
        count: 0,
        sumMs: 0,
      };
    }
    this.states = states;
  }

  /**
   * Record one duration in milliseconds. Non-finite and negative values are
   * clamped to zero (and still counted), matching {@link RpcTiming.record}, so
   * the histogram count never disagrees with the request counter.
   */
  observe(operationInput: unknown, durationMs: number): void {
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
        ? Math.round(durationMs)
        : 0;
    const operation = classifyRpcLatencyOperation(operationInput);
    const state = this.states[operation];
    state.count += 1;
    state.sumMs += duration;
    for (let i = 0; i < this.bucketsMs.length; i += 1) {
      if (duration <= this.bucketsMs[i]!) state.cumulativeBuckets[i]! += 1;
    }
  }

  snapshot(): RpcLatencySnapshot {
    const operations = {} as Record<RpcLatencyOperation, RpcLatencyBucketSnapshot>;
    for (const operation of RPC_LATENCY_OPERATIONS) {
      const state = this.states[operation];
      operations[operation] = {
        operation,
        bucketCounts: [...state.cumulativeBuckets],
        count: state.count,
        sumMs: state.sumMs,
      };
    }
    return { provider: RPC_PROVIDER_ID, bucketsMs: [...this.bucketsMs], operations };
  }

  renderPrometheusLines(
    metricName: string,
    help: string,
    staticLabels: Readonly<Record<string, string>> = {},
  ): string[] {
    return renderRpcLatencySnapshotLines(this.snapshot(), metricName, help, staticLabels);
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render a {@link RpcLatencySnapshot} as Prometheus v0.0.4 histogram lines
 * (`_bucket`, `_sum`, `_count`). The only partition labels are the fixed
 * provider identity and the bounded operation class.
 */
export function renderRpcLatencySnapshotLines(
  snapshot: RpcLatencySnapshot,
  metricName: string,
  help: string,
  staticLabels: Readonly<Record<string, string>> = {},
): string[] {
  const lines = [`# HELP ${metricName} ${help}`, `# TYPE ${metricName} histogram`];
  const staticPairs = Object.entries(staticLabels).map(
    ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
  );

  for (const operation of RPC_LATENCY_OPERATIONS) {
    const state = snapshot.operations[operation];
    if (!state) continue;
    const basePairs = [
      ...staticPairs,
      `provider="${escapeLabelValue(snapshot.provider)}"`,
      `operation="${operation}"`,
    ];
    for (let i = 0; i < snapshot.bucketsMs.length; i += 1) {
      const bound = snapshot.bucketsMs[i];
      if (bound === undefined) continue;
      const labels = [...basePairs, `le="${bound}"`].join(",");
      lines.push(`${metricName}_bucket{${labels}} ${state.bucketCounts[i] ?? 0}`);
    }
    lines.push(`${metricName}_bucket{${[...basePairs, 'le="+Inf"'].join(",")}} ${state.count}`);
    const series = basePairs.join(",");
    lines.push(`${metricName}_sum{${series}} ${state.sumMs}`);
    lines.push(`${metricName}_count{${series}} ${state.count}`);
  }

  return lines;
}
