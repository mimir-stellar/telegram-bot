/**
 * Capture completeness metadata for analytical aggregate series.
 *
 * Annotates analytical reducers (such as volume series and resolution latency)
 * with ledger range and capture gap metadata to prevent partial or windowed
 * captures from being presented as global market totals.
 *
 * Invariants:
 * - Supplied bounds and gap endpoints must be non-negative safe integers.
 * - Absent metadata is distinguished from invalid supplied metadata (invalid input is rejected).
 * - Gaps are sorted ascending and overlapping/adjacent gaps are normalized so missed
 *   ledgers are not counted twice.
 * - An aggregate series is complete (`isComplete = true`) ONLY when explicitly asserted
 *   complete by the caller AND free of uncaptured gaps.
 * - Partial captures yield `globalMarketTotals: null` to prevent presenting incomplete
 *   windows as global market totals.
 */

export interface CaptureGap {
  /** Inclusive starting ledger of the uncaptured gap. */
  fromLedger: number;
  /** Inclusive ending ledger of the uncaptured gap. */
  toLedger: number;
  /** Total number of missing/uncaptured ledgers in this gap. */
  missedLedgers: number;
}

export interface LedgerRange {
  /** Inclusive earliest ledger, or null if no ledgers/events observed. */
  fromLedger: number | null;
  /** Inclusive latest ledger, or null if no ledgers/events observed. */
  toLedger: number | null;
}

export interface CaptureCompleteness {
  /** Inclusive starting ledger of the captured series, or null if empty. */
  startLedger: number | null;
  /** Inclusive ending ledger of the captured series, or null if empty. */
  endLedger: number | null;
  /** Ledger range object covering fromLedger to toLedger. */
  ledgerRange: LedgerRange;
  /** Known or detected gaps in the captured ledger sequence. */
  gaps: CaptureGap[];
  /** True if any uncaptured gaps exist within the series range. */
  hasGaps: boolean;
  /** Total count of missed ledgers across all gaps. */
  totalMissedLedgers: number;
  /**
   * True only if the capture represents a verified complete, gap-free historical series.
   * False for partial captures, windowed lookbacks, or captures with gaps.
   */
  isComplete: boolean;
  /**
   * True if the capture is partial (windowed lookback, incomplete, or contains gaps).
   * Inverse of `isComplete`.
   */
  isPartial: boolean;
}

export interface CaptureGapInput {
  fromLedger?: number;
  toLedger?: number;
  from?: number;
  to?: number;
  missedLedgers?: number;
}

export interface CaptureCompletenessOptions {
  /** Expected starting ledger of the capture range (inclusive). */
  fromLedger?: number;
  /** Expected ending ledger of the capture range (inclusive). */
  toLedger?: number;
  /** Alias for fromLedger. */
  startLedger?: number;
  /** Alias for toLedger. */
  endLedger?: number;
  /** Known uncaptured gaps in the ledger sequence. */
  gaps?: readonly CaptureGapInput[];
  /** Alias for gaps. */
  knownGaps?: readonly CaptureGapInput[];
  /**
   * Explicit assertion of whether this series represents a complete historical capture
   * (e.g. from contract creation to tip).
   * Defaults to false so windowed captures are not presented as global market totals.
   */
  isComplete?: boolean;
  /**
   * If true, throws an `IncompleteCaptureError` if the capture is partial or contains gaps.
   * Prevents partial captures from being presented as global market totals.
   */
  requireComplete?: boolean;
}

/**
 * Validate that a value is a non-negative safe integer.
 */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Thrown when an aggregate series is required to be complete (e.g. `requireComplete: true`
 * or `assertCompleteCapture()`) but the capture is partial or contains gaps.
 */
export class IncompleteCaptureError extends Error {
  readonly startLedger: number | null;
  readonly endLedger: number | null;
  readonly gaps: CaptureGap[];
  readonly totalMissedLedgers: number;

  constructor(message: string, completeness?: Partial<CaptureCompleteness>) {
    super(message);
    this.name = "IncompleteCaptureError";
    this.startLedger = completeness?.startLedger ?? null;
    this.endLedger = completeness?.endLedger ?? null;
    this.gaps = completeness?.gaps ?? [];
    this.totalMissedLedgers = completeness?.totalMissedLedgers ?? 0;
  }
}

