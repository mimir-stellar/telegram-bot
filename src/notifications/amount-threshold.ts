/**
 * Amount threshold filtering for notifications.
 *
 * Lets operators hide small deposits and challenges in busy chats.
 * Amounts are parsed as 7-decimal atomic USDC units (Stellar Asset Contract)
 * using integer arithmetic only (no floating point).
 *
 * `meetsThreshold` keeps its boolean allow-or-deny contract; dry runs use
 * `evaluateThresholdDiagnostic` to tell a missing amount field apart from an
 * amount that is present but below the configured minimum.
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

/** Why a threshold evaluation passed or failed, for dry-run diagnostics. */
export type ThresholdDiagnosticReason =
  | "not-configured"
  | "passed"
  | "below-threshold"
  | "missing-field";

/** Diagnostic result of evaluating amount thresholds against one event. */
export interface ThresholdDiagnostic {
  passed: boolean;
  reason: ThresholdDiagnosticReason;
  /** Payload field the threshold applied to, when one was configured. */
  field?: "stake" | "amount";
  /** The configured minimum, in atomic 7-decimal units. */
  threshold?: bigint;
}

/**
 * Evaluates amount thresholds and explains the outcome.
 *
 * Unlike {@link meetsThreshold}, a configured threshold on an event whose
 * amount field is absent reports `"missing-field"` rather than collapsing
 * into the same deny result as a genuinely low amount (`"below-threshold"`).
 * Both still deny, so live allow-or-deny behavior is unchanged.
 */
export function evaluateThresholdDiagnostic(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): ThresholdDiagnostic {
  if (!thresholds) {
    return { passed: true, reason: "not-configured" };
  }

  if (event.payload.name === "claim_challenged") {
    const minStake = thresholds.marketChallenge;
    if (minStake === undefined || minStake <= 0n) {
      return { passed: true, reason: "not-configured" };
    }
    const stake = (event.payload as Record<string, unknown>).stake;
    if (typeof stake !== "bigint") {
      return { passed: false, reason: "missing-field", field: "stake", threshold: minStake };
    }
    if (stake < minStake) {
      return { passed: false, reason: "below-threshold", field: "stake", threshold: minStake };
    }
    return { passed: true, reason: "passed", field: "stake", threshold: minStake };
  }

  if (event.payload.name === "deposited") {
    const minAmount = thresholds.squadDeposit;
    if (minAmount === undefined || minAmount <= 0n) {
      return { passed: true, reason: "not-configured" };
    }
    const amount = (event.payload as Record<string, unknown>).amount;
    if (typeof amount !== "bigint") {
      return { passed: false, reason: "missing-field", field: "amount", threshold: minAmount };
    }
    if (amount < minAmount) {
      return { passed: false, reason: "below-threshold", field: "amount", threshold: minAmount };
    }
    return { passed: true, reason: "passed", field: "amount", threshold: minAmount };
  }

  return { passed: true, reason: "not-configured" };
}

/**
 * Normalizes a valid decimal USDC threshold string to its canonical 7-decimal representation.
 *
 * Canonical equivalent decimal strings produce identical output:
 * - "1", "01", "1.0", "1.00", "1.0000000" -> "1.0000000"
 * - "0.5", "00.50", "0.5000000" -> "0.5000000"
 *
 * Rejects negative numbers, malformed input, or values exceeding 7 fractional digits
 * with an {@link InvalidThresholdError}.
 */
export function normalizeUsdcThreshold(text: string): string {
  const atomic = parseUsdcThreshold(text);
  const whole = atomic / 10_000_000n;
  const frac = (atomic % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/**
 * Evaluates whether an event meets the configured amount thresholds.
 *
 * Filtering rules:
 * - market `claim_challenged`: passes if stake >= threshold (or threshold <= 0 / unset)
 * - squad `deposited`: passes if amount >= threshold (or threshold <= 0 / unset)
 * - other events: always pass
 *
 * A missing amount field on a filtered event denies, exactly as before; use
 * {@link evaluateThresholdDiagnostic} in dry runs to tell it apart from an
 * amount that is present but too small.
 */
export function meetsThreshold(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): boolean {
  return evaluateThresholdDiagnostic(event, thresholds).passed;
}
