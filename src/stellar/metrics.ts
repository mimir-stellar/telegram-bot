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

// ── End-to-end notification age (ledger close -> confirmed send) ──────────────

const MIN_PLAUSIBLE_LEDGER_MS = Date.UTC(2015, 0, 1);
const MAX_PLAUSIBLE_LEDGER_MS = Date.UTC(2100, 0, 1);

/** Default finite upper bounds (in ms) for end-to-end notification age: 1s..15m. */
export const DEFAULT_NOTIFICATION_AGE_BUCKETS_MS = [
  1_000,
  5_000,
  15_000,
  60_000,
  300_000,
  900_000,
] as const;

export interface NotificationIngressStamp {
  /** On-chain `ledgerClosedAt` Unix timestamp in seconds (`0` / `null` when absent). */
  ledgerClosedAtSeconds: number | null | undefined;
  /** Wall-clock Unix timestamp in ms when the event entered local notification handling. */
  ingestedWallMs: number;
  /** Monotonic timestamp in ms (`performance.now()`) when local handling began. */
  ingestedMonoMs: number;
}

export type NotificationAgeStatus = "recorded" | "missing_ledger_time" | "clock_skew";

export interface NotificationAgeObservation {
  status: NotificationAgeStatus;
  /** Monotonic elapsed duration (ms) from local ingestion to confirmed send (`>= 0`). */
  sendDurationMs: number;
  /** End-to-end age (ms) from ledger close to confirmed send, or `null` when unavailable. */
  endToEndAgeMs: number | null;
}

export interface EndToEndNotificationAgeSnapshot {
  bucketsMs: number[];
  bucketCounts: number[];
  /** Confirmed deliveries with a valid, non-skewed ledger close timestamp. */
  ageSamples: number;
  /** Confirmed deliveries with valid ledger time whose end-to-end age rounded to `0ms`. */
  zeroLagCount: number;
  /** Confirmed deliveries where `ledgerClosedAt` was absent (`0`/`null`) or implausible. */
  missingLedgerTimeCount: number;
  /** Confirmed deliveries where local ingestion wall clock preceded `ledgerClosedAt`. */
  clockSkewCount: number;
  /** Total confirmed deliveries observed across all outcomes. */
  confirmedDeliveries: number;
  /** Sum of valid end-to-end ages in integer milliseconds. */
  sumAgeMs: number;
  /** Most recent valid end-to-end age in ms (`0` for zero lag, `null` when none recorded). */
  lastAgeMs: number | null;
  /** Minimum valid end-to-end age in ms, or `null` when `ageSamples === 0`. */
  minAgeMs: number | null;
  /** Maximum valid end-to-end age in ms, or `null` when `ageSamples === 0`. */
  maxAgeMs: number | null;
  /** Cumulative monotonic in-process send duration in integer milliseconds. */
  sendDurationSumMs: number;
  /** Monotonic in-process send duration of the latest confirmed delivery, or `null`. */
  lastSendDurationMs: number | null;
  /** Maximum monotonic in-process send duration across confirmed deliveries, or `null`. */
  maxSendDurationMs: number | null;
}

export interface EndToEndNotificationAgeOptions {
  wallClock?: () => number;
  monotonicClock?: () => number;
  bucketsMs?: readonly number[];
}

function validateAgeBucketsMs(bucketsMs: readonly number[]): number[] {
  if (!Array.isArray(bucketsMs) || bucketsMs.length === 0) {
    throw new RangeError("Notification age bucketsMs must be a non-empty array of positive numbers");
  }
  const out: number[] = [];
  let prev = 0;
  for (const raw of bucketsMs) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new RangeError(`Notification age bucket must be finite and > 0; got ${String(raw)}`);
    }
    const bound = Math.round(raw);
    if (bound <= 0 || bound <= prev) {
      throw new RangeError(
        `Notification age buckets must be strictly increasing positive integers; got ${String(raw)}`,
      );
    }
    out.push(bound);
    prev = bound;
  }
  return out;
}

/**
 * Tracks end-to-end notification age from on-chain ledger close time to
 * confirmed Telegram delivery:
 *  - Measures in-process queuing/retry/send duration via a monotonic clock so
 *    wall-clock / NTP adjustments mid-batch cannot corrupt elapsed durations.
 *  - Keeps missing ledger close times (`at === 0` / `null`) and negative
 *    wall-clock skew explicitly separate from genuine `0ms` delivery lag.
 */
