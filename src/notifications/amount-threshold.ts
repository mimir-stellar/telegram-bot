/**
 * Amount threshold filtering for notifications.
 *
 * Lets operators hide small deposits and challenges in busy chats.
 * Amounts are parsed as 7-decimal atomic USDC units (Stellar Asset Contract)
 * using integer arithmetic only (no floating point).
 */

import type { DecodedEvent } from "../stellar/decode.js";
import type { SourceRange } from "./filter-expr.js";

/** Stable machine-readable error codes for USDC threshold validation. */
export type InvalidThresholdCode =
  | "THRESHOLD_NOT_STRING"
  | "THRESHOLD_EMPTY"
  | "THRESHOLD_NEGATIVE"
  | "THRESHOLD_LEADING_PLUS"
  | "THRESHOLD_MALFORMED"
  | "THRESHOLD_PRECISION_EXCEEDED";

/** Error thrown when a threshold string is negative, malformed, or invalid. */
export class InvalidThresholdError extends Error {
  readonly code: InvalidThresholdCode;
  readonly range: SourceRange;

  constructor(
    message: string,
    code: InvalidThresholdCode = "THRESHOLD_MALFORMED",
    range: SourceRange = { start: 0, end: 0 },
  ) {
    super(message);
    this.name = "InvalidThresholdError";
    this.code = code;
    this.range = range;
  }
}

/** Threshold configuration for event filtering. */
export interface AmountThresholds {
  /** Minimum stake for claim_challenged (market). 0 or unset means no filtering. */
  marketChallenge?: bigint;
  /** Minimum amount for deposited (squad). 0 or unset means no filtering. */
  squadDeposit?: bigint;
}

/**
 * Parses a decimal string representing a USDC amount into atomic 7-decimal units (bigint).
 *
 * For example:
 * - "1" -> 10_000_000n
 * - "0.5" -> 5_000_000n
 * - "0.0000001" -> 1n
 *
 * Rejects negative numbers, invalid decimal formatting, or excess decimal precision (> 7 places)
 * with an {@link InvalidThresholdError}.
 * Surrounding whitespace is trimmed.
 */
export function parseUsdcThreshold(text: string): bigint {
  if (typeof text !== "string") {
    throw new InvalidThresholdError(
      `Threshold must be a string, got ${typeof text}`,
      "THRESHOLD_NOT_STRING",
      { start: 0, end: 0 },
    );
  }

  const leadingWs = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const tokenRange: SourceRange = { start: leadingWs, end: leadingWs + trimmed.length };
  const label = trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 31)}…`;

  if (trimmed === "") {
    throw new InvalidThresholdError(
      "Threshold cannot be empty",
      "THRESHOLD_EMPTY",
      { start: 0, end: text.length },
    );
  }

  if (trimmed.startsWith("-")) {
    throw new InvalidThresholdError(
      `Threshold cannot be negative: "${label}"`,
      "THRESHOLD_NEGATIVE",
      tokenRange,
    );
  }

  if (trimmed.startsWith("+")) {
    throw new InvalidThresholdError(
      `Threshold cannot have leading '+': "${label}"`,
      "THRESHOLD_LEADING_PLUS",
      { start: leadingWs, end: leadingWs + 1 },
    );
  }

  // Must match integer or decimal with digits
  // Disallow leading '.' or trailing '.' without digits, disallow multiple '.'
  const parts = trimmed.split(".");
  if (parts.length > 2) {
    throw new InvalidThresholdError(
      `Malformed threshold: "${label}"`,
      "THRESHOLD_MALFORMED",
      tokenRange,
    );
  }

  const wholeStr = parts[0] ?? "";
  const fracStr = parts.length === 2 ? (parts[1] ?? "") : "";

  if (!/^\d+$/.test(wholeStr)) {
    throw new InvalidThresholdError(
      `Malformed integer part in threshold: "${label}"`,
      "THRESHOLD_MALFORMED",
      { start: leadingWs, end: leadingWs + wholeStr.length },
    );
  }

  if (parts.length === 2 && (fracStr.length === 0 || !/^\d+$/.test(fracStr))) {
    const fracStart = leadingWs + wholeStr.length + 1;
    throw new InvalidThresholdError(
      `Malformed fractional part in threshold: "${label}"`,
      "THRESHOLD_MALFORMED",
      { start: fracStart, end: leadingWs + trimmed.length },
    );
  }

  if (fracStr.length > 7) {
    const excessStart = leadingWs + wholeStr.length + 1 + 7;
    throw new InvalidThresholdError(
      `Threshold exceeds maximum USDC precision of 7 decimals: "${label}"`,
      "THRESHOLD_PRECISION_EXCEEDED",
      { start: excessStart, end: leadingWs + trimmed.length },
    );
  }

  const whole = BigInt(wholeStr);
  const paddedFrac = fracStr.padEnd(7, "0");
  const frac = BigInt(paddedFrac);

  return whole * 10_000_000n + frac;
}

/**
 * Evaluates whether an event meets the configured amount thresholds.
 *
 * Filtering rules:
 * - market `claim_challenged`: passes if stake >= threshold (or threshold <= 0 / unset)
 * - squad `deposited`: passes if amount >= threshold (or threshold <= 0 / unset)
 * - other events: always pass
 */
export function meetsThreshold(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): boolean {
  if (!thresholds) {
    return true;
  }

  if (event.payload.name === "claim_challenged") {
    const minStake = thresholds.marketChallenge;
    if (minStake === undefined || minStake <= 0n) {
      return true;
    }
    return event.payload.stake >= minStake;
  }

  if (event.payload.name === "deposited") {
    const minAmount = thresholds.squadDeposit;
    if (minAmount === undefined || minAmount <= 0n) {
      return true;
    }
    return event.payload.amount >= minAmount;
  }

  return true;
}
