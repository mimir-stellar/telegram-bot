/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import type { rpc } from "@stellar/stellar-sdk";

import { redactUrl } from "../redact.js";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

/** Default consecutive failures on an RPC endpoint before opening its circuit. */
export const DEFAULT_ENDPOINT_FAILURE_THRESHOLD = 5;

/** Default cooldown duration in milliseconds while an endpoint circuit stays open. */
export const DEFAULT_ENDPOINT_COOLDOWN_MS = 60_000;

/** Default maximum duration in milliseconds for a single half-open recovery probe. */
export const DEFAULT_HALF_OPEN_PROBE_TIMEOUT_MS = 10_000;

/** Default maximum number of distinct endpoints retained in a breaker registry. */
export const DEFAULT_MAX_TRACKED_BREAKER_ENDPOINTS = 32;

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

// ── Endpoint-specific half-open circuit breaker ──────────────────────────────

export type EndpointCircuitState = "closed" | "open" | "half-open";

export type RpcCircuitOpenReason =
  | "cooldown-active"
  | "half-open-probe-in-flight";

/**
 * Bounded error raised when an RPC endpoint circuit is open or already running
 * its single half-open recovery probe.
 */
export class RpcCircuitOpenError extends Error {
  readonly endpoint: string;
  readonly state: "open" | "half-open";
  readonly reason: RpcCircuitOpenReason;
  readonly remainingMs: number;

  constructor(params: {
    endpoint: string;
    state: "open" | "half-open";
    reason: RpcCircuitOpenReason;
    remainingMs: number;
  }) {
    const detail =
      params.reason === "half-open-probe-in-flight"
        ? `half-open recovery probe already in flight (${Math.ceil(params.remainingMs)}ms remaining)`
        : `cooldown active (${Math.ceil(params.remainingMs)}ms remaining)`;
    super(`RPC circuit breaker [${params.state}] for ${params.endpoint}: ${detail}`);
    this.name = "RpcCircuitOpenError";
    this.endpoint = params.endpoint;
    this.state = params.state;
    this.reason = params.reason;
    this.remainingMs = params.remainingMs;
  }
}

export interface EndpointCircuitBreakerOptions {
  /** Consecutive failures before opening the circuit (default `5`). */
  failureThreshold?: number | undefined;
  /** Cooldown window in milliseconds before admitting a half-open probe (default `60_000`). */
  cooldownMs?: number | undefined;
  /** Maximum duration in milliseconds allowed for the single half-open probe (default `10_000`). */
  probeTimeoutMs?: number | undefined;
  /** Clock override in milliseconds for deterministic tests. */
  now?: (() => number) | undefined;
}

export interface EndpointCircuitSnapshot {
  endpoint: string;
  state: EndpointCircuitState;
  failureCount: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  probeInFlight: boolean;
  probeDeadlineAt: number | null;
}

export type EndpointCircuitTicket =
  | {
      allowed: true;
      endpoint: string;
      state: "closed" | "half-open";
      probe: boolean;
      probeTimeoutMs: number | null;
      complete: (succeeded: boolean) => void;
    }
  | {
      allowed: false;
      endpoint: string;
      state: "open" | "half-open";
      probe: false;
      reason: RpcCircuitOpenReason;
      remainingMs: number;
    };

/**
 * Derive a canonical, credential-free, query-free endpoint key for circuit
 * breaker isolation across RPC providers.
 */
