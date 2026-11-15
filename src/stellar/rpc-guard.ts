/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import type { rpc } from "@stellar/stellar-sdk";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

export type RpcGuardProblem =
  | "not-an-object"
  | "events-not-an-array"
  | "events-oversized"
  | "cursor-invalid"
  | "latest-ledger-invalid"
  | "event-not-an-object"
  | "event-missing-id"
  | "event-missing-ledger";

/**
 * Error thrown when an RPC response fails structural validation.
 *
 * Messages are strictly bounded and never echo raw response payloads.
 */
export class RpcResponseShapeError extends Error {
  readonly problem: RpcGuardProblem;

  constructor(problem: RpcGuardProblem, message: string) {
    super(message);
    this.name = "RpcResponseShapeError";
    this.problem = problem;
  }
}

export interface AssertEventsResponseOptions {
  /**
   * Maximum allowed items in `events`.
   * Defaults to {@link DEFAULT_MAX_EVENTS_PER_RESPONSE}.
   */
  maxEvents?: number | undefined;
}

/** Check if a value is a non-null plain record/object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check if a ledger is a valid non-negative safe integer. */
function isValidLedger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the structure of a `getEvents` RPC response.
 *
 * Validates:
 * - Top-level value is a non-null object.
 * - `events` is an array whose length does not exceed `maxEvents`.
 * - `cursor` is a string (or undefined/null if omitted by endpoint).
 * - `latestLedger` is a valid non-negative integer (or undefined/null if omitted).
 * - Every event in `events` is an object with an `id` string and a valid `ledger` number.
 *
 * @param value The raw response value to validate.
 * @param options Optional configuration including `maxEvents`.
 * @returns The typed `rpc.Api.GetEventsResponse`.
 * @throws {RpcResponseShapeError} Bounded error if validation fails.
 */
export function assertEventsResponse(
  value: unknown,
  options: AssertEventsResponseOptions = {},
): rpc.Api.GetEventsResponse {
  if (!isRecord(value)) {
    throw new RpcResponseShapeError(
      "not-an-object",
      `RPC getEvents response must be an object; got ${value === null ? "null" : typeof value}`,
    );
  }

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_RESPONSE;
  const events = value.events;

  if (!Array.isArray(events)) {
    throw new RpcResponseShapeError(
      "events-not-an-array",
      `RPC getEvents response "events" field must be an array; got ${events === null ? "null" : typeof events}`,
    );
  }

  if (events.length > maxEvents) {
    throw new RpcResponseShapeError(
      "events-oversized",
      `RPC getEvents response contains ${events.length} events, exceeding cap of ${maxEvents}`,
    );
  }

  const cursor = value.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new RpcResponseShapeError(
      "cursor-invalid",
      `RPC getEvents response "cursor" must be a string; got ${typeof cursor}`,
    );
  }

  const latestLedger = value.latestLedger;
  if (latestLedger !== undefined && latestLedger !== null && !isValidLedger(latestLedger)) {
    throw new RpcResponseShapeError(
      "latest-ledger-invalid",
      `RPC getEvents response "latestLedger" must be a valid non-negative integer; got ${typeof latestLedger}`,
    );
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!isRecord(ev)) {
      throw new RpcResponseShapeError(
        "event-not-an-object",
        `RPC getEvents event at index ${i} must be an object; got ${ev === null ? "null" : typeof ev}`,
      );
    }

    if (typeof ev.id !== "string" || ev.id.length === 0) {
      throw new RpcResponseShapeError(
        "event-missing-id",
        `RPC getEvents event at index ${i} is missing a valid string id`,
      );
    }

    if (!isValidLedger(ev.ledger)) {
      throw new RpcResponseShapeError(
        "event-missing-ledger",
        `RPC getEvents event at index ${i} is missing a valid non-negative ledger`,
      );
    }
  }

  return value as unknown as rpc.Api.GetEventsResponse;
}

