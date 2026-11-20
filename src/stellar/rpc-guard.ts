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

/**
 * Default bounded interval (in milliseconds) over which a provider's
 * `latestLedger` must advance before it is flagged as stale.
 *
 * Stellar closes a ledger roughly every 5 seconds, so 60 seconds corresponds
 * to ~12 missed ledger closes.
 */
export const DEFAULT_MAX_LEDGER_STALL_MS = 60_000;

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

// ── Provider ledger-progress tracking ────────────────────────────────────────

/**
 * Classification of an RPC provider's liveness based on ledger progression
 * over a bounded interval, independent of whether contract events were emitted:
 *
 * - `"active"`: provider is up-to-date (ledger advancing or within the bounded
 *   interval) and events were observed in the latest sample.
 * - `"idle"`: provider is up-to-date, and no events were observed in the latest
 *   sample. An idle event stream is healthy and must not be flagged as stale.
 * - `"stale-provider"`: provider's `latestLedger` failed to advance across the
 *   configured `maxStaleMs` interval.
 */
export type ProviderLivenessStatus = "active" | "idle" | "stale-provider";

export interface LedgerProgressSample {
  /** Chain tip (`latestLedger`) reported by the RPC provider. */
  latestLedger: number;
  /** Number of events returned in the poll (defaults to `0`). */
  eventsCount?: number | undefined;
  /** Wall-clock timestamp in ms for this observation (defaults to `now()`). */
  observedAtMs?: number | undefined;
}

export interface LedgerProgressReport {
  /** High-level classification differentiating stale providers from idle streams. */
  status: ProviderLivenessStatus;
  /** True only when `latestLedger` has not advanced for at least `maxStaleMs`. */
  stale: boolean;
  /** True when the latest sample contained zero events (`eventsCount === 0`). */
  idle: boolean;
  /** True when `latestLedger` moved backwards relative to the highest seen ledger. */
  regressed: boolean;
  /** The `latestLedger` value from the current observation. */
  latestLedger: number;
  /** Highest `latestLedger` observed so far (anchor for staleness timing). */
  baselineLedger: number;
  /** Difference `latestLedger - previousBaselineLedger` (negative on regression). */
  ledgerDelta: number;
  /** Elapsed milliseconds since `baselineLedger` was first observed without advancing. */
  stalledMs: number;
  /** Configured staleness threshold in milliseconds. */
  maxStaleMs: number;
}

export interface LedgerProgressTrackerOptions {
  /**
   * Bounded interval in milliseconds over which `latestLedger` must advance
   * before the provider is classified as `"stale-provider"`.
   * Must be a positive finite number. Defaults to {@link DEFAULT_MAX_LEDGER_STALL_MS}.
   */
  maxStaleMs?: number | undefined;
  /** Clock source returning current epoch milliseconds. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

/**
 * Tracks a Soroban RPC provider's `latestLedger` progress over a bounded
 * interval to differentiate a stale/stuck provider from an idle event stream.
 *
 * A provider that continues advancing `latestLedger` while returning zero
 * events is classified as `"idle"` (`stale: false`), never `"stale-provider"`.
 * Only when `latestLedger` fails to advance for at least `maxStaleMs` is the
 * provider flagged as `"stale-provider"` (`stale: true`).
 */
export class LedgerProgressTracker {
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private baselineLedger: number | null = null;
  private baselineObservedAtMs: number | null = null;
  private lastReport: LedgerProgressReport | null = null;

  constructor(options: LedgerProgressTrackerOptions = {}) {
    const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_LEDGER_STALL_MS;
    if (typeof maxStaleMs !== "number" || !Number.isFinite(maxStaleMs) || maxStaleMs <= 0) {
      throw new RangeError(
        `LedgerProgressTracker maxStaleMs must be a positive finite number; got ${String(maxStaleMs)}`,
      );
    }
    this.maxStaleMs = maxStaleMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a new RPC observation and return the updated liveness report.
   *
   * @throws {RpcResponseShapeError} If `latestLedger` is not a valid non-negative integer.
   */
  observe(sample: LedgerProgressSample): LedgerProgressReport {
    if (!isValidLedger(sample?.latestLedger)) {
      throw new RpcResponseShapeError(
        "latest-ledger-invalid",
        `RPC provider "latestLedger" must be a valid non-negative integer; got ${typeof sample?.latestLedger}`,
      );
    }

    const latestLedger = sample.latestLedger;
    const eventsCount = sample.eventsCount ?? 0;
    const idle = eventsCount === 0;
    const observedAtMs = sample.observedAtMs ?? this.now();

    if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs)) {
      throw new RangeError(
        `LedgerProgressTracker observedAtMs must be a finite number; got ${String(observedAtMs)}`,
      );
    }

    if (this.baselineLedger === null || this.baselineObservedAtMs === null) {
      this.baselineLedger = latestLedger;
      this.baselineObservedAtMs = observedAtMs;
      const report: LedgerProgressReport = {
        status: idle ? "idle" : "active",
        stale: false,
        idle,
        regressed: false,
        latestLedger,
        baselineLedger: latestLedger,
        ledgerDelta: 0,
        stalledMs: 0,
        maxStaleMs: this.maxStaleMs,
      };
      this.lastReport = report;
      return report;
    }

    const previousBaseline = this.baselineLedger;
    const ledgerDelta = latestLedger - previousBaseline;

    if (ledgerDelta > 0) {
      // Provider advanced: reset stall timer even if the event stream is idle.
      this.baselineLedger = latestLedger;
      this.baselineObservedAtMs = observedAtMs;
      const report: LedgerProgressReport = {
        status: idle ? "idle" : "active",
        stale: false,
        idle,
        regressed: false,
        latestLedger,
        baselineLedger: latestLedger,
        ledgerDelta,
        stalledMs: 0,
        maxStaleMs: this.maxStaleMs,
      };
      this.lastReport = report;
      return report;
    }

    // No forward progress (stalled or regressed): keep highest baseline and anchor time.
    const stalledMs = Math.max(0, observedAtMs - this.baselineObservedAtMs);
    const stale = stalledMs >= this.maxStaleMs;
    const regressed = ledgerDelta < 0;
    const status: ProviderLivenessStatus = stale
      ? "stale-provider"
      : idle
        ? "idle"
        : "active";

    const report: LedgerProgressReport = {
      status,
      stale,
      idle,
      regressed,
      latestLedger,
      baselineLedger: previousBaseline,
      ledgerDelta,
      stalledMs,
      maxStaleMs: this.maxStaleMs,
    };
    this.lastReport = report;
    return report;
  }

  /** Return the most recent liveness report, or `null` if no sample has been observed. */
  snapshot(): LedgerProgressReport | null {
    return this.lastReport;
  }

  /** Clear tracked baseline state (e.g. after switching RPC endpoints). */
  reset(): void {
    this.baselineLedger = null;
    this.baselineObservedAtMs = null;
    this.lastReport = null;
  }
}
