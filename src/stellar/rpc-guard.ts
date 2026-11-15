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

/** Default timeout in milliseconds for RPC provider admission checks. */
export const DEFAULT_PROVIDER_ADMISSION_TIMEOUT_MS = 10_000;

/** Default maximum provider records retained in an admission gate. */
export const DEFAULT_MAX_ADMISSION_RECORDS = 32;

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

// ── RPC provider network-identity admission guard ────────────────────────────

export type RpcProviderAdmissionProblem =
  | "invalid-provider"
  | "invalid-expected-passphrase"
  | "health-failed"
  | "unhealthy-status"
  | "malformed-health-window"
  | "network-failed"
  | "malformed-network"
  | "network-mismatch"
  | "provider-not-admitted";

/**
 * Bounded, secret-free error thrown when an RPC provider fails admission checks
 * (including when a healthy endpoint reports a different Stellar network).
 *
 * Neither the configured passphrase nor the provider's reported passphrase is
 * ever echoed in `message`.
 */
export class RpcProviderAdmissionError extends Error {
  readonly provider: string;
  readonly problem: RpcProviderAdmissionProblem;

  constructor(
    provider: string,
    problem: RpcProviderAdmissionProblem,
    detail: string,
  ) {
    super(`RPC provider admission rejected (${provider}) [${problem}]: ${detail}`);
    this.name = "RpcProviderAdmissionError";
    this.provider = provider;
    this.problem = problem;
  }
}

export interface VerifiedNetworkIdentity {
  protocolVersion: number | string | null;
}

/**
 * Normalize a provider endpoint URL or logical name into a credential-free,
 * query-free bounded label safe for logs and admission error messages.
 */
export function normalizeAdmissionProviderLabel(rawProvider: unknown): string {
  if (typeof rawProvider !== "string" || rawProvider.trim().length === 0) {
    throw new RpcProviderAdmissionError(
      "unknown-provider",
      "invalid-provider",
      "provider identifier must be a non-empty string",
    );
  }
  const trimmed = rawProvider.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const cleanPath = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${cleanPath}`.slice(0, 120);
    }
  } catch {
    // Allow non-URL logical names in tests after redaction.
  }
  const clean = redactUrl(trimmed).replace(/[?#].*$/, "").trim();
  if (!clean) {
    throw new RpcProviderAdmissionError(
      "unknown-provider",
      "invalid-provider",
      "provider identifier cannot be empty after redaction",
    );
  }
  return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`;
}

/**
 * Validate a `getNetwork()` response payload and verify that its `passphrase`
 * strictly matches `expectedPassphrase`.
 *
 * Never echoes either passphrase in thrown error messages.
 */
export function assertNetworkIdentity(
  networkResponse: unknown,
  expectedPassphrase: unknown,
  providerLabel = "rpc-provider",
): VerifiedNetworkIdentity {
  const safeProvider = normalizeAdmissionProviderLabel(providerLabel);

  if (typeof expectedPassphrase !== "string" || expectedPassphrase.trim().length === 0) {
    throw new RpcProviderAdmissionError(
      safeProvider,
      "invalid-expected-passphrase",
      typeof expectedPassphrase !== "string"
        ? `configured networkPassphrase must be a string; got ${typeof expectedPassphrase}`
        : "configured networkPassphrase cannot be empty",
    );
  }

  if (!isRecord(networkResponse)) {
    throw new RpcProviderAdmissionError(
      safeProvider,
      "malformed-network",
      `getNetwork response must be an object; got ${networkResponse === null ? "null" : typeof networkResponse}`,
    );
  }

  const reportedPassphrase = networkResponse.passphrase;
  if (typeof reportedPassphrase !== "string") {
    throw new RpcProviderAdmissionError(
      safeProvider,
      "malformed-network",
      `getNetwork returned a non-string passphrase (got ${reportedPassphrase === null ? "null" : typeof reportedPassphrase})`,
    );
  }

  if (reportedPassphrase !== expectedPassphrase) {
    throw new RpcProviderAdmissionError(
      safeProvider,
      "network-mismatch",
      `reported network does not match configured passphrase ` +
        `(configured=${expectedPassphrase.length} chars, received=${reportedPassphrase.length} chars)`,
    );
  }

  let protocolVersion: number | string | null = null;
  const rawProto = networkResponse.protocolVersion;
  if (typeof rawProto === "number" && Number.isSafeInteger(rawProto) && rawProto >= 0) {
    protocolVersion = rawProto;
  } else if (typeof rawProto === "string" && rawProto.trim().length > 0) {
    const trimmedProto = rawProto.trim();
    protocolVersion =
      trimmedProto.length <= 32 ? trimmedProto : `${trimmedProto.slice(0, 31)}…`;
  }

  return { protocolVersion };
}
