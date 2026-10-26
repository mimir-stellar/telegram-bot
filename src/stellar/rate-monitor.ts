/**
 * Event-rate monitor: spots sudden bursts or silences in contract activity.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The poller logs per-cycle activity and `src/metrics.ts` counts totals, but a
 * total only grows and a log line has nothing to compare against. During an
 * incident (a stuck RPC, a decoder that stopped matching, a contract flooded
 * with calls) the useful question is "is this source unusually busy or quiet
 * compared with its own recent history?".
 *
 * ── Model ────────────────────────────────────────────────────────────────────
 *
 * Time is cut into fixed windows of `windowMs`, aligned to the injected clock
 * (`floor(now / windowMs)`). `observe(source, count)` adds events to the
 * source's current window. `check()` only judges *completed* windows, so a
 * window that has just opened is never reported as silent.
 *
 *  - Baseline: the mean count of the `baselineWindows` completed windows that
 *    precede the window(s) being judged. The judged windows never dilute their
 *    own baseline.
 *  - Spike: the latest completed window holds more than
 *    `spikeFactor × max(baseline, minBaseline)` events.
 *  - Silence: the latest `silenceWindows` completed windows are all zero while
 *    the baseline before them is non-zero.
 *  - Warm-up: no alert is raised until a source has enough completed windows
 *    of history for the comparison (`baselineWindows + 1` for a spike,
 *    `baselineWindows` before the empty run began for a silence).
 *  - Recovery: once a completed window is back within range the source reports
 *    `normal` again; nothing is latched.
 *
 * ── Bounded memory ───────────────────────────────────────────────────────────
 *
 * Each source keeps at most `baselineWindows + max(1, silenceWindows)` window
 * counts in a ring plus two scalars for the current empty run (its length and
 * the baseline captured when it began), and long gaps are back-filled with at
 * most that many zero windows, so a long outage still reads as a silence. At most `maxSources` sources are tracked; when a new source would
 * exceed the cap, the one observed least recently is evicted. Source names are
 * clipped to `MAX_SOURCE_LENGTH` characters.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * Detection only: this module never sends alerts. Only integer counts and
 * operator-chosen source labels enter it, so a report is safe to log.
 */

/** Longest source label kept, in characters. */
export const MAX_SOURCE_LENGTH = 64;

/** How a source's latest completed window(s) compare with its baseline. */
export type RateState = "warming-up" | "normal" | "spike" | "silence";

export interface RateMonitorOptions {
  /** Length of one window in milliseconds. Must be a positive finite number. */
  windowMs: number;
  /** Completed windows averaged into the baseline. Positive integer. */
  baselineWindows: number;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  clock?: () => number;
  /** A window above `spikeFactor ×` baseline is a spike. Default 3. */
  spikeFactor?: number;
  /** Consecutive empty windows that count as a silence. Default 3. */
  silenceWindows?: number;
  /**
   * Floor applied to the baseline when testing for a spike, so a near-zero
   * baseline does not turn a single event into a burst. Default 1.
   */
  minBaseline?: number;
  /** Maximum number of sources tracked at once. Default 64. */
  maxSources?: number;
}

/** One source's verdict from {@link RateMonitor.check}. */
export interface RateSourceReport {
  source: string;
  state: RateState;
  /** Events in the latest completed window, or null if none has completed. */
  latest: number | null;
  /** Baseline mean used for the verdict, or null while warming up. */
  baseline: number | null;
  /** Start (ms) of the latest completed window, or null if none has completed. */
  windowStart: number | null;
}

/** An actionable anomaly: a spike or a silence. */
export interface RateAlert {
  source: string;
  kind: "spike" | "silence";
  latest: number;
  baseline: number;
  windowStart: number;
}

export interface RateCheckResult {
  /** Spikes and silences only, in source order. */
  alerts: RateAlert[];
  /** Every tracked source, including warming-up and normal ones. */
  sources: RateSourceReport[];
}

export interface RateMonitor {
  /** Add `count` events for `source` to the current window. */
  observe(source: string, count: number): void;
  /** Judge every tracked source against its baseline. */
  check(): RateCheckResult;
  /** Number of sources currently tracked. */
  size(): number;
}

interface SourceState {
  /** Counts of completed windows, oldest first, bounded by `capacity`. */
  history: number[];
  /** Index (floor(now / windowMs)) of the window `current` belongs to. */
  windowIndex: number;
  /** Events in the open window. */
  current: number;
  /** Completed windows seen since the source was first observed (saturating). */
  completed: number;
  /** Trailing run of completed empty windows (saturating). */
  zeroRun: number;
  /**
   * Baseline captured when the current empty run began, so a long outage keeps
   * reporting a silence even after the ring has filled with zeros. Null when
   * the run began before a full baseline existed, or there is no run.
   */
  runBaseline: number | null;
  /** Monotonic order of last observation, for eviction. */
  lastSeen: number;
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1) {
    throw new RangeError(`rate monitor: ${name} must be a positive integer`);
  }
  return v;
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v <= 0) {
    throw new RangeError(`rate monitor: ${name} must be a positive number`);
  }
  return v;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length === 0 ? 0 : sum / values.length;
}