// ── Bounded per-provider RPC latency histograms ──────────────────────────────
//
// Provider URLs configured by operators or discovery helpers may carry API key
// paths, query strings, fragments, or credentials. Exposing raw URLs as metric
// labels leaks secrets and creates unbounded label cardinality.
//
// `canonicalRpcProviderId` reduces any HTTP(S) RPC URL to its lowercase origin
// (`scheme://host[:port]`) — stripping credentials, paths, query strings, and
// fragments — and `RpcProviderLatencyHistograms` enforces both finite latency
// buckets and a fixed cap on distinct provider identities (overflow -> "other").

/** Default finite latency histogram upper bounds in milliseconds. */
export const DEFAULT_RPC_LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000,
]);

/** Maximum finite bucket count accepted for an RPC latency histogram. */
export const MAX_RPC_LATENCY_BUCKETS = 32;

/** Default maximum distinct RPC provider identities tracked before collapsing to `"other"`. */
export const DEFAULT_MAX_RPC_HISTOGRAM_PROVIDERS = 8;

/** Fixed fallback label used when provider cardinality reaches `maxProviders` or falls outside `allowedProviders`. */
export const OVERFLOW_RPC_PROVIDER_ID = "other";

/** Fixed fallback label used when a provider URL cannot be parsed as a safe HTTP(S) origin. */
export const INVALID_RPC_PROVIDER_ID = "invalid";

/** Maximum length accepted for a canonical provider origin label. */
const MAX_PROVIDER_ORIGIN_LENGTH = 128;

/** Finite set of Soroban RPC operations tracked in latency histograms. */
export type RpcHistogramOperation = "health" | "events" | "network";

const VALID_HISTOGRAM_OPERATIONS: ReadonlySet<string> = new Set<RpcHistogramOperation>([
  "health",
  "events",
  "network",
]);

/**
 * Derive a fixed, credential-free, query-free provider identity from an RPC URL.
 *
 * - Accepts only `http:` and `https:` URLs.
 * - Strips username, password, path segments, query strings, and fragments.
 * - Normalizes scheme and hostname to lowercase and omits default ports (`:80`, `:443`).
 * - Returns {@link INVALID_RPC_PROVIDER_ID} (`"invalid"`) for malformed, non-HTTP(S),
 *   or oversized inputs so raw untrusted strings never reach metric labels.
 */
export function canonicalRpcProviderId(rawUrl: string): string {
  if (typeof rawUrl !== "string") return INVALID_RPC_PROVIDER_ID;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return INVALID_RPC_PROVIDER_ID;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return INVALID_RPC_PROVIDER_ID;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return INVALID_RPC_PROVIDER_ID;
  }
  if (!parsed.hostname) {
    return INVALID_RPC_PROVIDER_ID;
  }

  const origin = parsed.origin.toLowerCase();
  if (
    !origin ||
    origin === "null" ||
    origin.length > MAX_PROVIDER_ORIGIN_LENGTH ||
    /[\s"\\]/.test(origin)
  ) {
    return INVALID_RPC_PROVIDER_ID;
  }

  return origin;
}

export interface RpcLatencyBucketCount {
  /** Upper bound in milliseconds (`le`). */
  le: number;
  /** Cumulative count of observations with `durationMs <= le`. */
  count: number;
}

export interface RpcProviderOperationHistogram {
  provider: string;
  operation: RpcHistogramOperation;
  buckets: RpcLatencyBucketCount[];
  /** Cumulative `+Inf` bucket count (equals `count`). */
  infCount: number;
  count: number;
  failures: number;
  sumMs: number;
}

export interface RpcLatencyHistogramSnapshot {
  bucketsMs: number[];
  maxProviders: number;
  series: RpcProviderOperationHistogram[];
}

export interface RpcProviderLatencyHistogramOptions {
  /**
   * Strictly ascending finite upper bounds in milliseconds (`1 .. MAX_RPC_LATENCY_BUCKETS`).
   * Defaults to {@link DEFAULT_RPC_LATENCY_BUCKETS_MS}.
   */
  bucketsMs?: readonly number[] | undefined;
  /**
   * Maximum distinct canonical provider origins admitted before collapsing extras
   * into {@link OVERFLOW_RPC_PROVIDER_ID} (`"other"`).
   * Defaults to {@link DEFAULT_MAX_RPC_HISTOGRAM_PROVIDERS}.
   */
  maxProviders?: number | undefined;
  /**
   * Optional explicit set of canonical provider URLs/origins to pre-register.
   * When provided, any provider outside this fixed set is recorded under `"other"`.
   */
  allowedProviders?: readonly string[] | undefined;
  /** Injectable monotonic clock in milliseconds. Defaults to `performance.now`. */
  clock?: (() => number) | undefined;
}

