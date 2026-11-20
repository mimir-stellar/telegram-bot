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

// ── RPC egress allowlist & redirect guard ────────────────────────────────────

export type RpcEgressProblem =
  | "invalid-url"
  | "credentials-not-allowed"
  | "protocol-not-allowed"
  | "host-not-allowed"
  | "redirect-disallowed"
  | "redirect-limit-exceeded";

/**
 * Error thrown when an RPC URL or HTTP redirect destination violates the
 * operator-configured egress allowlist or security policy.
 *
 * Messages never include embedded URL credentials or query strings.
 */
export class RpcEgressError extends Error {
  readonly problem: RpcEgressProblem;

  constructor(problem: RpcEgressProblem, message: string) {
    super(message);
    this.name = "RpcEgressError";
    this.problem = problem;
  }
}

export interface RpcEgressAllowlistOptions {
  /** Operator-configured allowlist entries (host, host:port, *.domain, or full origin URL). */
  allowlist?: readonly string[] | undefined;
  /** Permit credential-free loopback URLs (127.0.0.1, localhost, ::1) for mock mode. */
  allowLoopback?: boolean | undefined;
  /** Permit plain http: for non-loopback allowlisted entries (default false: https: required). */
  allowHttp?: boolean | undefined;
}

export interface EgressGuardedFetchOptions extends RpcEgressAllowlistOptions {
  /** Underlying fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch | undefined;
  /** Maximum redirect hops to follow after validating each destination (defaults to 5). */
  maxRedirects?: number | undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Parse a comma-separated string or array of RPC egress allowlist entries. */
export function parseRpcEgressAllowlist(
  raw: string | readonly string[] | undefined,
): string[] {
  if (!raw) return [];
  const items = typeof raw === "string" ? raw.split(",") : raw;
  return items.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** True when `hostname` refers to a local loopback address. */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

function safeOriginLabel(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function matchesAllowlistEntry(url: URL, rawEntry: string): boolean {
  const entry = rawEntry.trim();
  if (!entry) return false;

  if (entry.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return false;
    }
    return url.origin.toLowerCase() === parsed.origin.toLowerCase();
  }

  const lowerEntry = entry.toLowerCase();
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  if (lowerEntry.startsWith("*.")) {
    const suffix = lowerEntry.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }

  if (lowerEntry.includes(":")) {
    return host === lowerEntry;
  }

  return hostname === lowerEntry;
}

function entryAllowsHttpOrigin(url: URL, rawEntry: string): boolean {
  if (!rawEntry.includes("://")) return false;
  try {
    const parsed = new URL(rawEntry);
    return (
      parsed.protocol === "http:" &&
      url.origin.toLowerCase() === parsed.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Validate an RPC URL against the operator-configured egress allowlist.
 *
 * - Rejects malformed URLs.
 * - Rejects embedded username/password credentials (even on loopback).
 * - Retains a credential-free loopback exception when `options.allowLoopback` is true.
 * - Requires `https:` unless credential-free loopback, `allowHttp: true`, or an
 *   explicit `http://` origin entry in `allowlist`.
 */
export function assertAllowedRpcUrl(
  rawUrl: string,
  options: RpcEgressAllowlistOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RpcEgressError("invalid-url", "RPC URL is not a valid URL");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new RpcEgressError(
      "credentials-not-allowed",
      `RPC URL for ${safeOriginLabel(parsed)} must not contain embedded credentials`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RpcEgressError(
      "protocol-not-allowed",
      `RPC URL protocol "${parsed.protocol}" is not allowed`,
    );
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (options.allowLoopback && loopback) {
    return parsed;
  }

  const allowlist = parseRpcEgressAllowlist(options.allowlist);
  const matchedEntry = allowlist.find((entry) => matchesAllowlistEntry(parsed, entry));
  if (!matchedEntry) {
    throw new RpcEgressError(
      "host-not-allowed",
      `RPC egress destination ${safeOriginLabel(parsed)} is not in the configured allowlist`,
    );
  }

  if (
    parsed.protocol === "http:" &&
    !options.allowHttp &&
    !entryAllowsHttpOrigin(parsed, matchedEntry)
  ) {
    throw new RpcEgressError(
      "protocol-not-allowed",
      `Plain HTTP is not allowed for RPC egress destination ${safeOriginLabel(parsed)}`,
    );
  }

  return parsed;
}

/**
 * Resolve and validate an HTTP redirect `Location` target against the egress allowlist.
 */
export function validateRpcRedirect(
  currentUrl: string,
  locationHeader: string,
  options: RpcEgressAllowlistOptions = {},
): URL {
  let target: URL;
  try {
    target = new URL(locationHeader, currentUrl);
  } catch {
    throw new RpcEgressError("redirect-disallowed", "RPC redirect Location is not a valid URL");
  }
  try {
    return assertAllowedRpcUrl(target.toString(), options);
  } catch (err) {
    if (err instanceof RpcEgressError) {
      throw new RpcEgressError(
        err.problem === "credentials-not-allowed" ? "credentials-not-allowed" : "redirect-disallowed",
        `RPC redirect blocked (${err.problem}): ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * Create a `fetch` wrapper that validates both the initial RPC URL and every
 * HTTP redirect destination against the configured egress allowlist.
 */
export function createEgressGuardedFetch(
  options: EgressGuardedFetchOptions = {},
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 5;

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const initialUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    let currentUrl = assertAllowedRpcUrl(initialUrl, options).toString();
    let redirects = 0;

    for (;;) {
      const response = await fetchImpl(currentUrl, {
        ...init,
        redirect: "manual",
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      redirects++;
      if (redirects > maxRedirects) {
        throw new RpcEgressError(
          "redirect-limit-exceeded",
          `RPC egress exceeded maximum redirect hops (${maxRedirects})`,
        );
      }

      currentUrl = validateRpcRedirect(currentUrl, location, options).toString();
    }
  };
}
