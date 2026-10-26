/**
 * Squad `resolved` rendering: both pool totals, the winning side, and the gross
 * payout per 1 USDC staked on that side.
 *
 * The numbers are computed once, as plain strings, by
 * {@link formatSquadResolution}; {@link renderSquadResolution} then lays them
 * into a locale's MarkdownV2 or plain-text templates. Both formatters share the
 * same computed values, so the two renderings can never disagree on a number.
 *
 * All arithmetic is bigint fixed-point (7 decimals, the USDC precision): no
 * floating-point value is ever produced.
 */

import {
  formatUsdc,
  squadSideLabel,
  USDC_UNIT,
  type SquadResolvedPayload,
} from "../stellar/decode.js";

/** `SIDE_A` / `SIDE_B` / `RESULT_CANCELLED` in `mimir-squad/src/types.rs`. */
const SIDE_A = 1;
const SIDE_B = 2;

/** Display-ready values for one squad resolution. Every field is unescaped. */
export interface SquadResolution {
  marketId: string;
  /** Human label of the result (`Side A`, `Side B`, `cancelled`, ...). */
  result: string;
  /** `formatUsdc` amount with the unit, e.g. `12.5000000 USDC`. */
  poolA: string;
  poolB: string;
  /**
   * Gross payout per 1 USDC staked on the winning side, with the unit
   * (`2.0000000 USDC`). Null when there is no winner (cancelled, pending,
   * unknown result) or the winning pool is empty.
   */
  payoutPerUsdc: string | null;
  /** True when a side won but nobody staked on it, so no ratio exists. */
  emptyWinningPool: boolean;
}

/** The templates {@link renderSquadResolution} needs from a locale catalog. */
export interface SquadResolutionTemplates {
  resolved(marketId: string, result: string, poolA: string, poolB: string): string;
  resolvedPayout(ratio: string): string;
  resolvedNoWinningStake(side: string): string;
}

/**
 * Gross payout, in atomic USDC units, for each 1 USDC (`USDC_UNIT`) staked on
 * the winning pool: `(poolA + poolB) * USDC_UNIT / winningPool`, rounded down.
 *
 * Returns null for an empty (or negative, i.e. corrupt) winning pool instead
 * of dividing by zero.
 */
export function payoutPerUsdcUnits(winningPool: bigint, totalPool: bigint): bigint | null {
  if (winningPool <= 0n || totalPool < 0n) return null;
  return (totalPool * USDC_UNIT) / winningPool;
}

/** Compute the display values for a squad `resolved` payload. */
export function formatSquadResolution(payload: SquadResolvedPayload): SquadResolution {
  const poolA = BigInt(payload.poolA);
  const poolB = BigInt(payload.poolB);
  const winningPool =
    payload.result === SIDE_A ? poolA : payload.result === SIDE_B ? poolB : null;

  let payoutPerUsdc: string | null = null;
  let emptyWinningPool = false;
  if (winningPool !== null) {
    const units = payoutPerUsdcUnits(winningPool, poolA + poolB);
    if (units === null) emptyWinningPool = true;
    else payoutPerUsdc = `${formatUsdc(units)} USDC`;
  }

  return {
    marketId: String(payload.marketId),
    result: squadSideLabel(payload.result),
    poolA: `${formatUsdc(poolA)} USDC`,
    poolB: `${formatUsdc(poolB)} USDC`,
    payoutPerUsdc,
    emptyWinningPool,
  };
}

/**
 * Lay a {@link SquadResolution} into a template set. `escape` is applied to
 * every dynamic value: `escapeMd` for MarkdownV2, identity for plain text.
 */
export function renderSquadResolution(
  resolution: SquadResolution,
  templates: SquadResolutionTemplates,
  escape: (text: string) => string = (text) => text,
): string {
  const lines = [
    templates.resolved(
      escape(resolution.marketId),
      escape(resolution.result),
      escape(resolution.poolA),
      escape(resolution.poolB),
    ),
  ];
  if (resolution.payoutPerUsdc !== null) {
    lines.push(templates.resolvedPayout(escape(resolution.payoutPerUsdc)));
  } else if (resolution.emptyWinningPool) {
    lines.push(templates.resolvedNoWinningStake(escape(resolution.result)));
  }
  return lines.join("\n");
}
