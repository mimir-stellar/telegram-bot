/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import type { rpc } from "@stellar/stellar-sdk";
import { normalizeRpcEndpoint } from "./client.js";

import { resolveMaxBackoffMs } from "./client.js";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

export type RpcUrlProblem =
  | "invalid-url"
  | "unsupported-protocol"
  | "embedded-credentials";

/**
 * Error thrown when a configured RPC or endpoint URL fails boundary validation.
 *
 * Messages are strictly bounded and report only the affected configuration key,
 * never echoing the raw URL or any embedded credentials.
 */
export class RpcEndpointUrlError extends Error {
  readonly problem: RpcUrlProblem;
  readonly configKey: string;

  constructor(problem: RpcUrlProblem, configKey: string, message: string) {
    super(message);
    this.name = "RpcEndpointUrlError";
    this.problem = problem;
    this.configKey = configKey;
  }
}

/** Matches an authority section containing userinfo (`@` before path/query/hash). */
const EMBEDDED_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/**
 * Validate a configured HTTP(S) endpoint URL before startup or client creation.
 *
 * Rejects malformed URLs, non-HTTP(S) protocols, and URLs with embedded
 * credentials (`user:pass@host`, `user@host`, `:pass@host`, or `@host`).
 * Errors report only the affected configuration key and never echo the URL or
 * credentials.
 *
 * @param url The configured URL string to validate.
 * @param configKey Configuration key name reported in errors (defaults to `"STELLAR_RPC_URL"`).
 * @returns The validated URL string.
 * @throws {RpcEndpointUrlError} When the URL is invalid, non-HTTP(S), or contains embedded credentials.
 */
export function assertRpcEndpointUrl(
  url: string,
  configKey = "STELLAR_RPC_URL",
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RpcEndpointUrlError(
      "invalid-url",
      configKey,
      `${configKey} is not a valid URL`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcEndpointUrlError(
      "unsupported-protocol",
      configKey,
      `${configKey} must be an http(s) URL`,
    );
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    EMBEDDED_USERINFO_RE.test(url.trim())
  ) {
    throw new RpcEndpointUrlError(
      "embedded-credentials",
      configKey,
      `${configKey} must not contain embedded credentials`,
    );
  }

  return url;
}

export type RpcGuardProblem =
  | "response-oversized"
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

// ── Endpoint-specific half-open circuit breaker ──────────────────────────────

/** Default number of consecutive RPC failures before opening an endpoint circuit. */
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;

/** Default cooldown period in milliseconds before allowing a half-open probe. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;

/** Default maximum concurrent recovery probes allowed while half-open. */
export const DEFAULT_HALF_OPEN_MAX_PROBES = 1;

/** Lifecycle state of an endpoint-specific RPC circuit breaker. */
export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface RpcCircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. Defaults to 5. */
  failureThreshold?: number;
  /** Cooldown in milliseconds before transitioning from open to half-open. Defaults to 60_000. */
  cooldownMs?: number;
  /** Maximum bounded probes allowed in half-open state. Defaults to 1. */
  maxHalfOpenProbes?: number;
  /** Clock source in unix ms (injectable for deterministic tests). */
  now?: () => number;
}

export interface CircuitProbeDecision {
  /** Whether the caller may issue an RPC request to this endpoint. */
  allowed: boolean;
  /** Current circuit state after evaluating the request. */
  state: CircuitBreakerState;
  /** True when this request was admitted as a bounded half-open recovery probe. */
  isProbe: boolean;
  /** Normalized endpoint key this decision applies to. */
  endpoint: string;
  /** Remaining cooldown in ms when rejected in open state; 0 otherwise. */
  remainingCooldownMs: number;
}

export interface EndpointCircuitSnapshot {
  endpoint: string;
  state: CircuitBreakerState;
  /** Backward-compatible flag: true only when state is `"open"`. */
  open: boolean;
  /** True when state is `"half-open"`. */
  halfOpen: boolean;
  openedAt: number | null;
  failureCount: number;
  lastFailureAt: number | null;
  probesInFlight: number;
}

interface EndpointCircuitRecord {
  state: CircuitBreakerState;
  openedAt: number | null;
  failureCount: number;
  lastFailureAt: number | null;
  probesInFlight: number;
}

/**
 * Endpoint-specific RPC circuit breaker with bounded half-open recovery probes.
 *
 * Each normalized RPC endpoint tracks its own closed / open / half-open state
 * so a degraded endpoint cannot trip or starve another endpoint. After
 * cooldown elapses, the breaker admits at most `maxHalfOpenProbes` (default 1)
 * bounded probe instead of exposing the recovering endpoint to full poller
 * load. A successful probe closes the circuit; a failed probe immediately
 * re-opens it for a fresh cooldown.
 */
