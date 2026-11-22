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
 * This sampler collapses repeats in two distinct ways:
 *
 * ── Windowed repeats (record) ─────────────────────────────────────────────────
 *
 *  - the first `maxPerWindow` occurrences are returned for the caller to log;
 *  - further occurrences are counted and suppressed;
 *  - the next occurrence after the window elapses is returned for logging with
 *    `suppressed` carrying the number of repeats that were held back, so a
 *    suppressed run is always reported rather than silently dropped.
 *  - `sample.kind === "repeat"` on every call.
 *
 * ── Suppressed categories (recordCategory) ───────────────────────────────────
 *
 *  - an entire error class (e.g. "feature-flag mismatch") may be suppressed
 *    after its first occurrence so it does not pollute operational logs on every
 *    cycle while the condition persists;
 *  - the first call logs (`log: true, kind: "category"`), subsequent calls
 *    within the same active period return `log: false, kind: "category"`;
 *  - when the category is explicitly cleared via `clearCategory(key)` the next
 *    call logs again, carrying the count of occurrences that were held back.
 *
 * Nothing is lost: {@link LogSampler.suppressedTotal} keeps the lifetime count
 * for status output, and {@link LogSampler.pending} exposes the repeats still
 * waiting inside an open window.
 *
 * The two kinds produce different log suffixes so an operator can immediately
 * see whether a quiet spell was a rate-limited torrent of the same error or a
 * category of errors the bot chose to silence until something changes.
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

/**
 * What kind of suppression produced this sample decision.
 *
 * - `"repeat"` — the caller hit the per-window rate limit for this key; the
 *   log suffix should name how many identical repeats were held back.
 * - `"category"` — the caller registered this key as a suppressed error
 *   category; the log suffix should name how many occurrences of that
 *   category were held back while it was active.
 */
export type LogSampleKind = "repeat" | "category";

export interface LogSample {
  /** Log the caller's own line for this occurrence. */
  log: boolean;
  /**
   * Occurrences suppressed before this one, for the caller to summarize.
   *
   * For `kind === "repeat"`: non-zero only when a window rolled over with
   * repeats held back; those repeats are reported once and then reset.
   *
   * For `kind === "category"`: non-zero only when `clearCategory` was called
   * after one or more suppressed occurrences; those are reported on the next
   * `recordCategory` call and then reset.
   *
   * Always ≥ 0.
   */
  suppressed: number;
  /** Whether this was a windowed-repeat suppression or a category suppression. */
  kind: LogSampleKind;
}

interface Window {
  windowStart: number;
  emitted: number;
  suppressed: number;
}

interface CategoryState {
  /** Whether the category is currently active (first occurrence already logged). */
  active: boolean;
  /** Occurrences suppressed while the category was active. */
  suppressed: number;
}

const DEFAULT_MAX_PER_WINDOW = 3;
/** 5 minutes: ~10 default poll cycles of a down RPC collapse into one line. */
const DEFAULT_WINDOW_MS = 300_000;

/**
 * Suffix for a sampled line that opens a new window, reporting how many windowed
 * repeats the previous window held back. Empty when there is nothing to report,
 * so callers can append it unconditionally.
 *
 * Use this for `kind === "repeat"` samples.
 */
export function formatSuppressedRepeats(suppressed: number, windowMs: number): string {
  if (suppressed <= 0) return "";
  // Round for display; a sub-second window is reported as "1s", never "0s".
  const seconds = Math.max(1, Math.round(windowMs / 1000));
  return (
    ` (suppressed ${suppressed} identical repeat${suppressed === 1 ? "" : "s"}` +
    ` in the previous ${seconds}s)`
  );
}

/**
 * Suffix for a category-suppression line that re-activates after being cleared,
 * reporting how many occurrences of that error category were held back while it
 * was active. Empty when there is nothing to report.
 *
 * Use this for `kind === "category"` samples with `suppressed > 0`.
 */
