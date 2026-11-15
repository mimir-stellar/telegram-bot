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

/** Distinct diagnostic reason returned by {@link evaluateThresholdDryRun}. */
export type ThresholdDiagnosticReason =
  | "matched"
  | "not_applicable"
  | "false_predicate"
  | "missing_field";

/** Structured dry-run diagnostic for amount-threshold evaluation. */
export interface ThresholdDryRunResult {
  allowed: boolean;
  reason: ThresholdDiagnosticReason;
  field?: "stake" | "amount";
  detail: string;
}

/**
 * Evaluates whether an event meets the configured amount thresholds in dry-run mode,
 * distinguishing missing amount fields (`reason: "missing_field"`) from present
 * amounts below the configured threshold (`reason: "false_predicate"`).
 */
export function evaluateThresholdDryRun(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): ThresholdDryRunResult {
  if (!thresholds) {
    return {
      allowed: true,
      reason: "not_applicable",
      detail: "No amount thresholds configured",
    };
  }

  const payload = event.payload as Record<string, unknown>;
  if (event.payload.name === "claim_challenged") {
    const minStake = thresholds.marketChallenge;
    if (minStake === undefined || minStake <= 0n) {
      return {
        allowed: true,
        reason: "not_applicable",
        field: "stake",
        detail: "No active marketChallenge threshold configured",
      };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "stake") || typeof payload.stake !== "bigint") {
      return {
        allowed: false,
        reason: "missing_field",
        field: "stake",
        detail: 'Field "stake" is missing on event "claim_challenged"',
      };
    }
    if (payload.stake >= minStake) {
      return {
        allowed: true,
        reason: "matched",
        field: "stake",
        detail: `Predicate "stake >= ${minStake.toString()}" matched`,
      };
    }
    return {
      allowed: false,
      reason: "false_predicate",
      field: "stake",
      detail: `Predicate "stake >= ${minStake.toString()}" evaluated to false`,
    };
  }

  if (event.payload.name === "deposited") {
    const minAmount = thresholds.squadDeposit;
    if (minAmount === undefined || minAmount <= 0n) {
      return {
        allowed: true,
        reason: "not_applicable",
        field: "amount",
        detail: "No active squadDeposit threshold configured",
      };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "amount") || typeof payload.amount !== "bigint") {
      return {
        allowed: false,
        reason: "missing_field",
        field: "amount",
        detail: 'Field "amount" is missing on event "deposited"',
      };
    }
    if (payload.amount >= minAmount) {
      return {
        allowed: true,
        reason: "matched",
        field: "amount",
        detail: `Predicate "amount >= ${minAmount.toString()}" matched`,
      };
    }
    return {
      allowed: false,
      reason: "false_predicate",
      field: "amount",
      detail: `Predicate "amount >= ${minAmount.toString()}" evaluated to false`,
    };
  }

  return {
    allowed: true,
    reason: "not_applicable",
    detail: `No amount threshold applies to event "${String(payload.name ?? "unknown")}"`,
  };
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
  return evaluateThresholdDryRun(event, thresholds).allowed;
}