interface InternalSeries {
  provider: string;
  operation: RpcHistogramOperation;
  bucketCounts: number[];
  count: number;
  failures: number;
  sumMs: number;
}

function validateBucketsMs(raw: readonly number[] | undefined): number[] {
  const source = raw ?? DEFAULT_RPC_LATENCY_BUCKETS_MS;
  if (!Array.isArray(source) || source.length === 0) {
    throw new RangeError("bucketsMs must be a non-empty array of positive finite numbers");
  }
  if (source.length > MAX_RPC_LATENCY_BUCKETS) {
    throw new RangeError(
      `bucketsMs length (${source.length}) exceeds cap of ${MAX_RPC_LATENCY_BUCKETS}`,
    );
  }
  const result: number[] = [];
  let prev = 0;
  for (let i = 0; i < source.length; i++) {
    const val = source[i];
    if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
      throw new RangeError(
        `bucketsMs[${i}] must be a positive finite number; got ${String(val)}`,
      );
    }
    if (val <= prev) {
      throw new RangeError(
        `bucketsMs must be strictly ascending; bucketsMs[${i}]=${val} <= ${prev}`,
      );
    }
    result.push(val);
    prev = val;
  }
  return result;
}

function validateMaxProviders(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RPC_HISTOGRAM_PROVIDERS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new RangeError(`maxProviders must be an integer between 1 and 64; got ${value}`);
  }
  return value;
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function roundDurationMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/**
 * Bounded per-provider RPC latency histogram recorder.
 *
 * Guarantees O(1) bounded label cardinality and memory regardless of untrusted
 * URL query strings, path parameters, or dynamic endpoint churn.
 */
export class RpcProviderLatencyHistograms {
  readonly bucketsMs: readonly number[];
  readonly maxProviders: number;

  private readonly clock: () => number;
  private readonly admittedProviders = new Set<string>();
  private readonly fixedAllowlist: ReadonlySet<string> | null;
  private readonly series = new Map<string, InternalSeries>();

  constructor(options: RpcProviderLatencyHistogramOptions = {}) {
    this.bucketsMs = Object.freeze(validateBucketsMs(options.bucketsMs));
    this.maxProviders = validateMaxProviders(options.maxProviders);
    this.clock = options.clock ?? (() => performance.now());

    if (options.allowedProviders !== undefined) {
      const normalized = new Set<string>();
      for (const candidate of options.allowedProviders) {
        const id = canonicalRpcProviderId(candidate);
        if (id !== INVALID_RPC_PROVIDER_ID && normalized.size < this.maxProviders) {
          normalized.add(id);
          this.admittedProviders.add(id);
        }
      }
      this.fixedAllowlist = normalized;
    } else {
      this.fixedAllowlist = null;
    }
  }

  /** Resolve a raw RPC URL into its bounded metric label (`origin`, `"other"`, or `"invalid"`). */
  resolveProviderLabel(rawUrl: string): string {
    const canonical = canonicalRpcProviderId(rawUrl);
    if (canonical === INVALID_RPC_PROVIDER_ID) {
      return INVALID_RPC_PROVIDER_ID;
    }
    if (this.fixedAllowlist !== null) {
      return this.fixedAllowlist.has(canonical) ? canonical : OVERFLOW_RPC_PROVIDER_ID;
    }
    if (this.admittedProviders.has(canonical)) {
      return canonical;
    }
    if (this.admittedProviders.size < this.maxProviders) {
      this.admittedProviders.add(canonical);
      return canonical;
    }
    return OVERFLOW_RPC_PROVIDER_ID;
  }

