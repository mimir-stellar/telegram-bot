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

/** The transport/protocol layer an RPC failure originated from. */
export type RpcFailureCategory = "dns" | "tls" | "http" | "timeout" | "transport";

/** Stable, redacted reason codes; never derived from untrusted error text. */
export type RpcFailureReasonCode =
  | "dns_not_found"
  | "dns_temp_failure"
  | "dns_lookup_failed"
  | "tls_cert_expired"
  | "tls_cert_untrusted"
  | "tls_hostname_mismatch"
  | "tls_handshake_timeout"
  | "tls_protocol_error"
  | "http_rate_limited"
  | "http_request_timeout"
  | "http_unauthorized"
  | "http_not_found"
  | "http_client_error"
  | "http_server_error"
  | "http_unexpected_status"
  | "request_timeout"
  | "connection_refused"
  | "connection_reset"
  | "network_unreachable"
  | "transport_error";

/**
 * Result of classifying an RPC failure. `summary` is built only from the
 * category, reason code, and numeric HTTP status, so it is safe for logs,
 * `/status`, and operator messages without further redaction.
 */
export interface RpcFailureClassification {
  readonly category: RpcFailureCategory;
  readonly reasonCode: RpcFailureReasonCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly summary: string;
}

const MAX_ERROR_CAUSE_DEPTH = 8;

const DNS_NOT_FOUND_CODES = new Set(["ENOTFOUND", "EAI_NONAME", "EAI_NODATA"]);
const DNS_TEMP_CODES = new Set(["EAI_AGAIN"]);
const DNS_OTHER_CODES = new Set([
  "EAI_FAIL",
  "EAI_BADFLAGS",
  "EAI_FAMILY",
  "EAI_MEMORY",
  "EAI_SERVICE",
  "EAI_SOCKTYPE",
]);

const TLS_EXPIRED_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_EXPIRED",
]);
const TLS_UNTRUSTED_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "CERT_CHAIN_TOO_LONG",
  "CERT_SIGNATURE_FAILURE",
  "INVALID_CA",
]);
const TLS_HOSTNAME_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "HOSTNAME_MISMATCH",
]);
const TLS_TIMEOUT_CODES = new Set(["ERR_TLS_HANDSHAKE_TIMEOUT"]);

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);
const CONN_REFUSED_CODES = new Set(["ECONNREFUSED"]);
const CONN_RESET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const NET_UNREACHABLE_CODES = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
]);

function buildFailureResult(
  category: RpcFailureCategory,
  reasonCode: RpcFailureReasonCode,
  retryable: boolean,
  httpStatus: number | null = null,
): RpcFailureClassification {
  return {
    category,
    reasonCode,
    retryable,
    httpStatus,
    summary:
      category === "http" && httpStatus !== null
        ? `RPC HTTP ${httpStatus} failure (${reasonCode})`
        : `RPC ${category.toUpperCase()} failure (${reasonCode})`,
  };
}

function classifyHttpStatus(status: number): RpcFailureClassification {
  if (status === 429) return buildFailureResult("http", "http_rate_limited", true, status);
  if (status === 408) return buildFailureResult("http", "http_request_timeout", true, status);
  if (status === 401 || status === 403) {
    return buildFailureResult("http", "http_unauthorized", false, status);
  }
  if (status === 404 || status === 410) {
    return buildFailureResult("http", "http_not_found", false, status);
  }
  if (status >= 400 && status <= 499) {
    return buildFailureResult("http", "http_client_error", false, status);
  }
  if (status >= 500 && status <= 599) {
    return buildFailureResult("http", "http_server_error", true, status);
  }
  return buildFailureResult("http", "http_unexpected_status", false, status);
}

function extractHttpStatusCandidate(node: Record<string, unknown>): number | null {
  const response = isRecord(node.response) ? node.response : null;
  const candidates = [response?.status, response?.statusCode, node.status, node.statusCode];
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return null;
}

