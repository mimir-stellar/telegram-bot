import type { DecodedEvent } from "./decode.js";

export type CaptureCompletenessStatus =
  | "complete_from_genesis"
  | "complete_window"
  | "partial";

export type CaptureScopeLabel =
  | "global_market_total"
  | "bounded_window_total"
  | "partial_capture_estimate";

export type CaptureGapReason =
  | "start_clamped_to_retention_floor"
  | "truncated_before_end"
  | "explicit_gap";

export type CaptureIncompletenessReason =
  | "empty_capture"
  | "missing_genesis_anchor"
  | "windowed_scan"
  | "start_clamped"
  | "scan_truncated"
  | "ledger_gaps_present"
  | "events_skipped_without_timestamp"
  | "incomplete_claims_excluded";

export interface CaptureGapInput {
  fromLedger: number;
  toLedger: number;
  reason?: CaptureGapReason;
}

export interface CaptureLedgerGap {
  fromLedger: number;
  toLedger: number;
  missedLedgers: number;
  reason: CaptureGapReason;
}

export interface CaptureContextInput {
  /** Contract deployment / genesis ledger. Required to qualify as a global all-time total. */
  genesisLedger?: number | null;
  /** Start ledger originally requested before RPC retention clamping. */
  requestedStartLedger?: number | null;
  /** End ledger originally requested (defaults to `latestChainLedger` when provided). */
  requestedEndLedger?: number | null;
  /** Effective start ledger actually scanned after clamping. */
  effectiveStartLedger?: number | null;
  /** Effective end ledger reached by the scan cursor. */
  effectiveEndLedger?: number | null;
  /** Oldest ledger retained by Soroban RPC (`getHealth().oldestLedger`). */
  oldestRetainedLedger?: number | null;
  /** Latest chain tip ledger (`getHealth().latestLedger`). */
  latestChainLedger?: number | null;
  /** True when `requestedStartLedger` fell below `oldestRetainedLedger` and was clamped up. */
  startClamped?: boolean;
  /** True when page/event caps stopped the scan before reaching the target end ledger. */
  truncated?: boolean;
  /** Known ledger discontinuities within the capture. */
  gaps?: readonly CaptureGapInput[];
}

export interface CaptureLedgerRange {
  genesisLedger: number | null;
  requestedStartLedger: number | null;
  requestedEndLedger: number | null;
  effectiveStartLedger: number | null;
  effectiveEndLedger: number | null;
  observedMinLedger: number | null;
  observedMaxLedger: number | null;
  oldestRetainedLedger: number | null;
  latestChainLedger: number | null;
}

export interface CaptureCompletenessMetadata {
  status: CaptureCompletenessStatus;
  scopeLabel: CaptureScopeLabel;
  /** True only when anchored at `genesisLedger` through chain tip with zero gaps/drops. */
  isGlobalTotal: boolean;
  /** Alias for `isGlobalTotal` indicating full all-time capture completeness. */
  isCompleteCapture: boolean;
  /** True when a bounded `[effectiveStartLedger, effectiveEndLedger]` window has zero internal loss. */
  isCompleteWindow: boolean;
  ledgerRange: CaptureLedgerRange;
  gaps: CaptureLedgerGap[];
  totalMissedLedgers: number;
  reasons: CaptureIncompletenessReason[];
}

export class PartialCaptureError extends Error {
  readonly capture: CaptureCompletenessMetadata;

  constructor(message: string, capture: CaptureCompletenessMetadata) {
    super(message);
    this.name = "PartialCaptureError";
    this.capture = capture;
  }
}

function normLedger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

export function observeEventLedgerBounds(
  events: readonly DecodedEvent[] | null | undefined,
): { minLedger: number | null; maxLedger: number | null } {
  if (!events || !Array.isArray(events)) {
    return { minLedger: null, maxLedger: null };
  }
  let minLedger: number | null = null;
  let maxLedger: number | null = null;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const led = normLedger((ev as { ledger?: number | null }).ledger);
    if (led === null) continue;
    if (minLedger === null || led < minLedger) minLedger = led;
    if (maxLedger === null || led > maxLedger) maxLedger = led;
  }
  return { minLedger, maxLedger };
}

export interface EvaluateCaptureInternalStats {
  skippedWithoutAt?: number;
  excludedClaims?: number;
  hasAnyEvents: boolean;
}

/**
 * Derive deterministic `CaptureCompletenessMetadata` from observed events,
 * caller-supplied scan window context, and reducer drop counters.
 */
