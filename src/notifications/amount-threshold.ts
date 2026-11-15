/**
 * Amount threshold filtering for notifications.
 *
 * Lets operators hide small deposits and challenges in busy chats.
 * Amounts are parsed as 7-decimal atomic USDC units (Stellar Asset Contract)
 * using integer arithmetic only (no floating point).
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** Error thrown when a threshold string is negative, malformed, or invalid. */
export class InvalidThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThresholdError";
  }
}

/** Threshold configuration for event filtering. */
export interface AmountThresholds {
  /** Minimum stake for claim_challenged (market). 0 or unset means no filtering. */
  marketChallenge?: bigint;
  /** Minimum amount for deposited (squad). 0 or unset means no filtering. */
  squadDeposit?: bigint;
}

/** Raw candidate threshold values accepted during configuration load or reload. */
export interface RawAmountThresholds {
  marketChallenge?: string | bigint | null;
  squadDeposit?: string | bigint | null;
}

const KNOWN_THRESHOLD_KEYS = new Set(["marketChallenge", "squadDeposit"]);

/**
 * Validates a complete threshold configuration object without mutating any active state.
 * Collects all threshold validation problems before returning.
 */
export function validateAmountThresholds(
  raw: unknown,
): { thresholds: AmountThresholds; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) {
    return { thresholds: {}, problems };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      thresholds: {},
      problems: ["thresholds must be an object with optional marketChallenge / squadDeposit keys"],
    };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_THRESHOLD_KEYS.has(key)) {
      problems.push(`thresholds.${key}: unknown threshold key`);
    }
  }

  const thresholds: AmountThresholds = {};
  for (const key of ["marketChallenge", "squadDeposit"] as const) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "bigint") {
      if (value < 0n) {
        problems.push(`thresholds.${key}: Threshold cannot be negative: "${value.toString()}"`);
      } else {
        thresholds[key] = value;
      }
      continue;
    }
    if (typeof value === "string") {
      try {
        thresholds[key] = parseUsdcThreshold(value);
      } catch (err) {
        problems.push(
          `thresholds.${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }
    problems.push(
      `thresholds.${key}: Threshold must be a decimal string or bigint, got ${typeof value}`,
    );
  }

  return { thresholds, problems };
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
