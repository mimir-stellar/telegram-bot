/** Decode outcome telemetry stub — no-op placeholder. */
export type DecodeOutcome = "decoded" | "admin" | "unknown" | "malformed";

export function recordDecodeOutcome(
  _source: string,
  _eventName: string,
  _outcome: DecodeOutcome,
): void {
  // No-op stub.
}