  /**
   * Record one RPC duration (ms) for `(rawUrl, operation)`.
   * Non-finite or negative durations are clamped to `0`.
   *
   * @returns The bounded provider label under which the observation was stored.
   */
  record(
    rawUrl: string,
    operation: RpcHistogramOperation,
    durationMs: number,
    ok = true,
  ): string {
    if (!VALID_HISTOGRAM_OPERATIONS.has(operation)) {
      throw new RangeError(`Unsupported RPC histogram operation: ${String(operation)}`);
    }

    const provider = this.resolveProviderLabel(rawUrl);
    const duration =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : 0;

    const key = `${provider}\u0000${operation}`;
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        provider,
        operation,
        bucketCounts: new Array<number>(this.bucketsMs.length).fill(0),
        count: 0,
        failures: 0,
        sumMs: 0,
      };
      this.series.set(key, entry);
    }

    for (let i = 0; i < this.bucketsMs.length; i++) {
      const bound = this.bucketsMs[i]!;
      if (duration <= bound) {
        entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
      }
    }
    entry.count += 1;
    if (!ok) entry.failures += 1;
    entry.sumMs += duration;

    return provider;
  }

  /** Time an async RPC call, record its bounded provider latency, and rethrow on error. */
  async measure<T>(
    rawUrl: string,
    operation: RpcHistogramOperation,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!VALID_HISTOGRAM_OPERATIONS.has(operation)) {
      throw new RangeError(`Unsupported RPC histogram operation: ${String(operation)}`);
    }
    const start = this.clock();
    try {
      const result = await fn();
      this.record(rawUrl, operation, this.clock() - start, true);
      return result;
    } catch (err) {
      this.record(rawUrl, operation, this.clock() - start, false);
      throw err;
    }
  }

  /** Deterministic, JSON-safe snapshot of all recorded `(provider, operation)` histograms. */
  snapshot(): RpcLatencyHistogramSnapshot {
    const ordered = [...this.series.values()].sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.operation.localeCompare(b.operation);
    });

    return {
      bucketsMs: [...this.bucketsMs],
      maxProviders: this.maxProviders,
      series: ordered.map((entry) => ({
        provider: entry.provider,
        operation: entry.operation,
        buckets: this.bucketsMs.map((le, idx) => ({
          le,
          count: entry.bucketCounts[idx] ?? 0,
        })),
        infCount: entry.count,
        count: entry.count,
        failures: entry.failures,
        sumMs: roundDurationMs(entry.sumMs),
      })),
    };
  }

  /**
   * Render Prometheus text exposition v0.0.4 lines for the recorded histograms.
   * Returns an empty string when no observations have been recorded yet.
   */
  renderPrometheus(metricName = "mimir_bot_rpc_request_duration_ms"): string {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metricName)) {
      throw new RangeError(`Invalid Prometheus metric name: ${metricName}`);
    }
    const snap = this.snapshot();
    if (snap.series.length === 0) return "";

    const lines: string[] = [
      `# HELP ${metricName} Soroban RPC request latency in milliseconds by canonical provider origin and operation.`,
      `# TYPE ${metricName} histogram`,
    ];

    for (const s of snap.series) {
      const pLabel = escapePrometheusLabel(s.provider);
      const opLabel = escapePrometheusLabel(s.operation);
      for (const b of s.buckets) {
        lines.push(
          `${metricName}_bucket{provider="${pLabel}",operation="${opLabel}",le="${b.le}"} ${b.count}`,
        );
      }
      lines.push(
        `${metricName}_bucket{provider="${pLabel}",operation="${opLabel}",le="+Inf"} ${s.infCount}`,
      );
      lines.push(
        `${metricName}_sum{provider="${pLabel}",operation="${opLabel}"} ${s.sumMs}`,
      );
      lines.push(
        `${metricName}_count{provider="${pLabel}",operation="${opLabel}"} ${s.count}`,
      );
    }

    return lines.join("\n") + "\n";
  }

  /** Reset recorded series and dynamically admitted providers (preserving fixed allowlist). */
  reset(): void {
    this.series.clear();
    this.admittedProviders.clear();
    if (this.fixedAllowlist !== null) {
      for (const id of this.fixedAllowlist) {
        this.admittedProviders.add(id);
      }
    }
  }
}
