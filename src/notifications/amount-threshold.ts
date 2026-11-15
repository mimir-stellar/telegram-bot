/**
 * Amount threshold filtering for notifications.
 *
 * Lets operators hide small deposits and challenges in busy chats.
 * Amounts are parsed as 7-decimal atomic USDC units (Stellar Asset Contract)
 * using integer arithmetic only (no floating point).
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** USDC atomic unit scale (7 decimal places). */
export const USDC_THRESHOLD_SCALE = 10_000_000n;

/** Error thrown when a threshold string is negative, malformed, or invalid. */
export class InvalidThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThresholdError";
  }
}

/** Canonical normalized representation of a USDC decimal threshold. */
export interface NormalizedUsdcThreshold {
  /** Minimal canonical decimal string (e.g. `"0"`, `"10"`, `"10.5"`, `"0.0000001"`). */
  canonical: string;
  /** Exact 7-decimal atomic units (`bigint`). */
  atomic: bigint;
}

/** Threshold configuration for event filtering. */
export interface AmountThresholds {
  /** Minimum stake for claim_challenged (market). 0 or unset means no filtering. */
  marketChallenge?: bigint | string;
  /** Minimum amount for deposited (squad). 0 or unset means no filtering. */
  squadDeposit?: bigint | string;
}

/** Formats non-negative 7-decimal atomic USDC units into a canonical decimal string. */
export function formatCanonicalUsdc(atomic: bigint): string {
  if (atomic < 0n) {
    throw new InvalidThresholdError(`Threshold cannot be negative: "${atomic.toString()}"`);
  }
  const whole = atomic / USDC_THRESHOLD_SCALE;
  const frac = atomic % USDC_THRESHOLD_SCALE;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracTrimmed = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracTrimmed}`;
}

/**
 * Normalizes a decimal USDC string into its canonical decimal string and
 * 7-decimal atomic `bigint` value.
 *
 * Equivalent representations (`"10"`, `"10.0"`, `"010.0000000"`, `" 10.00 "`)
 * normalize to `{ canonical: "10", atomic: 100_000_000n }`.
 * Any value with more than 7 fractional digits (including trailing zeros such
 * as `"1.00000000"` or `"0.00000001"`) is rejected with {@link InvalidThresholdError}.
 */
export function normalizeUsdcThreshold(text: string): NormalizedUsdcThreshold {
  if (typeof text !== "string") {
    throw new InvalidThresholdError(`Threshold must be a string, got ${typeof text}`);
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    throw new InvalidThresholdError("Threshold cannot be empty");
  }

  if (trimmed.startsWith("-")) {
    throw new InvalidThresholdError(`Threshold cannot be negative: "${trimmed}"`);
  }

  if (trimmed.startsWith("+")) {
    throw new InvalidThresholdError(`Threshold cannot have leading '+': "${trimmed}"`);
  }

  // Must match integer or decimal with digits
  // Disallow leading '.' or trailing '.' without digits, disallow multiple '.'
  const parts = trimmed.split(".");
  if (parts.length > 2) {
    throw new InvalidThresholdError(`Malformed threshold: "${trimmed}"`);
  }

  const wholeStr = parts[0] ?? "";
  const fracStr = parts.length === 2 ? (parts[1] ?? "") : "";

  if (!/^\d+$/.test(wholeStr)) {
    throw new InvalidThresholdError(`Malformed integer part in threshold: "${trimmed}"`);
  }

  if (parts.length === 2 && (fracStr.length === 0 || !/^\d+$/.test(fracStr))) {
    throw new InvalidThresholdError(`Malformed fractional part in threshold: "${trimmed}"`);
  }

  if (fracStr.length > 7) {
    throw new InvalidThresholdError(
      `Threshold exceeds maximum USDC precision of 7 decimals: "${trimmed}"`,
    );
  }

  const whole = BigInt(wholeStr);
  const paddedFrac = fracStr.padEnd(7, "0");
  const frac = BigInt(paddedFrac);
  const atomic = whole * USDC_THRESHOLD_SCALE + frac;

  return {
    canonical: formatCanonicalUsdc(atomic),
    atomic,
  };
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
  return normalizeUsdcThreshold(text).atomic;
}

function resolveAtomicThreshold(value: bigint | string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return normalizeUsdcThreshold(value).atomic;
  }
  if (value < 0n) {
    throw new InvalidThresholdError(`Threshold cannot be negative: "${value.toString()}"`);
  }
  return value;
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

  const minStake = resolveAtomicThreshold(thresholds.marketChallenge);
  const minAmount = resolveAtomicThreshold(thresholds.squadDeposit);

  if (event.payload.name === "claim_challenged") {
    if (minStake === undefined || minStake <= 0n) {
      return true;
    }
    return event.payload.stake >= minStake;
  }

  if (event.payload.name === "deposited") {
    if (minAmount === undefined || minAmount <= 0n) {
      return true;
    }
    return event.payload.amount >= minAmount;
  }

  return true;
}