export function canonicalRpcEndpointKey(endpoint: string): string {
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new Error("RPC endpoint identifier must be a non-empty string");
  }
  const trimmed = endpoint.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const cleanPath = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${cleanPath}`.slice(0, 120);
    }
  } catch {
    // Fall back to redacted label for logical identifiers in tests.
  }
  const sanitized = redactUrl(trimmed).replace(/[?#].*$/, "").trim();
  if (!sanitized) {
    throw new Error("RPC endpoint identifier cannot be empty");
  }
  return sanitized.length <= 120 ? sanitized : `${sanitized.slice(0, 119)}…`;
}

/**
 * Endpoint-scoped circuit breaker enforcing a strict single-probe `"half-open"`
 * recovery gate after cooldown so a recovering RPC never receives full poller load.
 */
export class EndpointCircuitBreaker {
  readonly endpoint: string;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly probeTimeoutMs: number;
  private readonly now: () => number;

  private state: EndpointCircuitState = "closed";
  private failureCount = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private activeProbeId: number | null = null;
  private probeDeadlineAt: number | null = null;
  private nextProbeSeq = 1;

  constructor(endpoint: string, options: EndpointCircuitBreakerOptions = {}) {
    this.endpoint = canonicalRpcEndpointKey(endpoint);
    this.failureThreshold =
      typeof options.failureThreshold === "number" && options.failureThreshold >= 1
        ? options.failureThreshold
        : DEFAULT_ENDPOINT_FAILURE_THRESHOLD;
    this.cooldownMs =
      typeof options.cooldownMs === "number" &&
      Number.isFinite(options.cooldownMs) &&
      options.cooldownMs > 0
        ? Math.floor(options.cooldownMs)
        : DEFAULT_ENDPOINT_COOLDOWN_MS;
    this.probeTimeoutMs =
      typeof options.probeTimeoutMs === "number" &&
      Number.isFinite(options.probeTimeoutMs) &&
      options.probeTimeoutMs > 0
        ? Math.floor(options.probeTimeoutMs)
        : DEFAULT_HALF_OPEN_PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private expireTimedOutProbe(nowMs: number): void {
    if (
      this.state === "half-open" &&
      this.activeProbeId !== null &&
      this.probeDeadlineAt !== null &&
      nowMs >= this.probeDeadlineAt
    ) {
      // Timed-out probe failed to recover the endpoint: immediately re-open cooldown.
      this.activeProbeId = null;
      this.probeDeadlineAt = null;
      this.failureCount += 1;
      this.lastFailureAt = nowMs;
      this.state = "open";
      this.openedAt = nowMs;
    }
  }

  /**
   * Attempt to acquire permission to send one request to this endpoint.
   *
   * - `"closed"`: admits normal load.
   * - `"open"` before cooldown: rejects with `"cooldown-active"`.
   * - `"open"` at/after cooldown: transitions to `"half-open"` and admits
   *   **one** bounded recovery probe (`probe: true`).
   * - `"half-open"` while the single probe is in flight: rejects all concurrent
   *   callers with `"half-open-probe-in-flight"`.
   */
  acquire(): EndpointCircuitTicket {
    const nowMs = this.now();
    this.expireTimedOutProbe(nowMs);

    if (this.state === "open") {
      const elapsed = this.openedAt !== null ? nowMs - this.openedAt : Number.POSITIVE_INFINITY;
      if (elapsed < this.cooldownMs) {
        return {
          allowed: false,
          endpoint: this.endpoint,
          state: "open",
          probe: false,
          reason: "cooldown-active",
          remainingMs: Math.max(1, this.cooldownMs - elapsed),
        };
      }

      // Cooldown elapsed: transition to half-open and admit exactly ONE probe.
      const probeId = this.nextProbeSeq++;
      this.state = "half-open";
      this.activeProbeId = probeId;
      this.probeDeadlineAt = nowMs + this.probeTimeoutMs;
      let settled = false;

      return {
        allowed: true,
        endpoint: this.endpoint,
        state: "half-open",
        probe: true,
        probeTimeoutMs: this.probeTimeoutMs,
        complete: (succeeded: boolean) => {
          if (settled) return;
          settled = true;
          const finishAt = this.now();
          if (this.state !== "half-open" || this.activeProbeId !== probeId) {
            return;
          }
          this.activeProbeId = null;
          this.probeDeadlineAt = null;
          if (succeeded) {
            this.state = "closed";
            this.failureCount = 0;
            this.openedAt = null;
          } else {
            this.failureCount += 1;
            this.lastFailureAt = finishAt;
            this.state = "open";
            this.openedAt = finishAt;
          }
        },
      };
    }

    if (this.state === "half-open") {
      const remainingMs =
        this.probeDeadlineAt !== null
          ? Math.max(1, this.probeDeadlineAt - nowMs)
          : this.probeTimeoutMs;
      return {
        allowed: false,
        endpoint: this.endpoint,
        state: "half-open",
        probe: false,
        reason: "half-open-probe-in-flight",
        remainingMs,
      };
    }

    // State is "closed"
    const closedEpoch = this.nextProbeSeq;
    let settled = false;
    return {
      allowed: true,
      endpoint: this.endpoint,
      state: "closed",
      probe: false,
      probeTimeoutMs: null,
      complete: (succeeded: boolean) => {
        if (settled) return;
        settled = true;
        // Ignore stale completions from before an intervening half-open transition.
        if (this.state !== "closed" || this.nextProbeSeq !== closedEpoch) {
          return;
        }
        const finishAt = this.now();
        if (succeeded) {
          this.failureCount = 0;
        } else {
          this.failureCount += 1;
          this.lastFailureAt = finishAt;
          if (this.failureCount >= this.failureThreshold) {
            this.state = "open";
            this.openedAt = finishAt;
          }
        }
      },
    };
  }

  /**
   * Execute an async operation through the endpoint circuit breaker, enforcing
   * `probeTimeoutMs` when running a half-open recovery probe.
   */
  async execute<T>(
    operation: (context: { probe: boolean; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const ticket = this.acquire();
    if (!ticket.allowed) {
      throw new RpcCircuitOpenError({
        endpoint: ticket.endpoint,
        state: ticket.state,
        reason: ticket.reason,
        remainingMs: ticket.remainingMs,
      });
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;

    try {
      let result: T;
      if (ticket.probe && ticket.probeTimeoutMs !== null) {
        const timeoutMs = ticket.probeTimeoutMs;
        result = await new Promise<T>((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                `RPC half-open recovery probe for ${this.endpoint} timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
          timer.unref?.();

          operation({ probe: true, signal: controller.signal }).then(resolve, reject);
        });
      } else {
        result = await operation({ probe: false, signal: controller.signal });
      }
      ticket.complete(true);
      return result;
    } catch (err) {
      ticket.complete(false);
      throw err;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  /** Inspect current circuit state (advancing any expired probe deadline first). */
  snapshot(): EndpointCircuitSnapshot {
    this.expireTimedOutProbe(this.now());
    return {
      endpoint: this.endpoint,
      state: this.state,
      failureCount: this.failureCount,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      probeInFlight: this.state === "half-open" && this.activeProbeId !== null,
      probeDeadlineAt: this.probeDeadlineAt,
    };
  }

  /** Reset this endpoint circuit back to `"closed"`. */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.openedAt = null;
    this.lastFailureAt = null;
    this.activeProbeId = null;
    this.probeDeadlineAt = null;
    this.nextProbeSeq += 1;
  }
}

