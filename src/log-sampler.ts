/**
 * Windowed sampling for repetitive operational logs.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * This process is built to stay up for weeks, so it also fails for hours at a
 * time: an RPC that is down stays down, and the poller retries both contracts
 * every cycle. Logging each identical failure verbatim buries the one line that
 * actually changed under a wall of copies, and it is the copies that blow up
 * the log volume on a long outage.
 *
 * This sampler collapses repeats by KEY. Within a window of `windowMs`:
 *
 *  - the first `maxPerWindow` occurrences are returned for the caller to log;
 *  - further occurrences are counted and suppressed;
 *  - the next occurrence after the window elapses is returned for logging with
 *    `suppressed` carrying the number of repeats that were held back, so a
 *    suppressed run is always reported rather than silently dropped.
 *
 * Nothing is lost: {@link LogSampler.suppressedTotal} keeps the lifetime count
 * for status output, and {@link LogSampler.pending} exposes the repeats still
 * waiting inside an open window.
 *
 * The clock is injected so the behaviour is deterministic under test. `key` is
 * the caller's identity for "the same failure" — one key per watch target, so a
 * broken market contract cannot silence the squad contract's errors.
 */

export interface LogSamplerOptions {
  /** Full lines returned per key per window. Clamped to at least 1. */
  maxPerWindow?: number;
  /** Window length in milliseconds. Clamped to at least 1. */
  windowMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface LogSample {
  /** Log the caller's own line for this occurrence. */
  log: boolean;
  /**
   * Repeats suppressed before this occurrence, for the caller to summarize.
   * Non-zero only when a window rolled over with repeats held back; those
   * repeats are reported once and then reset.
   */
  suppressed: number;
}

export interface LogKeyStats {
  /** Whether at least one occurrence has been observed since creation/reset. */
  firstOccurrenceSeen: boolean;
  /** Emitted occurrences for this key since creation/reset (>= 0). */
  emitted: number;
  /** Repeats currently withheld in the active window (>= 0). */
  pending: number;
  /** Total repeats withheld for this key since creation/reset (>= 0). */
  suppressedTotal: number;
  /** Coherent total occurrences (`emitted + suppressedTotal`, >= 0). */
  aggregateCount: number;
}

export interface LogSamplerSnapshot {
  epoch: number;
  suppressedTotal: number;
  keys: Record<string, LogKeyStats>;
}

export interface LogSamplerDelta {
  resetBoundaryCrossed: boolean;
  suppressedDelta: number;
  keys: Record<string, { emittedDelta: number; suppressedDelta: number; aggregateDelta: number }>;
}

interface Window {
  windowStart: number;
  emitted: number;
  suppressed: number;
  totalEmitted: number;
  totalSuppressed: number;
}

const DEFAULT_MAX_PER_WINDOW = 3;
/** 5 minutes: ~10 default poll cycles of a down RPC collapse into one line. */
const DEFAULT_WINDOW_MS = 300_000;

/**
 * Suffix for a sampled line that opens a new window, reporting how many repeats
 * the previous one held back. Empty when there is nothing to report, so callers
 * can append it unconditionally.
 */
export function formatSuppressedRepeats(suppressed: number, windowMs: number): string {
  if (!Number.isFinite(suppressed) || suppressed <= 0) return "";
  const safeSuppressed = Math.max(0, Math.trunc(suppressed));
  if (safeSuppressed <= 0) return "";
  // Round for display; a sub-second window is reported as "1s", never "0s".
  const safeWindowMs = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
  const seconds = Math.max(1, Math.round(safeWindowMs / 1000));
  return (
    ` (suppressed ${safeSuppressed} identical repeat${safeSuppressed === 1 ? "" : "s"}` +
    ` in the previous ${seconds}s)`
  );
}

/**
 * Explicit suffix for structured sampled-repeat lines, keeping aggregate count
 * coherent with the initial emitted occurrence(s) and clamping non-positive inputs.
 */
export function formatSampledRepeatSuffix(
  sampledRepeats: number,
  aggregateCount: number,
  windowMs: number,
): string {
  if (!Number.isFinite(sampledRepeats) || sampledRepeats <= 0) return "";
  const safeRepeats = Math.max(0, Math.trunc(sampledRepeats));
  if (safeRepeats <= 0) return "";
  const rawAgg = Number.isFinite(aggregateCount) ? Math.trunc(aggregateCount) : 0;
  const safeAggregate = Math.max(safeRepeats + 1, rawAgg);
  const safeWindowMs = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
  const seconds = Math.max(1, Math.round(safeWindowMs / 1000));
  return (
    ` [sampled_repeat: +${safeRepeats} identical repeat${safeRepeats === 1 ? "" : "s"}` +
    ` in ${seconds}s (${safeAggregate} total)]`
  );
}

/**
 * Explicit suffix for policy-suppressed error categories, clearly distinct from
 * windowed sampled repeats while keeping the first occurrence and aggregate coherent.
 */
export function formatSuppressedCategorySuffix(
  category: string,
  firstOccurrence: boolean,
  suppressedCount: number,
  aggregateCount: number,
): string {
  const safeSuppressed = Number.isFinite(suppressedCount)
    ? Math.max(0, Math.trunc(suppressedCount))
    : 0;
  const rawAgg = Number.isFinite(aggregateCount) ? Math.trunc(aggregateCount) : 0;
  if (firstOccurrence && safeSuppressed === 0) {
    const safeAggregate = Math.max(1, rawAgg);
    return ` [suppressed_category=${category}: first occurrence (${safeAggregate} total), repeats muted]`;
  }
  const safeAggregate = Math.max(safeSuppressed + 1, rawAgg);
  return (
    ` [suppressed_category=${category}: +${safeSuppressed} suppressed` +
    ` (${safeAggregate} total)]`
  );
}

export class LogSampler {
  readonly maxPerWindow: number;
  readonly windowMs: number;

  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();
  private lifetimeSuppressed = 0;
  private epoch = 0;