export function evaluateCaptureCompleteness(
  events: readonly DecodedEvent[] | null | undefined,
  context: CaptureContextInput | undefined,
  stats: EvaluateCaptureInternalStats,
): CaptureCompletenessMetadata {
  const observed = observeEventLedgerBounds(events);
  const genesisLedger = normLedger(context?.genesisLedger);
  const oldestRetainedLedger = normLedger(context?.oldestRetainedLedger);
  const latestChainLedger = normLedger(context?.latestChainLedger);
  const requestedStartLedger = normLedger(context?.requestedStartLedger);
  const requestedEndLedger = normLedger(context?.requestedEndLedger) ?? latestChainLedger;

  let effectiveStartLedger = normLedger(context?.effectiveStartLedger);
  if (effectiveStartLedger === null && requestedStartLedger !== null) {
    effectiveStartLedger =
      oldestRetainedLedger !== null && requestedStartLedger < oldestRetainedLedger
        ? oldestRetainedLedger
        : requestedStartLedger;
  }
  if (effectiveStartLedger === null) {
    effectiveStartLedger = observed.minLedger;
  }

  let effectiveEndLedger = normLedger(context?.effectiveEndLedger);
  if (effectiveEndLedger === null) {
    effectiveEndLedger =
      context?.truncated === true ? observed.maxLedger : (requestedEndLedger ?? observed.maxLedger);
  }

  const startClamped =
    context?.startClamped === true ||
    (requestedStartLedger !== null &&
      effectiveStartLedger !== null &&
      effectiveStartLedger > requestedStartLedger) ||
    (genesisLedger !== null &&
      effectiveStartLedger !== null &&
      effectiveStartLedger > genesisLedger &&
      oldestRetainedLedger !== null &&
      effectiveStartLedger >= oldestRetainedLedger &&
      genesisLedger < oldestRetainedLedger);

  const truncated =
    context?.truncated === true ||
    (requestedEndLedger !== null &&
      effectiveEndLedger !== null &&
      effectiveEndLedger < requestedEndLedger);

  const gaps: CaptureLedgerGap[] = [];

  // Synthesize head gap if start was clamped above requestedStartLedger or genesisLedger
  const intendedFloor = requestedStartLedger ?? genesisLedger;
  if (
    startClamped &&
    intendedFloor !== null &&
    effectiveStartLedger !== null &&
    effectiveStartLedger > intendedFloor
  ) {
    const toLedger = effectiveStartLedger - 1;
    gaps.push({
      fromLedger: intendedFloor,
      toLedger,
      missedLedgers: toLedger - intendedFloor + 1,
      reason: "start_clamped_to_retention_floor",
    });
  }

  if (Array.isArray(context?.gaps)) {
    for (const g of context.gaps) {
      const from = normLedger(g?.fromLedger);
      const to = normLedger(g?.toLedger);
      if (from === null || to === null || to < from) continue;
      gaps.push({
        fromLedger: from,
        toLedger: to,
        missedLedgers: to - from + 1,
        reason: g.reason ?? "explicit_gap",
      });
    }
  }

  // Synthesize tail gap if scan truncated before requestedEndLedger
  const tailStop = effectiveEndLedger ?? observed.maxLedger;
  if (truncated && requestedEndLedger !== null && tailStop !== null && tailStop < requestedEndLedger) {
    const fromLedger = tailStop + 1;
    gaps.push({
      fromLedger,
      toLedger: requestedEndLedger,
      missedLedgers: requestedEndLedger - fromLedger + 1,
      reason: "truncated_before_end",
    });
  }

  gaps.sort((a, b) => {
    if (a.fromLedger !== b.fromLedger) return a.fromLedger - b.fromLedger;
    if (a.toLedger !== b.toLedger) return a.toLedger - b.toLedger;
    return a.reason.localeCompare(b.reason);
  });

  const totalMissedLedgers = gaps.reduce((acc, g) => acc + g.missedLedgers, 0);

  const reasonsSet = new Set<CaptureIncompletenessReason>();

  const hasExplicitWindowBounds =
    normLedger(context?.effectiveStartLedger) !== null ||
    normLedger(context?.requestedStartLedger) !== null;

  if (!stats.hasAnyEvents && !hasExplicitWindowBounds) {
    reasonsSet.add("empty_capture");
  }
  if (genesisLedger === null) {
    reasonsSet.add("missing_genesis_anchor");
  } else if (effectiveStartLedger === null || effectiveStartLedger > genesisLedger) {
    reasonsSet.add("windowed_scan");
  }
  if (
    genesisLedger === null &&
    effectiveStartLedger !== null &&
    (effectiveStartLedger > 0 || oldestRetainedLedger !== null)
  ) {
    reasonsSet.add("windowed_scan");
  }
  if (
    latestChainLedger !== null &&
    effectiveEndLedger !== null &&
    effectiveEndLedger < latestChainLedger &&
    !truncated
  ) {
    reasonsSet.add("windowed_scan");
  }
  if (startClamped) {
    reasonsSet.add("start_clamped");
  }
  if (truncated) {
    reasonsSet.add("scan_truncated");
  }
  if (gaps.length > 0) {
    reasonsSet.add("ledger_gaps_present");
  }
  if ((stats.skippedWithoutAt ?? 0) > 0) {
    reasonsSet.add("events_skipped_without_timestamp");
  }
  if ((stats.excludedClaims ?? 0) > 0) {
    reasonsSet.add("incomplete_claims_excluded");
  }

  const hasDataLossOrGap =
    startClamped ||
    truncated ||
    gaps.length > 0 ||
    (stats.skippedWithoutAt ?? 0) > 0 ||
    (stats.excludedClaims ?? 0) > 0 ||
    (!stats.hasAnyEvents && !hasExplicitWindowBounds);

  const coversFromGenesis =
    genesisLedger !== null &&
    effectiveStartLedger !== null &&
    effectiveStartLedger <= genesisLedger &&
    effectiveEndLedger !== null &&
    (latestChainLedger === null || effectiveEndLedger >= latestChainLedger);

  let status: CaptureCompletenessStatus;
  let scopeLabel: CaptureScopeLabel;

  if (!hasDataLossOrGap && coversFromGenesis) {
    status = "complete_from_genesis";
    scopeLabel = "global_market_total";
  } else if (!hasDataLossOrGap && effectiveStartLedger !== null && effectiveEndLedger !== null && hasExplicitWindowBounds) {
    status = "complete_window";
    scopeLabel = "bounded_window_total";
  } else {
    status = "partial";
    scopeLabel = "partial_capture_estimate";
  }

  const reasons = [...reasonsSet].sort();

  return {
    status,
    scopeLabel,
    isGlobalTotal: status === "complete_from_genesis",
    isCompleteCapture: status === "complete_from_genesis",
    isCompleteWindow: status === "complete_from_genesis" || status === "complete_window",
    ledgerRange: {
      genesisLedger,
      requestedStartLedger,
      requestedEndLedger,
      effectiveStartLedger,
      effectiveEndLedger,
      observedMinLedger: observed.minLedger,
      observedMaxLedger: observed.maxLedger,
      oldestRetainedLedger,
      latestChainLedger,
    },
    gaps,
    totalMissedLedgers,
    reasons,
  };
}