export class EndToEndNotificationAgeTracker {
  readonly bucketsMs: readonly number[];
  private readonly wallClock: () => number;
  private readonly monotonicClock: () => number;
  private readonly cumulativeBuckets: number[];
  private ageSamples = 0;
  private zeroLagCount = 0;
  private missingLedgerTimeCount = 0;
  private clockSkewCount = 0;
  private confirmedDeliveries = 0;
  private sumAgeMs = 0;
  private lastAgeMs: number | null = null;
  private minAgeMs: number | null = null;
  private maxAgeMs: number | null = null;
  private sendDurationSumMs = 0;
  private lastSendDurationMs: number | null = null;
  private maxSendDurationMs: number | null = null;

  constructor(options: EndToEndNotificationAgeOptions = {}) {
    this.bucketsMs = validateAgeBucketsMs(options.bucketsMs ?? DEFAULT_NOTIFICATION_AGE_BUCKETS_MS);
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.cumulativeBuckets = new Array<number>(this.bucketsMs.length).fill(0);
  }

  /** Capture wall-clock and monotonic timestamps when an event enters local delivery. */
  begin(
    ledgerClosedAtSeconds: number | null | undefined,
    ingestedWallMs: number = this.wallClock(),
    ingestedMonoMs: number = this.monotonicClock(),
  ): NotificationIngressStamp {
    return {
      ledgerClosedAtSeconds,
      ingestedWallMs,
      ingestedMonoMs,
    };
  }

  /** Record a confirmed Telegram send against its ingress stamp. */
  confirm(
    stamp: NotificationIngressStamp,
    confirmedMonoMs: number = this.monotonicClock(),
  ): NotificationAgeObservation {
    const rawMonoDelta = confirmedMonoMs - stamp.ingestedMonoMs;
    const sendDurationMs =
      Number.isFinite(rawMonoDelta) && rawMonoDelta > 0 ? Math.round(rawMonoDelta) : 0;

    this.confirmedDeliveries += 1;
    this.sendDurationSumMs += sendDurationMs;
    this.lastSendDurationMs = sendDurationMs;
    this.maxSendDurationMs =
      this.maxSendDurationMs === null
        ? sendDurationMs
        : Math.max(this.maxSendDurationMs, sendDurationMs);

    if (
      typeof stamp.ledgerClosedAtSeconds !== "number" ||
      !Number.isFinite(stamp.ledgerClosedAtSeconds) ||
      stamp.ledgerClosedAtSeconds <= 0
    ) {
      this.missingLedgerTimeCount += 1;
      return { status: "missing_ledger_time", sendDurationMs, endToEndAgeMs: null };
    }

    const ledgerClosedMs = stamp.ledgerClosedAtSeconds * 1_000;
    if (
      !Number.isFinite(ledgerClosedMs) ||
      ledgerClosedMs < MIN_PLAUSIBLE_LEDGER_MS ||
      ledgerClosedMs > MAX_PLAUSIBLE_LEDGER_MS
    ) {
      this.missingLedgerTimeCount += 1;
      return { status: "missing_ledger_time", sendDurationMs, endToEndAgeMs: null };
    }

    if (typeof stamp.ingestedWallMs !== "number" || !Number.isFinite(stamp.ingestedWallMs)) {
      this.clockSkewCount += 1;
      return { status: "clock_skew", sendDurationMs, endToEndAgeMs: null };
    }

    const chainToIngestMs = stamp.ingestedWallMs - ledgerClosedMs;
    if (chainToIngestMs < 0) {
      this.clockSkewCount += 1;
      return { status: "clock_skew", sendDurationMs, endToEndAgeMs: null };
    }

    const endToEndAgeMs = Math.round(chainToIngestMs + sendDurationMs);
    this.ageSamples += 1;
    if (endToEndAgeMs === 0) {
      this.zeroLagCount += 1;
    }
    this.sumAgeMs += endToEndAgeMs;
    this.lastAgeMs = endToEndAgeMs;
    this.minAgeMs =
      this.minAgeMs === null ? endToEndAgeMs : Math.min(this.minAgeMs, endToEndAgeMs);
    this.maxAgeMs =
      this.maxAgeMs === null ? endToEndAgeMs : Math.max(this.maxAgeMs, endToEndAgeMs);

    for (let i = 0; i < this.bucketsMs.length; i += 1) {
      if (endToEndAgeMs <= this.bucketsMs[i]!) {
        this.cumulativeBuckets[i]! += 1;
      }
    }

    return { status: "recorded", sendDurationMs, endToEndAgeMs };
  }

