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

// ── Provider ledger progress vs. idle event stream ───────────────────────────
//
// Soroban contracts frequently go minutes or hours without emitting events, so
// `getEvents` returning `events: []` (or an unchanged chain-event close time)
// is normal on a healthy chain. An RPC provider is *stale* only when its own
// `latestLedger` fails to advance across a bounded observation interval or
// regresses backwards behind a drifting backend pool.

/** Default bounded interval (ms) over which `latestLedger` must advance. */
export const DEFAULT_PROVIDER_STALE_AFTER_MS = 60_000;

/** Default bounded history ring retained per provider progress tracker. */
export const DEFAULT_PROVIDER_PROGRESS_WINDOW = 16;

/** Liveness classification separating stalled providers from quiet contracts. */
export type ProviderLivenessState =
  | "warming-up"
  | "active-stream"
  | "idle-stream"
  | "stale-provider";

/** Why a provider's ledger progress was flagged as stale. */
export type ProviderStaleReason = "ledger-stalled" | "ledger-regressed";

/** One bounded observation of an RPC provider's reported tip and event yield. */
export interface ProviderProgressObservation {
  /** `latestLedger` reported by `getHealth()` or `getEvents()`. */
  latestLedger: number;
  /** Number of contract events observed in the poll/page (defaults to `0`). */
  eventCount?: number | undefined;
  /** Monotonic/wall-clock timestamp in ms (defaults to tracker `now()`). */
  observedAtMs?: number | undefined;
}

/** Result of comparing provider ledger progress across a bounded interval. */
export interface ProviderProgressAssessment {
  /** High-level classification distinguishing `"stale-provider"` from `"idle-stream"`. */
  state: ProviderLivenessState;
  /** True only when the provider's ledger progress is stalled or regressed. */
  stale: boolean;
  /** True when zero contract events were observed on this sample. */
  streamIdle: boolean;
  /** Bounded reason when `stale` is true; `null` while the provider is healthy. */
  reason: ProviderStaleReason | null;
  /** `latestLedger` from the most recent observation. */
  latestLedger: number;
  /** Highest `latestLedger` observed by the tracker up to this sample. */
  anchorLedger: number;
  /** Change relative to the prior `anchorLedger` (`0` on the initial sample). */
  ledgerDelta: number;
  /** Elapsed ms since `anchorLedger` last advanced (`0` when advancing). */
  elapsedSinceAdvanceMs: number;
  /** Configured bounded interval (ms) before a flat `latestLedger` is stale. */
  staleAfterMs: number;
  /** Event count recorded on the current observation. */
  eventCount: number;
  /** Consecutive observations with `eventCount === 0`. */
  consecutiveIdleObservations: number;
  /** Retained sample count inside the bounded history window (`1 .. windowSize`). */
  samples: number;
}

export interface ProviderProgressOptions {
  /**
   * Maximum elapsed milliseconds a provider's `latestLedger` may remain
   * unchanged before being classified as `"stale-provider"`.
   * Defaults to {@link DEFAULT_PROVIDER_STALE_AFTER_MS}.
   */
  staleAfterMs?: number | undefined;
  /**
   * Maximum observations retained in the bounded ring buffer.
   * Defaults to {@link DEFAULT_PROVIDER_PROGRESS_WINDOW}.
   */
  windowSize?: number | undefined;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

interface ProgressSample {
  latestLedger: number;
  eventCount: number;
  observedAtMs: number;
}

function validatePositiveDurationMs(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number; got ${value}`);
  }
  return value;
}

function validatePositiveWindowSize(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; got ${value}`);
  }
  return value;
}

function validateEventCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `eventCount must be a non-negative safe integer; got ${value}`,
    );
  }
  return value;
}

function validateObservedAtMs(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`observedAtMs must be a finite number; got ${value}`);
  }
  return value;
}

/**
 * Bounded tracker that differentiates a stalled/regressing RPC provider from an
 * up-to-date provider serving a quiet (zero-event) contract stream.
 */
export class ProviderProgressTracker {
  readonly staleAfterMs: number;
  readonly windowSize: number;

  private readonly now: () => number;
  private readonly history: ProgressSample[] = [];
  private anchorLedger: number | null = null;
  private lastAdvanceAtMs: number | null = null;
  private hasAdvancedOnce = false;
  private consecutiveIdleObservations = 0;
  private lastAssessment: ProviderProgressAssessment | null = null;