/**
 * Assert that a series result represents a complete historical capture without gaps.
 * Throws `IncompleteCaptureError` if partial or containing gaps.
 */
export function assertCompleteCapture(result: { completeness: CaptureCompleteness }): void {
  if (!result || !result.completeness || !result.completeness.isComplete) {
    const gaps = result?.completeness?.gaps ?? [];
    const totalMissed = result?.completeness?.totalMissedLedgers ?? 0;
    const gapDetail = gaps.length > 0 ? ` (${gaps.length} gap(s), ${totalMissed} missed ledger(s))` : "";
    throw new IncompleteCaptureError(
      `Cannot present partial capture as global market totals: series capture is incomplete${gapDetail}`,
      result?.completeness,
    );
  }
}

/**
 * Normalize and merge overlapping or adjacent gaps so missed ledgers are not double counted.
 */
export function normalizeGaps(gaps: readonly CaptureGap[]): CaptureGap[] {
  if (gaps.length <= 1) {
    return gaps.map((g) => ({ ...g }));
  }

  // Sort ascending by fromLedger, then toLedger
  const sorted = [...gaps].sort((a, b) => a.fromLedger - b.fromLedger || a.toLedger - b.toLedger);
  const merged: CaptureGap[] = [];

  for (const gap of sorted) {
    if (merged.length === 0) {
      merged.push({
        fromLedger: gap.fromLedger,
        toLedger: gap.toLedger,
        missedLedgers: gap.toLedger - gap.fromLedger + 1,
      });
      continue;
    }

    const last = merged[merged.length - 1]!;
    if (gap.fromLedger <= last.toLedger + 1) {
      // Overlapping or adjacent interval: merge
      last.toLedger = Math.max(last.toLedger, gap.toLedger);
      last.missedLedgers = last.toLedger - last.fromLedger + 1;
    } else {
      merged.push({
        fromLedger: gap.fromLedger,
        toLedger: gap.toLedger,
        missedLedgers: gap.toLedger - gap.fromLedger + 1,
      });
    }
  }

  return merged;
}

/**
 * Extract observed min/max ledgers and derive capture completeness metadata.
 *
 * Validates supplied bounds and gap endpoints as non-negative safe integers,
 * distinguishing absent metadata from invalid supplied metadata.
 * Normalizes overlapping gaps before totaling missed ledgers.
 */
