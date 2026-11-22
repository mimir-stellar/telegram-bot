/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import type { rpc } from "@stellar/stellar-sdk";

import { resolveMaxBackoffMs } from "./client.js";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

export type RpcNetworkIdentityProblem =
  | "not-an-object"
  | "malformed-passphrase"
  | "passphrase-mismatch";

/**
 * Error thrown when an RPC endpoint's `getNetwork` response fails network
 * identity validation.
 *
 * Messages are strictly bounded and never echo configured or reported
 * passphrases.
 */
export class RpcNetworkIdentityError extends Error {
  readonly problem: RpcNetworkIdentityProblem;

  constructor(problem: RpcNetworkIdentityProblem, message: string) {
    super(message);
    this.name = "RpcNetworkIdentityError";
    this.problem = problem;
  }
}

export interface VerifiedNetworkIdentity {
  passphrase: string;
}

/**
 * Validate a `getNetwork` RPC response against the configured network passphrase.
 *
 * Rejects non-object payloads, missing or non-string passphrases, and endpoints
 * reporting a different network passphrase than configured. Error messages are
 * bounded and never echo the raw passphrases.
 *
 * @param value The raw `getNetwork` response value to validate.
 * @param expectedPassphrase The configured Stellar network passphrase.
 * @returns The verified network identity.
 * @throws {RpcNetworkIdentityError} When the response is malformed or serves another network.
 */
export function assertNetworkIdentity(
  value: unknown,
  expectedPassphrase: string,
): VerifiedNetworkIdentity {
  if (!isRecord(value)) {
    throw new RpcNetworkIdentityError(
      "not-an-object",
      `RPC getNetwork response must be an object; got ${value === null ? "null" : typeof value}`,
    );
  }

  const rpcPassphrase = value.passphrase;
  if (typeof rpcPassphrase !== "string") {
    throw new RpcNetworkIdentityError(
      "malformed-passphrase",
      `RPC getNetwork returned a malformed passphrase (expected a string; got ${typeof rpcPassphrase})`,
    );
  }

  if (rpcPassphrase !== expectedPassphrase) {
    throw new RpcNetworkIdentityError(
      "passphrase-mismatch",
      `RPC network passphrase does not match the configured value ` +
        `(configured=${expectedPassphrase.length} chars, received=${rpcPassphrase.length} chars)`,
    );
  }

  return { passphrase: rpcPassphrase };
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

// ── Untrusted RPC retry-delay clamping ───────────────────────────────────────

/**
 * Clamp a numeric retry delay (in milliseconds) against the configured
 * authoritative maximum backoff.
 *
 * Rejects negative, non-finite (`NaN`, `Infinity`, `-Infinity`), and
 * non-numeric values by returning `null`, and clamps oversized finite values to
 * `resolveMaxBackoffMs(maxBackoffMs)`.
 */
export function clampRetryDelayMs(
  delayMs: unknown,
  maxBackoffMs?: number,
): number | null {
  const authoritativeMax = resolveMaxBackoffMs(maxBackoffMs);
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
    return null;
  }
  return Math.min(delayMs, authoritativeMax);
}

/**
 * Parse and clamp a `Retry-After` header value (in seconds) from an untrusted
 * RPC response against the configured maximum backoff.
 *
 * Rejects negative, non-finite, empty, or trailing-garbage values (e.g.
 * `"-5"`, `"NaN"`, `"Infinity"`, `"10abc"`), rejects overflow to `Infinity`
 * when converting seconds to milliseconds, and clamps oversized delays to
 * `resolveMaxBackoffMs(maxBackoffMs)`.
 */
export function parseRetryAfterHeaderMs(
  headerValue: unknown,
  maxBackoffMs?: number,
): number | null {
  const authoritativeMax = resolveMaxBackoffMs(maxBackoffMs);

  let seconds: number;
  if (typeof headerValue === "number") {
    seconds = headerValue;
  } else if (typeof headerValue === "string") {
    const trimmed = headerValue.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return null;
    }
    seconds = Number(trimmed);
  } else {
    return null;
  }

  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const delayMs = seconds * 1000;
  if (!Number.isFinite(delayMs)) {
    return null;
  }

  return Math.min(delayMs, authoritativeMax);
}