  snapshot(): EndToEndNotificationAgeSnapshot {
    return {
      bucketsMs: [...this.bucketsMs],
      bucketCounts: [...this.cumulativeBuckets],
      ageSamples: this.ageSamples,
      zeroLagCount: this.zeroLagCount,
      missingLedgerTimeCount: this.missingLedgerTimeCount,
      clockSkewCount: this.clockSkewCount,
      confirmedDeliveries: this.confirmedDeliveries,
      sumAgeMs: this.sumAgeMs,
      lastAgeMs: this.lastAgeMs,
      minAgeMs: this.minAgeMs,
      maxAgeMs: this.maxAgeMs,
      sendDurationSumMs: this.sendDurationSumMs,
      lastSendDurationMs: this.lastSendDurationMs,
      maxSendDurationMs: this.maxSendDurationMs,
    };
  }

  renderPrometheusLines(
    metricPrefix: string,
    staticLabels: Readonly<Record<string, string>> = {},
  ): string[] {
    return renderNotificationAgeSnapshotLines(this.snapshot(), metricPrefix, staticLabels);
  }
}

/**
 * Render Prometheus v0.0.4 histogram, counter, and optional gauge lines for an
 * {@link EndToEndNotificationAgeSnapshot}.
 */
export function renderNotificationAgeSnapshotLines(
  snapshot: EndToEndNotificationAgeSnapshot,
  metricPrefix: string,
  staticLabels: Readonly<Record<string, string>> = {},
): string[] {
  const staticPairs = Object.entries(staticLabels).map(([k, v]) => `${k}="${v}"`);
  const baseLabelBlock = staticPairs.length > 0 ? `{${staticPairs.join(",")}}` : "";
  const histName = `${metricPrefix}notification_end_to_end_age_ms`;
  const missingName = `${metricPrefix}notification_missing_ledger_time_total`;
  const skewName = `${metricPrefix}notification_age_clock_skew_total`;
  const zeroLagName = `${metricPrefix}notification_zero_lag_total`;
  const sendDurName = `${metricPrefix}notification_send_duration_ms_total`;

  const lines: string[] = [
    `# HELP ${histName} End-to-end notification age in milliseconds from ledger close time to confirmed send.`,
    `# TYPE ${histName} histogram`,
  ];

  for (let i = 0; i < snapshot.bucketsMs.length; i += 1) {
    const bound = snapshot.bucketsMs[i]!;
    const bucketLabels = `{${[...staticPairs, `le="${bound}"`].join(",")}}`;
    lines.push(`${histName}_bucket${bucketLabels} ${snapshot.bucketCounts[i] ?? 0}`);
  }
  const infLabels = `{${[...staticPairs, `le="+Inf"`].join(",")}}`;
  lines.push(`${histName}_bucket${infLabels} ${snapshot.ageSamples}`);
  lines.push(`${histName}_sum${baseLabelBlock} ${snapshot.sumAgeMs}`);
  lines.push(`${histName}_count${baseLabelBlock} ${snapshot.ageSamples}`);

  lines.push(
    `# HELP ${missingName} Confirmed notifications whose on-chain event omitted a plausible ledger close time.`,
    `# TYPE ${missingName} counter`,
    `${missingName}${baseLabelBlock} ${snapshot.missingLedgerTimeCount}`,
    `# HELP ${skewName} Confirmed notifications excluded from age stats because ingestion wall clock preceded ledger close time.`,
    `# TYPE ${skewName} counter`,
    `${skewName}${baseLabelBlock} ${snapshot.clockSkewCount}`,
    `# HELP ${zeroLagName} Confirmed notifications with a valid ledger close time and zero millisecond end-to-end age.`,
    `# TYPE ${zeroLagName} counter`,
    `${zeroLagName}${baseLabelBlock} ${snapshot.zeroLagCount}`,
    `# HELP ${sendDurName} Cumulative monotonic in-process send duration in milliseconds across confirmed notifications.`,
    `# TYPE ${sendDurName} counter`,
    `${sendDurName}${baseLabelBlock} ${snapshot.sendDurationSumMs}`,
  );

  if (snapshot.lastAgeMs !== null && snapshot.maxAgeMs !== null) {
    const lastAgeName = `${metricPrefix}notification_last_age_ms`;
    const maxAgeName = `${metricPrefix}notification_max_age_ms`;
    lines.push(
      `# HELP ${lastAgeName} Most recent valid end-to-end notification age in milliseconds.`,
      `# TYPE ${lastAgeName} gauge`,
      `${lastAgeName}${baseLabelBlock} ${snapshot.lastAgeMs}`,
      `# HELP ${maxAgeName} Maximum valid end-to-end notification age in milliseconds since process start.`,
      `# TYPE ${maxAgeName} gauge`,
      `${maxAgeName}${baseLabelBlock} ${snapshot.maxAgeMs}`,
    );
  }

  return lines;
}