  constructor(options: LogSamplerOptions = {}) {
    this.maxPerWindow = Math.max(1, Math.trunc(options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW));
    this.windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.now = options.now ?? Date.now;
  }

  /** Record one occurrence of `key` and decide whether it should be logged. */
  record(key: string): LogSample {
    const at = this.now();
    const current = this.windows.get(key);

    if (current !== undefined && at < current.windowStart) {
      // Guard against non-monotonic clock steps so elapsed time never goes negative.
      current.windowStart = at;
    }

    if (current === undefined || at - current.windowStart >= this.windowMs) {
      // A new window opens. Anything held back in the previous one is handed to
      // the caller on this line instead of disappearing.
      const carried = Math.max(0, current?.suppressed ?? 0);
      const prevEmitted = current?.totalEmitted ?? 0;
      const prevSuppressed = current?.totalSuppressed ?? 0;
      this.windows.set(key, {
        windowStart: at,
        emitted: 1,
        suppressed: 0,
        totalEmitted: prevEmitted + 1,
        totalSuppressed: prevSuppressed,
      });
      return { log: true, suppressed: carried };
    }

    if (current.emitted < this.maxPerWindow) {
      current.emitted += 1;
      current.totalEmitted += 1;
      return { log: true, suppressed: 0 };
    }

    current.suppressed += 1;
    current.totalSuppressed += 1;
    this.lifetimeSuppressed += 1;
    return { log: false, suppressed: 0 };
  }

  /** Repeats held back in the open window for `key`, not yet reported. */
  pending(key: string): number {
    return Math.max(0, this.windows.get(key)?.suppressed ?? 0);
  }

  /** Coherent lifetime counters for `key` (`aggregateCount === emitted + suppressedTotal`). */
  stats(key: string): LogKeyStats {
    const current = this.windows.get(key);
    if (!current) {
      return {
        firstOccurrenceSeen: false,
        emitted: 0,
        pending: 0,
        suppressedTotal: 0,
        aggregateCount: 0,
      };
    }
    const emitted = Math.max(0, current.totalEmitted);
    const suppressedTotal = Math.max(0, current.totalSuppressed);
    return {
      firstOccurrenceSeen: emitted >= 1,
      emitted,
      pending: Math.max(0, current.suppressed),
      suppressedTotal,
      aggregateCount: emitted + suppressedTotal,
    };
  }

  /** Reset either one key or the entire sampler, advancing the reset epoch. */
  reset(key?: string): void {
    this.epoch += 1;
    if (key !== undefined) {
      this.windows.delete(key);
      return;
    }
    this.windows.clear();
    this.lifetimeSuppressed = 0;
  }

  /** Capture a point-in-time snapshot for reset-safe delta comparisons. */
  snapshot(): LogSamplerSnapshot {
    const keys: Record<string, LogKeyStats> = {};
    for (const key of this.windows.keys()) {
      keys[key] = this.stats(key);
    }
    return {
      epoch: this.epoch,
      suppressedTotal: Math.max(0, this.lifetimeSuppressed),
      keys,
    };
  }

  /**
   * Compute non-negative deltas since `previous`. Crossing a `reset()` boundary
   * re-anchors at zero instead of reporting negative counts.
   */
  deltaSince(previous: LogSamplerSnapshot): LogSamplerDelta {
    const current = this.snapshot();
    const resetBoundaryCrossed =
      previous.epoch !== current.epoch || current.suppressedTotal < previous.suppressedTotal;
    const suppressedDelta = resetBoundaryCrossed
      ? current.suppressedTotal
      : Math.max(0, current.suppressedTotal - Math.max(0, previous.suppressedTotal));
    const keys: LogSamplerDelta["keys"] = {};
    for (const [key, cur] of Object.entries(current.keys)) {
      const prev = resetBoundaryCrossed ? undefined : previous.keys[key];
      const keyReset =
        prev === undefined ||
        cur.emitted < prev.emitted ||
        cur.suppressedTotal < prev.suppressedTotal ||
        cur.aggregateCount < prev.aggregateCount;
      keys[key] = {
        emittedDelta: keyReset ? cur.emitted : Math.max(0, cur.emitted - prev.emitted),
        suppressedDelta: keyReset
          ? cur.suppressedTotal
          : Math.max(0, cur.suppressedTotal - prev.suppressedTotal),
        aggregateDelta: keyReset
          ? cur.aggregateCount
          : Math.max(0, cur.aggregateCount - prev.aggregateCount),
      };
    }
    return { resetBoundaryCrossed, suppressedDelta, keys };
  }

  /** Occurrences suppressed across every key since construction. */
  suppressedTotal(): number {
    return Math.max(0, this.lifetimeSuppressed);
  }

  /** Number of distinct keys observed so far. */
  size(): number {
    return this.windows.size;
  }
}
