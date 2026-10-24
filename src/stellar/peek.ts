/**
 * Fast topic inspection helpers for Soroban events.
 *
 * Decoding full event values (`scValToNative` on `event.value`) is the dominant
 * CPU cost when scanning busy contracts. `peekEventName` extracts only the
 * event name symbol from `topic[0]` without touching subsequent topics or the
 * payload value, allowing callers to filter or count events cheaply.
 */

import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";

/**
 * Extract the event name from the first topic symbol of a raw Soroban event.
 *
 * Soroban contract events encode the event name as an `xdr.ScVal` (symbol,
 * string, or bytes) in `topic[0]`.
 *
 * Returns the decoded event name string, or `""` if the event is malformed,
 * missing topics, or topic[0] is not a valid event name string/symbol.
 * Never throws.
 */
export function peekEventName(rawEvent: unknown): string {
  if (!rawEvent || typeof rawEvent !== "object") {
    return "";
  }

  const topic = (rawEvent as Partial<rpc.Api.EventResponse>).topic;
  if (!Array.isArray(topic) || topic.length === 0) {
    return "";
  }

  const first = topic[0];
  if (first === null || first === undefined) {
    return "";
  }

  // If already decoded as string
  if (typeof first === "string") {
    return first;
  }

  // If already a Buffer / Uint8Array
  if (first instanceof Uint8Array) {
    try {
      return Buffer.from(first).toString("utf8");
    } catch {
      return "";
    }
  }

  // Soroban RPC returns `topic[0]` as an ScVal object or string/buffer
  try {
    const nativeVal = scValToNative(first as xdr.ScVal);
    if (typeof nativeVal === "string") {
      return nativeVal;
    }
    if (nativeVal instanceof Uint8Array) {
      return Buffer.from(nativeVal).toString("utf8");
    }
    return "";
  } catch {
    return "";
  }
}
