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

// ── Fixed-bucket pending delivery queue age histogram ────────────────────────

/** Bounded, low-cardinality destination classes (never chat IDs or event IDs). */
export const DELIVERY_DESTINATION_CLASSES = ["market", "squad", "default"] as const;

export type DeliveryDestinationClass = (typeof DELIVERY_DESTINATION_CLASSES)[number];

/**
 * Default finite upper bounds (in milliseconds) for pending delivery queue age:
 * 1s, 5s, 15s, 1m, 5m, 15m, 1h.
 */
export const DEFAULT_PENDING_QUEUE_AGE_BUCKETS_MS = [
  1_000,
  5_000,
  15_000,
  60_000,
  300_000,
  900_000,
  3_600_000,
] as const;

/**
 * Map any raw destination hint to a bounded {@link DeliveryDestinationClass}.
 * Raw Telegram chat IDs (`-100...`), `@channel` handles, event IDs (`1000-1`),
 * and contract addresses collapse deterministically to `"default"`.
 */
export function classifyDeliveryDestination(raw: unknown): DeliveryDestinationClass {
  if (typeof raw !== "string") return "default";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "market") return "market";
  if (normalized === "squad") return "squad";
  return "default";
}

/**
 * Validate that histogram bucket upper bounds are a non-empty, strictly
 * increasing sequence of positive finite integers.
 */
export function validateFiniteBucketsMs(bucketsMs: readonly number[]): number[] {
  if (!Array.isArray(bucketsMs) || bucketsMs.length === 0) {
    throw new RangeError("Histogram bucketsMs must be a non-empty array of finite positive numbers");
  }
  const out: number[] = [];
  let prev = 0;
  for (const raw of bucketsMs) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new RangeError(`Histogram bucket bound must be a finite positive number; got ${String(raw)}`);
    }
    const bound = Math.round(raw);
    if (bound <= 0 || bound <= prev) {
      throw new RangeError(
        `Histogram bucket bounds must be strictly increasing positive integers; got ${String(raw)} after ${prev}`,
      );
    }
    out.push(bound);
    prev = bound;
  }
  return out;
}

export interface DestinationAgeHistogramSnapshot {
  destination: DeliveryDestinationClass;
  /** Cumulative counts keyed by finite upper bound (same length as `bucketsMs`). */
  bucketCounts: number[];
  /** Total observations (`+Inf` bucket). */
  count: number;
  /** Sum of observed integer millisecond ages. */
  sumMs: number;
}

export interface PendingDeliveryAgeSnapshot {
  bucketsMs: number[];
  destinations: Record<DeliveryDestinationClass, DestinationAgeHistogramSnapshot>;
}

/**
 * Fixed-bucket queue age histogram partitioned strictly by bounded
 * {@link DeliveryDestinationClass} (`market`, `squad`, `default`).
 */
export class PendingDeliveryAgeHistogram {
  readonly bucketsMs: readonly number[];
  private readonly states: Record<
    DeliveryDestinationClass,
    { cumulativeBuckets: number[]; count: number; sumMs: number }
  >;

  constructor(bucketsMs: readonly number[] = DEFAULT_PENDING_QUEUE_AGE_BUCKETS_MS) {
    const validated = validateFiniteBucketsMs(bucketsMs);
    this.bucketsMs = validated;
    this.states = {
      market: { cumulativeBuckets: new Array<number>(validated.length).fill(0), count: 0, sumMs: 0 },
      squad: { cumulativeBuckets: new Array<number>(validated.length).fill(0), count: 0, sumMs: 0 },
      default: { cumulativeBuckets: new Array<number>(validated.length).fill(0), count: 0, sumMs: 0 },
    };
  }

  /**
   * Record one pending delivery's queue age in milliseconds. Non-finite values
   * are ignored; negative skew is clamped to `0`.
   */
  observe(destinationInput: unknown, ageMs: number): void {
    if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return;
    const normalizedAgeMs = ageMs > 0 ? Math.round(ageMs) : 0;
    const dest = classifyDeliveryDestination(destinationInput);
    const state = this.states[dest];
    state.count += 1;
    state.sumMs += normalizedAgeMs;
    for (let i = 0; i < this.bucketsMs.length; i += 1) {
      if (normalizedAgeMs <= this.bucketsMs[i]!) {
        state.cumulativeBuckets[i]! += 1;
      }
    }
  }

