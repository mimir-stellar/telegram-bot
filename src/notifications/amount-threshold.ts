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

export interface ThresholdExplanation {
  matched: boolean;
  applicable: boolean;
  field?: "stake" | "amount";
  reason: string;
}

function formatUsdcUnits(units: bigint): string {
  const scale = 10_000_000n;
  const neg = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const whole = abs / scale;
  const frac = abs % scale;
  if (frac === 0n) {
    return `${neg}${whole.toString()} USDC`;
  }
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg}${whole.toString()}.${fracStr} USDC`;
}

function clampSingleLine(text: string, maxLen = 120): string {
  const cap = Math.max(24, Math.min(240, maxLen));
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1)}…`;
}

/**
 * Produces a deterministic, bounded, privacy-safe explanation for amount-threshold evaluation.
 */
export function explainThreshold(
  event: DecodedEvent,
  thresholds?: AmountThresholds,
  options: { maxReasonLength?: number } = {},
): ThresholdExplanation {
  const maxLen = options.maxReasonLength ?? 120;
  if (!thresholds) {
    return {
      matched: true,
      applicable: false,
      reason: clampSingleLine("threshold check skipped (no thresholds configured)", maxLen),
    };
  }

  const payload = event.payload as Record<string, unknown>;
  if (event.payload.name === "claim_challenged") {
    const minStake = thresholds.marketChallenge;
    if (minStake === undefined || minStake <= 0n) {
      return {
        matched: true,
        applicable: false,
        field: "stake",
        reason: clampSingleLine("marketChallenge threshold inactive (0 or unset)", maxLen),
      };
    }
    if (typeof payload.stake !== "bigint") {
      return {
        matched: false,
        applicable: true,
        field: "stake",
        reason: clampSingleLine(
          `stake >= ${formatUsdcUnits(minStake)} failed (field missing)`,
          maxLen,
        ),
      };
    }
    const matched = payload.stake >= minStake;
    return {
      matched,
      applicable: true,
      field: "stake",
      reason: clampSingleLine(
        matched
          ? `stake (${formatUsdcUnits(payload.stake)}) >= ${formatUsdcUnits(minStake)}`
          : `stake (${formatUsdcUnits(payload.stake)}) < ${formatUsdcUnits(minStake)}`,
        maxLen,
      ),
    };
  }

  if (event.payload.name === "deposited") {
    const minAmount = thresholds.squadDeposit;
    if (minAmount === undefined || minAmount <= 0n) {
      return {
        matched: true,
        applicable: false,
        field: "amount",
        reason: clampSingleLine("squadDeposit threshold inactive (0 or unset)", maxLen),
      };
    }
    if (typeof payload.amount !== "bigint") {
      return {
        matched: false,
        applicable: true,
        field: "amount",
        reason: clampSingleLine(
          `amount >= ${formatUsdcUnits(minAmount)} failed (field missing)`,
          maxLen,
        ),
      };
    }
    const matched = payload.amount >= minAmount;
    return {
      matched,
      applicable: true,
      field: "amount",
      reason: clampSingleLine(
        matched
          ? `amount (${formatUsdcUnits(payload.amount)}) >= ${formatUsdcUnits(minAmount)}`
          : `amount (${formatUsdcUnits(payload.amount)}) < ${formatUsdcUnits(minAmount)}`,
        maxLen,
      ),
    };
  }

  const eventLabel = typeof payload.name === "string" && payload.name ? payload.name : "unknown";
  return {
    matched: true,
    applicable: false,
    reason: clampSingleLine(`no amount threshold applies to event "${eventLabel}"`, maxLen),
  };
}