function classifyErrorCode(
  rawCode: string,
  syscall: string,
): RpcFailureClassification | null {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;

  if (DNS_NOT_FOUND_CODES.has(code)) return buildFailureResult("dns", "dns_not_found", false);
  if (DNS_TEMP_CODES.has(code)) return buildFailureResult("dns", "dns_temp_failure", true);
  if (DNS_OTHER_CODES.has(code) || code.startsWith("ERR_DNS_") || syscall === "getaddrinfo") {
    return buildFailureResult("dns", "dns_lookup_failed", true);
  }

  if (TLS_EXPIRED_CODES.has(code)) return buildFailureResult("tls", "tls_cert_expired", false);
  if (TLS_UNTRUSTED_CODES.has(code)) return buildFailureResult("tls", "tls_cert_untrusted", false);
  if (TLS_HOSTNAME_CODES.has(code)) {
    return buildFailureResult("tls", "tls_hostname_mismatch", false);
  }
  if (TLS_TIMEOUT_CODES.has(code)) {
    return buildFailureResult("tls", "tls_handshake_timeout", true);
  }
  if (
    code === "EPROTO" ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("SSL_")
  ) {
    return buildFailureResult("tls", "tls_protocol_error", false);
  }

  if (TIMEOUT_CODES.has(code)) return buildFailureResult("timeout", "request_timeout", true);
  if (CONN_REFUSED_CODES.has(code)) {
    return buildFailureResult("transport", "connection_refused", true);
  }
  if (CONN_RESET_CODES.has(code)) return buildFailureResult("transport", "connection_reset", true);
  if (NET_UNREACHABLE_CODES.has(code)) {
    return buildFailureResult("transport", "network_unreachable", true);
  }
  return null;
}

function unwrapErrorChain(root: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];

  while (queue.length > 0 && nodes.length < MAX_ERROR_CAUSE_DEPTH) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    nodes.push(record);

    if (isRecord(record.cause)) queue.push(record.cause);
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        if (nested !== null && typeof nested === "object") queue.push(nested);
      }
    }
  }
  return nodes;
}

/**
 * Classify an RPC error into a separated category with a stable redacted
 * reason code and the retryability decision for that failure mode. Ordinary
 * misconfigurations are non-retryable; transient outages stay retryable.
 * Untrusted message text is only pattern-matched, never copied into the result.
 */
export function classifyRpcFailure(err: unknown): RpcFailureClassification {
  const chain = unwrapErrorChain(err);

  for (const node of chain) {
    const status = extractHttpStatusCandidate(node);
    if (status !== null) return classifyHttpStatus(status);
  }

  for (const node of chain) {
    const code = typeof node.code === "string" ? node.code : "";
    const syscall = typeof node.syscall === "string" ? node.syscall.toLowerCase() : "";
    const byCode = classifyErrorCode(code, syscall);
    if (byCode !== null) return byCode;
    if (node.name === "TimeoutError") {
      return buildFailureResult("timeout", "request_timeout", true);
    }
  }

  const messages: string[] = [];
  if (typeof err === "string") messages.push(err);
  for (const node of chain) {
    if (typeof node.message === "string") messages.push(node.message);
  }

  for (const message of messages) {
    const statusMatch = /\bstatus code (\d{3})\b/i.exec(message) ?? /\bHTTP (\d{3})\b/i.exec(message);
    if (statusMatch?.[1]) {
      const status = Number(statusMatch[1]);
      if (status >= 100 && status <= 599) return classifyHttpStatus(status);
    }

    if (/\b(?:ENOTFOUND|EAI_NONAME|EAI_NODATA)\b/i.test(message)) {
      return buildFailureResult("dns", "dns_not_found", false);
    }
    if (/\bEAI_AGAIN\b/i.test(message)) {
      return buildFailureResult("dns", "dns_temp_failure", true);
    }
    if (/\bgetaddrinfo\b/i.test(message)) {
      return buildFailureResult("dns", "dns_lookup_failed", true);
    }

    if (/\b(?:CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|certificate has expired)\b/i.test(message)) {
      return buildFailureResult("tls", "tls_cert_expired", false);
    }
    if (
      /\b(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self[- ]signed certificate)\b/i.test(
        message,
      )
    ) {
      return buildFailureResult("tls", "tls_cert_untrusted", false);
    }
    if (/\b(?:ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match certificate)\b/i.test(message)) {
      return buildFailureResult("tls", "tls_hostname_mismatch", false);
    }
    if (/\b(?:SSL routines|TLS alert|ERR_TLS_|ERR_SSL_|EPROTO)\b/i.test(message)) {
      return buildFailureResult("tls", "tls_protocol_error", false);
    }

    if (/\b(?:ETIMEDOUT|timed? ?out)\b/i.test(message)) {
      return buildFailureResult("timeout", "request_timeout", true);
    }
    if (/\bECONNREFUSED\b/i.test(message)) {
      return buildFailureResult("transport", "connection_refused", true);
    }
    if (/\b(?:ECONNRESET|EPIPE|socket hang up)\b/i.test(message)) {
      return buildFailureResult("transport", "connection_reset", true);
    }
  }

  return buildFailureResult("transport", "transport_error", true);
}

/** True when {@link classifyRpcFailure} marks the failure as retryable. */
export function isRetryableRpcFailure(err: unknown): boolean {
  return classifyRpcFailure(err).retryable;
}

/** Return the fixed, secret-free summary for an RPC failure. */
export function formatClassifiedRpcFailure(err: unknown): string {
  return classifyRpcFailure(err).summary;
}