  constructor(options: ProviderProgressOptions = {}) {
    this.staleAfterMs = validatePositiveDurationMs(
      "staleAfterMs",
      options.staleAfterMs,
      DEFAULT_PROVIDER_STALE_AFTER_MS,
    );
    this.windowSize = validatePositiveWindowSize(
      "windowSize",
      options.windowSize,
      DEFAULT_PROVIDER_PROGRESS_WINDOW,
    );
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a provider ledger observation and classify provider liveness vs.
   * stream activity over the configured bounded interval.
   */
  observe(observation: ProviderProgressObservation): ProviderProgressAssessment {
    if (!isValidLedger(observation.latestLedger)) {
      throw new RpcResponseShapeError(
        "latest-ledger-invalid",
        `Provider progress observation requires a valid non-negative integer latestLedger; got ${typeof observation.latestLedger}`,
      );
    }

    const latestLedger = observation.latestLedger;
    const eventCount = validateEventCount(observation.eventCount);
    const rawAtMs = validateObservedAtMs(observation.observedAtMs ?? this.now());
    const streamIdle = eventCount === 0;

    this.history.push({ latestLedger, eventCount, observedAtMs: rawAtMs });
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }

    this.consecutiveIdleObservations = streamIdle
      ? this.consecutiveIdleObservations + 1
      : 0;

    let state: ProviderLivenessState;
    let stale = false;
    let reason: ProviderStaleReason | null = null;
    let ledgerDelta = 0;
    let elapsedSinceAdvanceMs = 0;

    if (this.anchorLedger === null || this.lastAdvanceAtMs === null) {
      this.anchorLedger = latestLedger;
      this.lastAdvanceAtMs = rawAtMs;
      state = "warming-up";
    } else {
      const prevAnchor = this.anchorLedger;
      ledgerDelta = latestLedger - prevAnchor;

      if (latestLedger > prevAnchor) {
        this.anchorLedger = latestLedger;
        this.lastAdvanceAtMs = Math.max(this.lastAdvanceAtMs, rawAtMs);
        this.hasAdvancedOnce = true;
        elapsedSinceAdvanceMs = 0;
        state = streamIdle ? "idle-stream" : "active-stream";
      } else if (latestLedger < prevAnchor) {
        elapsedSinceAdvanceMs = Math.max(0, rawAtMs - this.lastAdvanceAtMs);
        stale = true;
        reason = "ledger-regressed";
        state = "stale-provider";
      } else {
        elapsedSinceAdvanceMs = Math.max(0, rawAtMs - this.lastAdvanceAtMs);
        if (elapsedSinceAdvanceMs >= this.staleAfterMs) {
          stale = true;
          reason = "ledger-stalled";
          state = "stale-provider";
        } else if (this.hasAdvancedOnce) {
          state = streamIdle ? "idle-stream" : "active-stream";
        } else {
          state = streamIdle ? "warming-up" : "active-stream";
        }
      }
    }

    const assessment: ProviderProgressAssessment = {
      state,
      stale,
      streamIdle,
      reason,
      latestLedger,
      anchorLedger: this.anchorLedger,
      ledgerDelta,
      elapsedSinceAdvanceMs,
      staleAfterMs: this.staleAfterMs,
      eventCount,
      consecutiveIdleObservations: this.consecutiveIdleObservations,
      samples: this.history.length,
    };

    this.lastAssessment = assessment;
    return assessment;
  }

  /**
   * Validate a raw `getEvents` response at the RPC boundary and feed its
   * `latestLedger` and `events.length` into the progress tracker.
   */
  observeEventsResponse(
    value: unknown,
    observedAtMs?: number,
    guardOptions?: AssertEventsResponseOptions,
  ): ProviderProgressAssessment {
    const response = assertEventsResponse(value, guardOptions);
    if (!isValidLedger(response.latestLedger)) {
      throw new RpcResponseShapeError(
        "latest-ledger-invalid",
        `RPC getEvents response must include a valid latestLedger to evaluate provider progress`,
      );
    }
    return this.observe({
      latestLedger: response.latestLedger,
      eventCount: response.events.length,
      observedAtMs,
    });
  }

  /** Latest computed assessment, or `null` before the first observation. */
  snapshot(): ProviderProgressAssessment | null {
    return this.lastAssessment ? { ...this.lastAssessment } : null;
  }

  /** Number of observations currently retained in the bounded ring (`0 .. windowSize`). */
  historyCount(): number {
    return this.history.length;
  }

  /** Clear all retained observations and anchor state. */
  reset(): void {
    this.history.length = 0;
    this.anchorLedger = null;
    this.lastAdvanceAtMs = null;
    this.hasAdvancedOnce = false;
    this.consecutiveIdleObservations = 0;
    this.lastAssessment = null;
  }
}
