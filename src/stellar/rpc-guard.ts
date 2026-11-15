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

/** Default ceiling on raw HTTP response payload bytes permitted per RPC call (5 MiB). */
export const DEFAULT_RPC_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Minimum configurable response-byte ceiling accepted for STELLAR_RPC_MAX_RESPONSE_BYTES. */
export const MIN_RPC_MAX_RESPONSE_BYTES = 1_024;

export type RpcGuardProblem =
  | "not-an-object"
  | "events-not-an-array"
  | "events-oversized"
  | "response-bytes-oversized"
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

export type RpcByteLimitSource = "content-length" | "stream";

/**
 * Error thrown when an HTTP RPC response exceeds the configured byte limit.
 * Raised before `JSON.parse` runs and never echoes response payload content.
 */
export class RpcResponseByteLimitError extends RpcResponseShapeError {
  readonly maxResponseBytes: number;
  readonly observedBytes: number;
  readonly limitSource: RpcByteLimitSource;

  constructor(
    maxResponseBytes: number,
    observedBytes: number,
    limitSource: RpcByteLimitSource,
  ) {
    const detail =
      limitSource === "content-length"
        ? `RPC response Content-Length (${observedBytes} bytes) exceeds configured limit of ${maxResponseBytes} bytes`
        : `RPC response stream (${observedBytes} bytes read) exceeds configured limit of ${maxResponseBytes} bytes`;
    super("response-bytes-oversized", detail);
    this.name = "RpcResponseByteLimitError";
    this.maxResponseBytes = maxResponseBytes;
    this.observedBytes = observedBytes;
    this.limitSource = limitSource;
  }
}

export interface ReadBoundedRpcJsonOptions {
  /** Maximum permitted response payload size in bytes. Defaults to {@link DEFAULT_RPC_MAX_RESPONSE_BYTES}. */
  maxResponseBytes?: number | undefined;
  /** Optional controller aborted immediately when the response exceeds `maxResponseBytes`. */
  abortController?: AbortController | undefined;
  /** Injectable JSON parser (used in tests to verify `JSON.parse` is never reached). */
  parseJson?: ((text: string) => unknown) | undefined;
}

function validateMaxResponseBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RPC_MAX_RESPONSE_BYTES;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(
      `maxResponseBytes must be a positive safe integer; got ${String(value)}`,
    );
  }
  return resolved;
}

/**
 * Read a Fetch `Response` body up to `maxResponseBytes` and parse it as JSON.
 *
 * - Rejects oversized `Content-Length` headers up front before reading body chunks.
 * - Cancels the stream and aborts `abortController` on the first chunk that pushes
 *   cumulative bytes past `maxResponseBytes`, BEFORE `TextDecoder` or `JSON.parse` runs.
 */
export async function readBoundedRpcJson(
  response: Response,
  options: ReadBoundedRpcJsonOptions = {},
): Promise<unknown> {
  const maxBytes = validateMaxResponseBytes(options.maxResponseBytes);
  const parseJson = options.parseJson ?? JSON.parse;

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== "") {
    const declared = Number(contentLengthHeader.trim());
    if (Number.isFinite(declared) && declared > maxBytes) {
      const err = new RpcResponseByteLimitError(maxBytes, Math.floor(declared), "content-length");
      options.abortController?.abort(err);
      if (response.body) {
        await response.body.cancel(err).catch(() => {});
      }
      throw err;
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const err = new RpcResponseByteLimitError(maxBytes, totalBytes, "stream");
        options.abortController?.abort(err);
        await reader.cancel(err).catch(() => {});
        throw err;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(combined);
  if (text.length === 0) return "";
  try {
    return parseJson(text);
  } catch {
    return text;
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