export function createRateMonitor(options: RateMonitorOptions): RateMonitor {
  const windowMs = positiveNumber(options.windowMs, Number.NaN, "windowMs");
  const baselineWindows = positiveInt(options.baselineWindows, Number.NaN, "baselineWindows");
  const silenceWindows = positiveInt(options.silenceWindows, 3, "silenceWindows");
  const spikeFactor = positiveNumber(options.spikeFactor, 3, "spikeFactor");
  const minBaseline = positiveNumber(options.minBaseline, 1, "minBaseline");
  const maxSources = positiveInt(options.maxSources, 64, "maxSources");
  const clock = options.clock ?? Date.now;

  const capacity = baselineWindows + Math.max(1, silenceWindows);
  const sources = new Map<string, SourceState>();
  let tick = 0;

  const windowIndexAt = (ms: number): number => Math.floor(ms / windowMs);

  /** Close every window before `index`, back-filling gaps with zeros. */
  const rollTo = (state: SourceState, index: number): void => {
    if (index <= state.windowIndex) return;
    const gap = index - state.windowIndex;
    const push = (count: number): void => {
      if (count === 0) {
        if (state.zeroRun === 0) {
          state.runBaseline =
            state.history.length >= baselineWindows
              ? mean(state.history.slice(state.history.length - baselineWindows))
              : null;
        }
        if (state.zeroRun < capacity + silenceWindows) state.zeroRun++;
      } else {
        state.zeroRun = 0;
        state.runBaseline = null;
      }
      state.history.push(count);
      if (state.history.length > capacity) state.history.shift();
      if (state.completed < capacity + 1) state.completed++;
    };
    push(state.current);
    for (let i = 1; i < Math.min(gap, capacity + 1); i++) push(0);
    state.windowIndex = index;
    state.current = 0;
  };

  const evictOldest = (): void => {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, state] of sources) {
      if (state.lastSeen < oldestSeen) {
        oldestSeen = state.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) sources.delete(oldestKey);
  };

  const judge = (source: string, state: SourceState): RateSourceReport => {
    const latest = state.history.length > 0 ? state.history[state.history.length - 1]! : null;
    const windowStart = latest === null ? null : (state.windowIndex - 1) * windowMs;
    const base: RateSourceReport = { source, state: "warming-up", latest, baseline: null, windowStart };
    if (latest === null) return base;

    const h = state.history;
    if (state.zeroRun >= silenceWindows && state.runBaseline !== null && state.runBaseline > 0) {
      return { ...base, state: "silence", baseline: state.runBaseline };
    }

    if (state.completed < baselineWindows + 1 || h.length < baselineWindows + 1) return base;
    const baseline = mean(h.slice(h.length - 1 - baselineWindows, h.length - 1));
    if (latest > spikeFactor * Math.max(baseline, minBaseline)) {
      return { ...base, state: "spike", baseline };
    }
    return { ...base, state: "normal", baseline };
  };

  return {
    observe(source: string, count: number): void {
      if (!Number.isFinite(count) || count < 0) return;
      const key = String(source).slice(0, MAX_SOURCE_LENGTH);
      const index = windowIndexAt(clock());
      let state = sources.get(key);
      if (state === undefined) {
        if (sources.size >= maxSources) evictOldest();
        state = {
          history: [],
          windowIndex: index,
          current: 0,
          completed: 0,
          zeroRun: 0,
          runBaseline: null,
          lastSeen: 0,
        };
        sources.set(key, state);
      }
      rollTo(state, index);
      state.current += Math.floor(count);
      state.lastSeen = ++tick;
    },

    check(): RateCheckResult {
      const index = windowIndexAt(clock());
      const alerts: RateAlert[] = [];
      const reports: RateSourceReport[] = [];
      for (const [source, state] of sources) {
        rollTo(state, index);
        const report = judge(source, state);
        reports.push(report);
        if (
          (report.state === "spike" || report.state === "silence") &&
          report.latest !== null &&
          report.baseline !== null &&
          report.windowStart !== null
        ) {
          alerts.push({
            source,
            kind: report.state,
            latest: report.latest,
            baseline: report.baseline,
            windowStart: report.windowStart,
          });
        }
      }
      return { alerts, sources: reports };
    },

    size(): number {
      return sources.size;
    },
  };
}