export interface EndpointCircuitBreakerRegistryOptions
  extends EndpointCircuitBreakerOptions {
  /** Maximum distinct endpoints retained in the registry (default `32`). */
  maxEndpoints?: number | undefined;
}

/**
 * Bounded registry of per-endpoint circuit breakers keyed by canonical RPC URL.
 */
export class EndpointCircuitBreakerRegistry {
  private readonly maxEndpoints: number;
  private readonly breakerOptions: EndpointCircuitBreakerOptions;
  private readonly breakers = new Map<string, EndpointCircuitBreaker>();

  constructor(options: EndpointCircuitBreakerRegistryOptions = {}) {
    this.maxEndpoints =
      typeof options.maxEndpoints === "number" &&
      Number.isFinite(options.maxEndpoints) &&
      options.maxEndpoints >= 1
        ? Math.floor(options.maxEndpoints)
        : DEFAULT_MAX_TRACKED_BREAKER_ENDPOINTS;
    this.breakerOptions = {
      failureThreshold: options.failureThreshold,
      cooldownMs: options.cooldownMs,
      probeTimeoutMs: options.probeTimeoutMs,
      now: options.now,
    };
  }

  /** Retrieve or create the circuit breaker for `endpoint`. */
  forEndpoint(endpoint: string): EndpointCircuitBreaker {
    const key = canonicalRpcEndpointKey(endpoint);
    const existing = this.breakers.get(key);
    if (existing) {
      this.breakers.delete(key);
      this.breakers.set(key, existing);
      return existing;
    }
    if (this.breakers.size >= this.maxEndpoints) {
      const oldestKey = this.breakers.keys().next().value;
      if (oldestKey !== undefined) {
        this.breakers.delete(oldestKey);
      }
    }
    const created = new EndpointCircuitBreaker(key, this.breakerOptions);
    this.breakers.set(key, created);
    return created;
  }

  /** Execute an operation guarded by the circuit breaker for `endpoint`. */
  execute<T>(
    endpoint: string,
    operation: (context: { probe: boolean; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    return this.forEndpoint(endpoint).execute(operation);
  }

  /** Snapshot all tracked endpoint breakers. */
  snapshots(): EndpointCircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  /** Clear all tracked endpoint breakers. */
  reset(): void {
    for (const b of this.breakers.values()) b.reset();
    this.breakers.clear();
  }
}