export function formatSuppressedCategory(suppressed: number): string {
  if (suppressed <= 0) return "";
  return (
    ` (${suppressed} occurrence${suppressed === 1 ? "" : "s"} of this error category suppressed` +
    ` since it was last seen)`
  );
}

export class LogSampler {
  readonly maxPerWindow: number;
  readonly windowMs: number;

  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();
  private readonly categories = new Map<string, CategoryState>();
  private lifetimeSuppressed = 0;

  constructor(options: LogSamplerOptions = {}) {
    this.maxPerWindow = Math.max(1, Math.trunc(options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW));
    this.windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.now = options.now ?? Date.now;
  }

  /**
   * Record one occurrence of `key` and decide whether it should be logged.
   *
   * Returns `kind: "repeat"` on every call. Use {@link recordCategory} when you
   * want to suppress an entire error class rather than a rate-limited burst.
   */
  record(key: string): LogSample {
    const at = this.now();
    const current = this.windows.get(key);

    if (current === undefined || at - current.windowStart >= this.windowMs) {
      // A new window opens. Anything held back in the previous one is handed to
      // the caller on this line instead of disappearing.
      // Math.max(0, ...) guards against any external manipulation that could
      // push the counter below zero (e.g. a race or a test that patches state).
      const carried = Math.max(0, current?.suppressed ?? 0);
      this.windows.set(key, { windowStart: at, emitted: 1, suppressed: 0 });
      return { log: true, suppressed: carried, kind: "repeat" };
    }

    if (current.emitted < this.maxPerWindow) {
      current.emitted += 1;
      return { log: true, suppressed: 0, kind: "repeat" };
    }

    current.suppressed += 1;
    this.lifetimeSuppressed += 1;
    return { log: false, suppressed: 0, kind: "repeat" };
  }

  /**
   * Record one occurrence of an error *category* identified by `key`.
   *
   * The first call within an active period logs (`log: true`). Every subsequent
   * call returns `log: false` and increments the held-back counter. When the
   * category is cleared via {@link clearCategory}, the next call logs again and
   * carries the count of occurrences that were suppressed while it was active.
   *
   * Returns `kind: "category"` on every call, so callers and formatters can
   * distinguish this from a windowed repeat.
   */
  recordCategory(key: string): LogSample {
    const state = this.categories.get(key);

    if (state === undefined || !state.active) {
      // First occurrence (or re-occurrence after a clear): log it and activate.
      // Carry any suppressed count accumulated before the clear so the operator
      // sees the full picture on the re-activation line.
      const carried = Math.max(0, state?.suppressed ?? 0);
      this.categories.set(key, { active: true, suppressed: 0 });
      return { log: true, suppressed: carried, kind: "category" };
    }

    // Category already active: suppress and count.
    state.suppressed += 1;
    this.lifetimeSuppressed += 1;
    return { log: false, suppressed: 0, kind: "category" };
  }

  /**
   * Deactivate the error category for `key` so the next {@link recordCategory}
   * call logs again. Has no effect when the key is unknown or already inactive.
   *
   * Call this when the condition that triggered the category has resolved (e.g.
   * the RPC reconnected, the feature flag was updated), so the operator sees a
   * fresh log line the next time the category fires.
   */
  clearCategory(key: string): void {
    const state = this.categories.get(key);
    if (state) state.active = false;
  }

  /** Repeats held back in the open window for `key`, not yet reported. */
  pending(key: string): number {
    return this.windows.get(key)?.suppressed ?? 0;
  }

  /**
   * Occurrences held back for a suppressed category `key`, not yet reported.
   * Returns 0 for unknown keys.
   */
  pendingCategory(key: string): number {
    return this.categories.get(key)?.suppressed ?? 0;
  }

  /** Occurrences suppressed across every key and category since construction. */
  suppressedTotal(): number {
    return this.lifetimeSuppressed;
  }

  /** Number of distinct repeat-sampled keys observed so far. */
  size(): number {
    return this.windows.size;
  }
}
