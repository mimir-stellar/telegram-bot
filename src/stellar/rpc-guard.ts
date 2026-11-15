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

/** Default maximum backoff delay permitted for untrusted RPC retry hints (60s). */
export const DEFAULT_RPC_MAX_BACKOFF_MS = 60_000;

/** Maximum length accepted for an untrusted `Retry-After` header string. */
export const MAX_RPC_RETRY_HEADER_CHARS = 128;

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

// ── Untrusted RPC Retry-After header clamping ────────────────────────────────

export type RpcRetryDelayRejectionReason =
  | "missing"
  | "negative"
  | "non-positive"
  | "non-finite"
  | "oversized"
  | "malformed";

export interface RpcRetryDelayEvaluation {
  accepted: boolean;
  clamped: boolean;
  rawDelayMs: number | null;
  delayMs: number | null;
  rejectedReason: RpcRetryDelayRejectionReason | null;
}

export interface ClampRpcRetryDelayOptions {
  /**
   * Authoritative ceiling in milliseconds for any retry delay.
   * Defaults to {@link DEFAULT_RPC_MAX_BACKOFF_MS}.
   */
  maxBackoffMs?: number | undefined;
  /**
   * Optional absolute ceiling on raw requested delay in milliseconds before
   * outright rejection (`accepted: false, rejectedReason: "oversized"`).
   * When omitted, any finite safe-integer positive delay above `maxBackoffMs`
   * is clamped down to `maxBackoffMs`, while values overflowing safe integers
   * or exceeding {@link MAX_RPC_RETRY_HEADER_CHARS} are rejected.
   */
  rejectAboveMs?: number | undefined;
  /** Clock epoch in milliseconds used to evaluate HTTP-date `Retry-After` values. */
  nowMs?: number | undefined;
}

export interface ResolveRpcRetryDelayOptions extends ClampRpcRetryDelayOptions {
  /** Caller's computed exponential backoff in milliseconds. */
  computedBackoffMs: number;
}

/**
 * Raised when caller-supplied backoff configuration (`maxBackoffMs`) is invalid.
 */
export class RpcRetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcRetryConfigError";
  }
}

const STRICT_UNSIGNED_DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const STRICT_SIGNED_NEGATIVE_RE = /^-\s*\d+(?:\.\d+)?$/;
const IMF_FIXDATE_RE =
  /^[A-Za-z]{3},\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT$/;

function validateMaxBackoffMs(value: number | undefined): number {
  const maxBackoffMs = value ?? DEFAULT_RPC_MAX_BACKOFF_MS;
  if (typeof maxBackoffMs !== "number" || !Number.isFinite(maxBackoffMs) || maxBackoffMs <= 0) {
    throw new RpcRetryConfigError(
      "maxBackoffMs must be a finite positive number of milliseconds",
    );
  }
  return Math.floor(maxBackoffMs);
}

function readHeaderValueFromContainer(headers: unknown): {
  found: boolean;
  raw: unknown;
} {
  if (!headers || typeof headers !== "object") {
    return { found: false, raw: undefined };
  }

  const maybeGetter = headers as { get?: (name: string) => unknown };
  if (typeof maybeGetter.get === "function") {
    const val = maybeGetter.get("retry-after") ?? maybeGetter.get("Retry-After");
    if (val !== null && val !== undefined) {
      return { found: true, raw: val };
    }
    return { found: false, raw: undefined };
  }

  if (Array.isArray(headers)) {
    return { found: false, raw: undefined };
  }

  const record = headers as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === "retry-after") {
      const val = record[key];
      if (val !== undefined && val !== null) {
        return { found: true, raw: val };
      }
    }
  }
  return { found: false, raw: undefined };
}

function extractRawRetryAfterCandidate(source: unknown): {
  found: boolean;
  raw: unknown;
} {
  if (source === null || source === undefined) {
    return { found: false, raw: undefined };
  }
  if (typeof source === "string" || typeof source === "number" || typeof source === "boolean") {
    return { found: true, raw: source };
  }
  if (Array.isArray(source)) {
    return { found: true, raw: source };
  }
  if (typeof source !== "object") {
    return { found: true, raw: source };
  }

  const obj = source as Record<string, unknown>;

  if (obj.response && typeof obj.response === "object") {
    const resp = obj.response as Record<string, unknown>;
    if ("headers" in resp) {
      return readHeaderValueFromContainer(resp.headers);
    }
  }

  if ("headers" in obj) {
    return readHeaderValueFromContainer(obj.headers);
  }

  const direct = readHeaderValueFromContainer(obj);
  if (direct.found) return direct;

  return { found: false, raw: undefined };
}

/**
 * Parse, validate, and clamp an untrusted RPC `Retry-After` header value or
 * error/response container against an authoritative `maxBackoffMs` ceiling.
 *
 * - Rejects negative, zero, `NaN`, `Infinity`, scientific-notation, trailing-junk,
 *   multi-valued, and oversized header values without echoing untrusted text.
 * - Clamps valid delta-seconds and future IMF-fixdate HTTP dates strictly to
 *   `maxBackoffMs` so an untrusted upstream header can never stall polling past
 *   operator-configured bounds.
 */
