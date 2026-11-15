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

// ── Endpoint URL credential guard ────────────────────────────────────────────

export type RpcEndpointUrlProblem =
  | "not-a-string"
  | "invalid-url"
  | "unsupported-protocol"
  | "embedded-credentials";

const VALID_CONFIG_KEY_RE = /^[A-Z0-9_]{1,80}$/;

function sanitizeConfigKeyLabel(configKey: unknown): string {
  if (typeof configKey === "string") {
    const trimmed = configKey.trim();
    if (VALID_CONFIG_KEY_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return "STELLAR_RPC_URL";
}

function buildEndpointUrlErrorMessage(
  configKey: string,
  problem: RpcEndpointUrlProblem,
  httpsOnly: boolean,
): string {
  switch (problem) {
    case "embedded-credentials":
      return `${configKey} must not contain embedded credentials`;
    case "unsupported-protocol":
      return httpsOnly
        ? `${configKey} must be an https URL`
        : `${configKey} must be an http(s) URL`;
    case "not-a-string":
    case "invalid-url":
      return `${configKey} is not a valid URL`;
  }
}

/**
 * Raised when a configured RPC or service endpoint URL is malformed, uses a
 * disallowed scheme, or carries embedded URL userinfo credentials.
 *
 * The message reports ONLY the affected configuration key (`configKey`) and
 * never echoes the raw URL, hostname, username, password, or query string.
 */
export class RpcEndpointUrlError extends Error {
  readonly configKey: string;
  readonly problem: RpcEndpointUrlProblem;

  constructor(
    configKey: string,
    problem: RpcEndpointUrlProblem,
    options: { httpsOnly?: boolean | undefined } = {},
  ) {
    const safeKey = sanitizeConfigKeyLabel(configKey);
    super(buildEndpointUrlErrorMessage(safeKey, problem, Boolean(options.httpsOnly)));
    this.name = "RpcEndpointUrlError";
    this.configKey = safeKey;
    this.problem = problem;
  }
}

export interface ValidateEndpointUrlOptions {
  /** Require `https:` rather than permitting both `http:` and `https:`. */
  httpsOnly?: boolean | undefined;
}

const RAW_AUTHORITY_USERINFO_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]{2}[^/?#]*@/;

/**
 * Return `true` when `rawUrl` contains embedded URL userinfo (`user:pass@host`,
 * `user@host`, `:pass@host`, or `@host`), including backslash-normalized or
 * otherwise unparseable authority segments.
 */
export function hasEmbeddedUrlCredentials(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (RAW_AUTHORITY_USERINFO_RE.test(trimmed)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

/**
 * Validate a configured endpoint URL before startup or client construction.
 *
 * Rejects embedded URL credentials (`username`, `password`, or `@` authority
 * userinfo), unsupported schemes, and unparseable values while reporting ONLY
 * the affected configuration key.
 */
export function validateEndpointUrl(
  rawUrl: unknown,
  configKey = "STELLAR_RPC_URL",
  options: ValidateEndpointUrlOptions = {},
): URL {
  const safeKey = sanitizeConfigKeyLabel(configKey);

  if (typeof rawUrl !== "string") {
    throw new RpcEndpointUrlError(safeKey, "not-a-string", options);
  }

  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    throw new RpcEndpointUrlError(safeKey, "invalid-url", options);
  }

  if (hasEmbeddedUrlCredentials(trimmed)) {
    throw new RpcEndpointUrlError(safeKey, "embedded-credentials", options);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RpcEndpointUrlError(safeKey, "invalid-url", options);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new RpcEndpointUrlError(safeKey, "embedded-credentials", options);
  }

  if (options.httpsOnly) {
    if (parsed.protocol !== "https:") {
      throw new RpcEndpointUrlError(safeKey, "unsupported-protocol", options);
    }
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcEndpointUrlError(safeKey, "unsupported-protocol", options);
  }

  return parsed;
}

/**
 * Assert that `rawUrl` is a valid credential-free HTTP(S) RPC URL and return
 * its trimmed representation.
 */
export function assertCredentialFreeRpcUrl(
  rawUrl: unknown,
  configKey = "STELLAR_RPC_URL",
): string {
  validateEndpointUrl(rawUrl, configKey);
  return (rawUrl as string).trim();
}
