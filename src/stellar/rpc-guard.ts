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

// ── Operator-configured RPC egress allowlists & redirect validation ──────────
//
// Outbound Soroban RPC calls must honour operator-configured egress allowlists
// (`STELLAR_RPC_ALLOWLIST`) across both initial endpoint URLs and HTTP redirect
// hops (`Location`), while retaining a credential-free loopback exception for
// local `MIMIR_PROFILE=mock` operation.

/** Default maximum HTTP redirect hops followed when egress validation is active. */
export const DEFAULT_MAX_RPC_REDIRECTS = 3;

export type RpcEgressProblem =
  | "disallowed-origin"
  | "embedded-credentials"
  | "unsupported-protocol"
  | "invalid-url"
  | "redirect-missing-location"
  | "too-many-redirects";

export type RpcEgressPhase = "initial" | "redirect";

/**
 * Bounded, secret-free error thrown when an outbound RPC request or redirect
 * destination violates the operator's RPC egress policy.
 */
export class RpcEgressError extends Error {
  readonly problem: RpcEgressProblem;
  readonly phase: RpcEgressPhase;

  constructor(problem: RpcEgressProblem, phase: RpcEgressPhase, message: string) {
    super(message);
    this.name = "RpcEgressError";
    this.problem = problem;
    this.phase = phase;
  }
}

/**
 * True when `hostname` (from `URL.hostname`) is a local loopback address:
 * `localhost`, `127.0.0.0/8`, or IPv6 `[::1]` / `::1`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }
  return false;
}

/**
 * Normalize one allowlist token into a canonical origin (`scheme://host[:port]`).
 *
 * Accepts either:
 * - Full HTTP(S) origin without path/query/fragment/credentials (`https://soroban-testnet.stellar.org`, `http://127.0.0.1:8000`)
 * - Bare `host` or `host:port` (normalized to `https://host[:port]`)
 *
 * Rejects wildcards, credentials, paths, query strings, and non-HTTP(S) schemes.
 */
export function normalizeRpcAllowlistEntry(rawEntry: string): string {
  if (typeof rawEntry !== "string") {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry must be a non-empty string",
    );
  }
  const trimmed = rawEntry.trim();
  if (trimmed.length === 0) {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry cannot be empty",
    );
  }
  if (trimmed.includes("*")) {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry cannot contain wildcards",
    );
  }

  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry is not a valid origin or host",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcEgressError(
      "unsupported-protocol",
      "initial",
      `RPC allowlist entry must use http:// or https://; got ${parsed.protocol}`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "" || candidate.includes("@")) {
    throw new RpcEgressError(
      "embedded-credentials",
      "initial",
      "RPC allowlist entry must not contain embedded credentials",
    );
  }
  if (
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry must be an origin or host[:port] without path, query, or fragment",
    );
  }
  if (!parsed.hostname || parsed.origin === "null") {
    throw new RpcEgressError(
      "invalid-url",
      "initial",
      "RPC allowlist entry is missing a valid hostname",
    );
  }

  return parsed.origin.toLowerCase();
}

/**
 * Parse a comma-separated `STELLAR_RPC_ALLOWLIST` string into deduplicated
 * canonical origin strings. Empty/whitespace input returns `[]`.
 */
export function parseRpcAllowlist(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw.trim() === "") return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    seen.add(normalizeRpcAllowlistEntry(trimmed));
  }
  return [...seen];
}

export interface AssertRpcEgressOptions {
  /** Normalized or raw allowlist entries. Empty/omitted disables allowlist restriction. */
  allowlist?: readonly string[] | undefined;
  /**
   * When true (`MIMIR_PROFILE=mock`), credential-free loopback destinations
   * (`localhost`, `127.0.0.0/8`, `[::1]`) are permitted even when absent from `allowlist`.
   */
  mockMode?: boolean | undefined;
  /** Whether validating the initial request URL or an HTTP redirect `Location`. */
  phase?: RpcEgressPhase | undefined;
}

function hasRawUserinfoBeforeHost(rawUrl: string): boolean {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(rawUrl.trim());
  return schemeMatch !== null && (schemeMatch[1] ?? "").includes("@");
}

/**
 * Validate a target RPC URL (initial request or redirect hop) against protocol,
 * credential-free, and operator egress allowlist rules.
 */
export function assertRpcEgressAllowed(
  targetUrl: string,
  options: AssertRpcEgressOptions = {},
): URL {
  const phase: RpcEgressPhase = options.phase ?? "initial";
  if (typeof targetUrl !== "string" || targetUrl.trim() === "") {
    throw new RpcEgressError(
      "invalid-url",
      phase,
      `RPC ${phase} URL is missing or invalid`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl.trim());
  } catch {
    throw new RpcEgressError(
      "invalid-url",
      phase,
      `RPC ${phase} URL could not be parsed`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcEgressError(
      "unsupported-protocol",
      phase,
      `RPC ${phase} URL uses unsupported protocol "${parsed.protocol}"`,
    );
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    hasRawUserinfoBeforeHost(targetUrl)
  ) {
    throw new RpcEgressError(
      "embedded-credentials",
      phase,
      `RPC ${phase} URL must not contain embedded credentials`,
    );
  }

  const canonicalOrigin = parsed.origin.toLowerCase();
  const rawAllowlist = options.allowlist ?? [];
  if (rawAllowlist.length === 0) {
    return parsed;
  }

  // Credential-free loopback exception for mock mode (already verified credential-free above).
  if (options.mockMode === true && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }

  const normalizedAllowed = new Set<string>();
  for (const entry of rawAllowlist) {
    normalizedAllowed.add(normalizeRpcAllowlistEntry(entry));
  }

  if (!normalizedAllowed.has(canonicalOrigin)) {
    throw new RpcEgressError(
      "disallowed-origin",
      phase,
      `RPC ${phase} destination "${canonicalOrigin}" is not in STELLAR_RPC_ALLOWLIST`,
    );
  }

  return parsed;
}