export function computeCaptureCompleteness(
  events: readonly unknown[] | null | undefined,
  options?: CaptureCompletenessOptions,
): CaptureCompleteness {
  let minObserved: number | null = null;
  let maxObserved: number | null = null;

  if (events && Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const l = (event as { ledger?: unknown }).ledger;
      if (typeof l === "number" && Number.isSafeInteger(l) && l >= 0) {
        if (minObserved === null || l < minObserved) minObserved = l;
        if (maxObserved === null || l > maxObserved) maxObserved = l;
      }
    }
  }

  // Validate supplied bounds: distinguish absent metadata from invalid supplied metadata
  let optFrom: number | undefined;
  if (options?.fromLedger !== undefined) {
    if (!isNonNegativeSafeInteger(options.fromLedger)) {
      throw new Error(`Invalid ledger range: fromLedger must be a non-negative safe integer; got ${String(options.fromLedger)}`);
    }
    optFrom = options.fromLedger;
  }
  if (options?.startLedger !== undefined) {
    if (!isNonNegativeSafeInteger(options.startLedger)) {
      throw new Error(`Invalid ledger range: startLedger must be a non-negative safe integer; got ${String(options.startLedger)}`);
    }
    if (optFrom === undefined) {
      optFrom = options.startLedger;
    }
  }

  let optTo: number | undefined;
  if (options?.toLedger !== undefined) {
    if (!isNonNegativeSafeInteger(options.toLedger)) {
      throw new Error(`Invalid ledger range: toLedger must be a non-negative safe integer; got ${String(options.toLedger)}`);
    }
    optTo = options.toLedger;
  }
  if (options?.endLedger !== undefined) {
    if (!isNonNegativeSafeInteger(options.endLedger)) {
      throw new Error(`Invalid ledger range: endLedger must be a non-negative safe integer; got ${String(options.endLedger)}`);
    }
    if (optTo === undefined) {
      optTo = options.endLedger;
    }
  }

  const startLedger = optFrom !== undefined ? optFrom : minObserved;
  const endLedger = optTo !== undefined ? optTo : maxObserved;

  if (startLedger !== null && endLedger !== null && startLedger > endLedger) {
    throw new Error(`Invalid ledger range: startLedger (${startLedger}) cannot exceed endLedger (${endLedger})`);
  }

  if (options?.isComplete !== undefined && typeof options.isComplete !== "boolean") {
    throw new Error(`Invalid option: isComplete must be a boolean; got ${typeof options.isComplete}`);
  }
  if (options?.requireComplete !== undefined && typeof options.requireComplete !== "boolean") {
    throw new Error(`Invalid option: requireComplete must be a boolean; got ${typeof options.requireComplete}`);
  }

  // Validate and collect raw gaps
  const rawGaps: unknown[] = [];
  if (options?.gaps !== undefined) {
    if (!Array.isArray(options.gaps)) {
      throw new Error(`Invalid gaps: expected an array; got ${typeof options.gaps}`);
    }
    rawGaps.push(...options.gaps);
  }
  if (options?.knownGaps !== undefined) {
    if (!Array.isArray(options.knownGaps)) {
      throw new Error(`Invalid knownGaps: expected an array; got ${typeof options.knownGaps}`);
    }
    rawGaps.push(...options.knownGaps);
  }

  const parsedGaps: CaptureGap[] = [];

  for (let i = 0; i < rawGaps.length; i++) {
    const g = rawGaps[i];
    if (!g || typeof g !== "object") {
      throw new Error(`Invalid gap entry at index ${i}: expected an object; got ${String(g)}`);
    }
    const rec = g as Record<string, unknown>;
    const f = "fromLedger" in rec ? rec.fromLedger : ("from" in rec ? rec.from : undefined);
    const t = "toLedger" in rec ? rec.toLedger : ("to" in rec ? rec.to : undefined);

    if (f === undefined || !isNonNegativeSafeInteger(f)) {
      throw new Error(`Invalid gap entry at index ${i}: fromLedger must be a non-negative safe integer; got ${String(f)}`);
    }
    if (t === undefined || !isNonNegativeSafeInteger(t)) {
      throw new Error(`Invalid gap entry at index ${i}: toLedger must be a non-negative safe integer; got ${String(t)}`);
    }
    if (f > t) {
      throw new Error(`Invalid gap range at index ${i}: fromLedger (${f}) cannot exceed toLedger (${t})`);
    }

    let missed = t - f + 1;
    if ("missedLedgers" in rec && rec.missedLedgers !== undefined) {
      const m = rec.missedLedgers;
      if (!isNonNegativeSafeInteger(m) || m <= 0) {
        throw new Error(`Invalid gap entry at index ${i}: missedLedgers must be a positive safe integer; got ${String(m)}`);
      }
      missed = m;
    }

    parsedGaps.push({ fromLedger: f, toLedger: t, missedLedgers: missed });
  }

  // Normalize and merge overlapping or adjacent gaps before totaling missed ledgers
  const gaps = normalizeGaps(parsedGaps);
  const hasGaps = gaps.length > 0;
  const totalMissedLedgers = gaps.reduce((sum, g) => sum + g.missedLedgers, 0);

  // A capture is only complete if explicitly asserted complete AND containing no gaps
  const isComplete = !hasGaps && options?.isComplete === true;
  const isPartial = !isComplete;

  const completeness: CaptureCompleteness = {
    startLedger,
    endLedger,
    ledgerRange: {
      fromLedger: startLedger,
      toLedger: endLedger,
    },
    gaps,
    hasGaps,
    totalMissedLedgers,
    isComplete,
    isPartial,
  };

  if (options?.requireComplete && !isComplete) {
    const gapDetail = hasGaps ? ` (${gaps.length} gap(s), ${totalMissedLedgers} missed ledger(s))` : "";
    throw new IncompleteCaptureError(
      `Cannot present partial capture as global market totals: series capture is incomplete${gapDetail}`,
      completeness,
    );
  }

  return completeness;
}