/**
 * Guard that refuses to let partial or rolling-window captures pass as global
 * all-time market totals.
 */
export function assertGlobalCapture(
  target: { capture?: CaptureCompletenessMetadata } | CaptureCompletenessMetadata,
  label = "aggregate result",
): void {
  const capture = "isGlobalTotal" in target ? target : target.capture;
  if (!capture) {
    throw new Error(`Missing capture completeness metadata on ${label}`);
  }
  if (!capture.isGlobalTotal) {
    const start = capture.ledgerRange.effectiveStartLedger ?? capture.ledgerRange.observedMinLedger ?? "?";
    const end = capture.ledgerRange.effectiveEndLedger ?? capture.ledgerRange.observedMaxLedger ?? "?";
    throw new PartialCaptureError(
      `Refusing to present ${capture.status} (${capture.scopeLabel}, ledgers ${start}..${end}, missed=${capture.totalMissedLedgers}, reasons=${capture.reasons.join(",") || "none"}) as global market total for ${label}`,
      capture,
    );
  }
}

export function formatCaptureBanner(capture: CaptureCompletenessMetadata): string {
  const start =
    capture.ledgerRange.effectiveStartLedger ?? capture.ledgerRange.observedMinLedger ?? "none";
  const end =
    capture.ledgerRange.effectiveEndLedger ?? capture.ledgerRange.observedMaxLedger ?? "none";

  if (capture.status === "complete_from_genesis") {
    return `[GLOBAL MARKET TOTAL — ledgers ${start}..${end}, gaps=0]`;
  }
  if (capture.status === "complete_window") {
    return `[BOUNDED WINDOW TOTAL (NOT ALL-TIME GLOBAL TOTAL) — ledgers ${start}..${end}, gaps=0]`;
  }
  return `[PARTIAL CAPTURE (NOT GLOBAL MARKET TOTAL) — ledgers ${start}..${end}, missed_ledgers=${capture.totalMissedLedgers}, reasons=${capture.reasons.join(",")}]`;
}