export function evaluateRpcRetryAfter(
  source: unknown,
  options: ClampRpcRetryDelayOptions = {},
): RpcRetryDelayEvaluation {
  const maxBackoffMs = validateMaxBackoffMs(options.maxBackoffMs);
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const rejectAboveMs =
    options.rejectAboveMs !== undefined
      ? validateMaxBackoffMs(options.rejectAboveMs)
      : null;

  const extracted = extractRawRetryAfterCandidate(source);
  if (!extracted.found) {
    return {
      accepted: false,
      clamped: false,
      rawDelayMs: null,
      delayMs: null,
      rejectedReason: "missing",
    };
  }

  const raw = extracted.raw;
  let rawDelayMs: number;

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "non-finite",
      };
    }
    if (raw < 0) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "negative",
      };
    }
    if (raw === 0) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: 0,
        delayMs: null,
        rejectedReason: "non-positive",
      };
    }
    const ms = Math.ceil(raw * 1_000);
    if (!Number.isFinite(ms) || ms > Number.MAX_SAFE_INTEGER) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "oversized",
      };
    }
    rawDelayMs = ms;
  } else if (typeof raw === "string") {
    if (raw.length > MAX_RPC_RETRY_HEADER_CHARS) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "oversized",
      };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "malformed",
      };
    }
    if (
      trimmed === "NaN" ||
      trimmed === "Infinity" ||
      trimmed === "+Infinity" ||
      trimmed === "-Infinity"
    ) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "non-finite",
      };
    }
    if (STRICT_SIGNED_NEGATIVE_RE.test(trimmed)) {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "negative",
      };
    }

    if (STRICT_UNSIGNED_DECIMAL_RE.test(trimmed)) {
      const seconds = Number(trimmed);
      if (!Number.isFinite(seconds)) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: null,
          delayMs: null,
          rejectedReason: "non-finite",
        };
      }
      if (seconds === 0) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: 0,
          delayMs: null,
          rejectedReason: "non-positive",
        };
      }
      const ms = Math.ceil(seconds * 1_000);
      if (!Number.isFinite(ms) || ms > Number.MAX_SAFE_INTEGER) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: null,
          delayMs: null,
          rejectedReason: "oversized",
        };
      }
      rawDelayMs = ms;
    } else if (IMF_FIXDATE_RE.test(trimmed)) {
      const targetEpochMs = Date.parse(trimmed);
      if (!Number.isFinite(targetEpochMs)) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: null,
          delayMs: null,
          rejectedReason: "malformed",
        };
      }
      const deltaMs = targetEpochMs - nowMs;
      if (deltaMs < 0) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: null,
          delayMs: null,
          rejectedReason: "negative",
        };
      }
      if (deltaMs === 0) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: 0,
          delayMs: null,
          rejectedReason: "non-positive",
        };
      }
      if (!Number.isFinite(deltaMs) || deltaMs > Number.MAX_SAFE_INTEGER) {
        return {
          accepted: false,
          clamped: false,
          rawDelayMs: null,
          delayMs: null,
          rejectedReason: "oversized",
        };
      }
      rawDelayMs = Math.ceil(deltaMs);
    } else {
      return {
        accepted: false,
        clamped: false,
        rawDelayMs: null,
        delayMs: null,
        rejectedReason: "malformed",
      };
    }
  } else {
    return {
      accepted: false,
      clamped: false,
      rawDelayMs: null,
      delayMs: null,
      rejectedReason: "malformed",
    };
  }

  if (rejectAboveMs !== null && rawDelayMs > rejectAboveMs) {
    return {
      accepted: false,
      clamped: false,
      rawDelayMs,
      delayMs: null,
      rejectedReason: "oversized",
    };
  }

  const clamped = rawDelayMs > maxBackoffMs;
  const delayMs = clamped ? maxBackoffMs : rawDelayMs;

  return {
    accepted: true,
    clamped,
    rawDelayMs,
    delayMs,
    rejectedReason: null,
  };
}

/**
 * Extract and clamp an untrusted RPC `Retry-After` delay in milliseconds,
 * returning `null` when missing or rejected.
 */
export function clampRpcRetryAfterMs(
  source: unknown,
  options: ClampRpcRetryDelayOptions = {},
): number | null {
  return evaluateRpcRetryAfter(source, options).delayMs;
}

/**
 * Resolve the effective RPC backoff delay in milliseconds from a local
 * exponential backoff calculation and an optional untrusted RPC error/header.
 *
 * Keeps `maxBackoffMs` strictly authoritative and prevents an untrusted small
 * `Retry-After` value from undercutting `computedBackoffMs`.
 */
export function resolveRpcRetryDelayMs(
  source: unknown,
  options: ResolveRpcRetryDelayOptions,
): number {
  const maxBackoffMs = validateMaxBackoffMs(options.maxBackoffMs);
  const baseBackoff =
    typeof options.computedBackoffMs === "number" &&
    Number.isFinite(options.computedBackoffMs) &&
    options.computedBackoffMs > 0
      ? Math.min(Math.ceil(options.computedBackoffMs), maxBackoffMs)
      : maxBackoffMs;

  const headerDelay = clampRpcRetryAfterMs(source, options);
  if (headerDelay === null) {
    return baseBackoff;
  }

  return Math.min(Math.max(baseBackoff, headerDelay), maxBackoffMs);
}