  snapshot(): PendingDeliveryAgeSnapshot {
    const destinations = {} as Record<DeliveryDestinationClass, DestinationAgeHistogramSnapshot>;
    for (const dest of DELIVERY_DESTINATION_CLASSES) {
      const s = this.states[dest];
      destinations[dest] = {
        destination: dest,
        bucketCounts: [...s.cumulativeBuckets],
        count: s.count,
        sumMs: s.sumMs,
      };
    }
    return {
      bucketsMs: [...this.bucketsMs],
      destinations,
    };
  }

  /**
   * Render Prometheus v0.0.4 histogram lines (`_bucket`, `_sum`, `_count`) for
   * `metricName`, optionally including validated static labels (such as `network`).
   */
  renderPrometheusLines(
    metricName: string,
    help: string,
    staticLabels: Readonly<Record<string, string>> = {},
  ): string[] {
    return renderPendingAgeSnapshotLines(this.snapshot(), metricName, help, staticLabels);
  }
}

/**
 * Render Prometheus v0.0.4 histogram lines (`_bucket`, `_sum`, `_count`) from a
 * {@link PendingDeliveryAgeSnapshot} without retaining raw message or destination IDs.
 */
export function renderPendingAgeSnapshotLines(
  snapshot: PendingDeliveryAgeSnapshot,
  metricName: string,
  help: string,
  staticLabels: Readonly<Record<string, string>> = {},
): string[] {
  const lines: string[] = [
    `# HELP ${metricName} ${help}`,
    `# TYPE ${metricName} histogram`,
  ];
  const staticPairs = Object.entries(staticLabels).map(([k, v]) => `${k}="${v}"`);

  for (const dest of DELIVERY_DESTINATION_CLASSES) {
    const state = snapshot.destinations[dest];
    const basePairs = [...staticPairs, `destination="${dest}"`];
    for (let i = 0; i < snapshot.bucketsMs.length; i += 1) {
      const bound = snapshot.bucketsMs[i]!;
      const labelBlock = `{${[...basePairs, `le="${bound}"`].join(",")}}`;
      lines.push(`${metricName}_bucket${labelBlock} ${state.bucketCounts[i] ?? 0}`);
    }
    const infLabelBlock = `{${[...basePairs, `le="+Inf"`].join(",")}}`;
    lines.push(`${metricName}_bucket${infLabelBlock} ${state.count}`);
    const seriesLabelBlock = `{${basePairs.join(",")}}`;
    lines.push(`${metricName}_sum${seriesLabelBlock} ${state.sumMs}`);
    lines.push(`${metricName}_count${seriesLabelBlock} ${state.count}`);
  }

  return lines;
}

/**
 * Compute a point-in-time fixed-bucket age snapshot over currently queued items
 * using only `source` and `enqueuedAt` (never reading message bodies, chat IDs,
 * or event IDs).
 */
export function buildPendingQueueAgeSnapshot(
  items: ReadonlyArray<{ source?: unknown; enqueuedAt: string | number }>,
  nowMs: number = Date.now(),
  bucketsMs: readonly number[] = DEFAULT_PENDING_QUEUE_AGE_BUCKETS_MS,
): PendingDeliveryAgeSnapshot {
  const hist = new PendingDeliveryAgeHistogram(bucketsMs);
  const currentMs = Number.isFinite(nowMs) ? nowMs : 0;
  for (const item of items) {
    const rawTs =
      typeof item.enqueuedAt === "number" ? item.enqueuedAt : Date.parse(String(item.enqueuedAt));
    if (!Number.isFinite(rawTs)) continue;
    const ageMs = Math.max(0, currentMs - rawTs);
    hist.observe(item.source, ageMs);
  }
  return hist.snapshot();
}