export class RpcCircuitBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly maxHalfOpenProbes: number;
  private readonly now: () => number;
  private readonly endpoints = new Map<string, EndpointCircuitRecord>();

  constructor(options: RpcCircuitBreakerOptions = {}) {
    const threshold = options.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.failureThreshold = Number.isFinite(threshold) ? Math.max(1, Math.floor(threshold)) : threshold;
    const cooldown = options.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.cooldownMs = Math.max(0, Number.isFinite(cooldown) ? cooldown : DEFAULT_CIRCUIT_COOLDOWN_MS);
    const maxProbes = options.maxHalfOpenProbes ?? DEFAULT_HALF_OPEN_MAX_PROBES;
    this.maxHalfOpenProbes = Math.max(1, Number.isFinite(maxProbes) ? Math.floor(maxProbes) : 1);
    this.now = options.now ?? (() => Date.now());
  }

  private getOrCreate(endpoint: string): { key: string; record: EndpointCircuitRecord } {
    const key = normalizeRpcEndpoint(endpoint);
    let record = this.endpoints.get(key);
    if (!record) {
      record = {
        state: "closed",
        openedAt: null,
        failureCount: 0,
        lastFailureAt: null,
        probesInFlight: 0,
      };
      this.endpoints.set(key, record);
    }
    return { key, record };
  }

  private toSnapshot(key: string, record: EndpointCircuitRecord): EndpointCircuitSnapshot {
    return {
      endpoint: key,
      state: record.state,
      open: record.state === "open",
      halfOpen: record.state === "half-open",
      openedAt: record.openedAt,
      failureCount: record.failureCount,
      lastFailureAt: record.lastFailureAt,
      probesInFlight: record.probesInFlight,
    };
  }

  /**
   * Decide whether a request to `endpoint` is permitted.
   *
   * - `closed`: allowed (`isProbe: false`).
   * - `open`: rejected while within cooldown; once cooldown elapses, transitions
   *   to `half-open` and admits one bounded recovery probe (`isProbe: true`).
   * - `half-open`: admits up to `maxHalfOpenProbes` concurrent probes; rejects
   *   additional requests so the recovering endpoint does not receive full load.
   */
  allowRequest(endpoint: string): CircuitProbeDecision {
    const { key, record } = this.getOrCreate(endpoint);

    if (record.state === "closed") {
      return {
        allowed: true,
        state: "closed",
        isProbe: false,
        endpoint: key,
        remainingCooldownMs: 0,
      };
    }

    if (record.state === "open") {
      const nowMs = this.now();
      const elapsed = record.openedAt !== null ? Math.max(0, nowMs - record.openedAt) : Infinity;
      if (elapsed >= this.cooldownMs) {
        record.state = "half-open";
        record.probesInFlight = 1;
        return {
          allowed: true,
          state: "half-open",
          isProbe: true,
          endpoint: key,
          remainingCooldownMs: 0,
        };
      }
      return {
        allowed: false,
        state: "open",
        isProbe: false,
        endpoint: key,
        remainingCooldownMs: Math.max(0, this.cooldownMs - elapsed),
      };
    }

    // half-open
    if (record.probesInFlight < this.maxHalfOpenProbes) {
      record.probesInFlight += 1;
      return {
        allowed: true,
        state: "half-open",
        isProbe: true,
        endpoint: key,
        remainingCooldownMs: 0,
      };
    }

    return {
      allowed: false,
      state: "half-open",
      isProbe: false,
      endpoint: key,
      remainingCooldownMs: 0,
    };
  }

  /** Record a successful RPC call for `endpoint`, closing any half-open circuit. */
  recordSuccess(endpoint: string): EndpointCircuitSnapshot {
    const { key, record } = this.getOrCreate(endpoint);
    record.state = "closed";
    record.openedAt = null;
    record.failureCount = 0;
    record.lastFailureAt = null;
    record.probesInFlight = 0;
    return this.toSnapshot(key, record);
  }

  /**
   * Record one or more RPC failures for `endpoint`.
   *
   * In `half-open`, a single failure immediately re-opens the circuit for a
   * fresh cooldown. In `closed`, the circuit opens once `failureCount` reaches
   * `failureThreshold`.
   */
  recordFailure(endpoint: string, count = 1): EndpointCircuitSnapshot {
    const { key, record } = this.getOrCreate(endpoint);
    const increment = Math.max(1, Math.floor(count));
    const nowMs = this.now();
    record.failureCount += increment;
    record.lastFailureAt = nowMs;

    if (record.state === "half-open") {
      record.state = "open";
      record.openedAt = nowMs;
      record.probesInFlight = 0;
    } else if (record.state === "closed" && record.failureCount >= this.failureThreshold) {
      record.state = "open";
      record.openedAt = nowMs;
      record.probesInFlight = 0;
    }

    return this.toSnapshot(key, record);
  }

  /**
   * Release a previously admitted half-open probe slot without recording a
   * success or failure (e.g. when no target was eligible to send an RPC).
   */
  releaseProbe(endpoint: string): EndpointCircuitSnapshot {
    const { key, record } = this.getOrCreate(endpoint);
    if (record.state === "half-open" && record.probesInFlight > 0) {
      record.probesInFlight -= 1;
    }
    return this.toSnapshot(key, record);
  }

  /** Return a snapshot of the circuit state for `endpoint`. */
  snapshot(endpoint: string): EndpointCircuitSnapshot {
    const { key, record } = this.getOrCreate(endpoint);
    return this.toSnapshot(key, record);
  }

  /** Return snapshots for all tracked endpoints. */
  snapshots(): Record<string, EndpointCircuitSnapshot> {
    const result: Record<string, EndpointCircuitSnapshot> = {};
    for (const [key, record] of this.endpoints.entries()) {
      result[key] = this.toSnapshot(key, record);
    }
    return result;
  }

  /** Reset one endpoint (or all endpoints when omitted) to a clean closed state. */
  reset(endpoint?: string): void {
    if (endpoint === undefined) {
      this.endpoints.clear();
      return;
    }
    this.endpoints.delete(normalizeRpcEndpoint(endpoint));
  }
}
