/**
 * Rolling baseline for per-cycle poll activity.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The poller logs how many events each cycle saw and the metrics registry keeps
 * cumulative totals. Neither answers the operational question an operator
 * actually asks during an incident: **is this cycle unusually busy or quiet
 * compared with what normal looks like for this deployment?** A total keeps
 * growing and a single log line has nothing to compare against.
 *
 * This module keeps a small, bounded window of recent per-cycle event counts
 * and compares every new observation with the mean of the window *before* it
 * was added. The result is a small, JSON-safe snapshot that can be logged,
 * served from `/health`, and exported as metrics.
 *
 * ── Statistical choices ──────────────────────────────────────────────────────
 *
 *  - The window is a sample of recent cycles, so the comparator uses the sample
 *    standard deviation (n − 1). A quiet chain with a few busy cycles widens
 *    the baseline instead of making every later event look anomalous.
 *  - `scaleFloor` puts a lower bound on the divisor. A perfectly flat baseline
 *    has a standard deviation of 0; dividing by it would make every non-zero
 *    count infinitely anomalous (and every zero count undefined). With a floor
 *    of one event, a single event is one deviation and a real burst still
 *    crosses the threshold.
 *  - The observation is compared with the window *before* being appended, so a
 *    spike cannot dilute its own baseline. It is appended afterwards, so the
 *    next cycle compares against it.
 *  - Until `minSamples` prior observations exist the snapshot says
 *    `warming-up`: a baseline inferred from one cycle is worse than no baseline
 *    at all.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *
 * Only integer counts enter this module. There are no remote payloads, strings,
 * identifiers, or timestamps, so a snapshot is safe to log or serve unchanged.
 */

/** How an observed value relates to the retained baseline. */
export type ActivityDeviation = "warming-up" | "normal" | "spike" | "drop";

export interface ActivityBaselineOptions {
  /** Maximum observations retained. Default 20 (≈10 minutes at 30s polls). */
  windowSize?: number;
  /** Prior observations required before a comparison is made. Default 10. */
  minSamples?: number;
  /** Absolute z-score at or above which a cycle is anomalous. Default 3. */
  zThreshold?: number;
  /** Minimum divisor for the z-score, in observations. Default 1. */
  scaleFloor?: number;
}

/** The comparison produced for one observation. */
export interface ActivityComparison {
  /** The count just observed. */
  value: number;
  /** Mean of the prior window; null while warming up (no prior samples). */
  mean: number | null;
  /** Sample standard deviation of the prior window; null while warming up. */
  stdDev: number | null;
  /** `(value − mean) / max(stdDev, scaleFloor)`; null while warming up. */
  zScore: number | null;
  /** Prior observations used for this comparison. */
  samples: number;
  deviation: ActivityDeviation;
  /** True exactly when `deviation` is `"spike"` or `"drop"`. */
  anomalous: boolean;
}

/** JSON-safe state of the baseline, suitable for `/health` and logs. */
export interface ActivityBaselineSnapshot {
  windowSize: number;
  minSamples: number;
  zThreshold: number;
  /** Observations currently retained (0 … windowSize). */
  samples: number;
  /** Most recently observed count, or null before the first observation. */
  lastValue: number | null;
  /** Mean of the window used for the last comparison; null while warming up. */
  baselineMean: number | null;
  /** Sample standard deviation of that window; null while warming up. */
  baselineStdDev: number | null;
  /** z-score of `lastValue` against that window; null while warming up. */
  zScore: number | null;
  /** Classification of the most recent observation. */
  deviation: ActivityDeviation;
  /** Observations classified as spike or drop since construction / reset. */
  anomalies: number;
}

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MIN_SAMPLES = 10;
const DEFAULT_Z_THRESHOLD = 3;
const DEFAULT_SCALE_FLOOR = 1;

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; got ${value}`);
  }
  return value;
}

function positiveFinite(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number; got ${value}`);
  }
  return value;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Sample standard deviation (n − 1). Caller guarantees at least two values. */
function sampleStdDev(values: readonly number[], average: number): number {
  let sumSquares = 0;
  for (const value of values) {
    const delta = value - average;
    sumSquares += delta * delta;
  }
  return Math.sqrt(sumSquares / (values.length - 1));
}

/**
 * A bounded rolling window of per-cycle activity.
 *
 * One instance belongs to one poller. `record()` is called once per *complete*
 * cycle (every target scanned successfully), and returns the comparison for
 * that cycle. Incomplete cycles should not be recorded: a target in backoff
 * would otherwise look like a quiet chain.
 */
export class ActivityBaseline {
  readonly windowSize: number;
  readonly minSamples: number;
  readonly zThreshold: number;
  readonly scaleFloor: number;

  private readonly window: number[] = [];
  private lastComparison: ActivityComparison | null = null;
  private anomalyCount = 0;

  constructor(options: ActivityBaselineOptions = {}) {
    this.windowSize = positiveInteger("windowSize", options.windowSize, DEFAULT_WINDOW_SIZE);
    this.minSamples = positiveInteger("minSamples", options.minSamples, DEFAULT_MIN_SAMPLES);
    if (this.minSamples > this.windowSize) {
      throw new RangeError(
        `minSamples (${this.minSamples}) cannot exceed windowSize (${this.windowSize})`,
      );
    }
    this.zThreshold = positiveFinite("zThreshold", options.zThreshold, DEFAULT_Z_THRESHOLD);
    this.scaleFloor = positiveFinite("scaleFloor", options.scaleFloor, DEFAULT_SCALE_FLOOR);
  }

  /**
   * Compare `value` with the current window, then append it.
   *
   * Throws `RangeError` for anything that is not a non-negative safe integer:
   * the only caller is the poller's own counter, so a malformed value is a bug,
   * not remote input.
   */
  record(value: number): ActivityComparison {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`activity counts must be non-negative safe integers; got ${value}`);
    }

    const samples = this.window.length;
    let baselineMean: number | null = null;
    let baselineStdDev: number | null = null;
    let zScore: number | null = null;
    let deviation: ActivityDeviation = "warming-up";

    if (samples >= this.minSamples) {
      baselineMean = mean(this.window);
      baselineStdDev = samples >= 2 ? sampleStdDev(this.window, baselineMean) : 0;
      zScore = (value - baselineMean) / Math.max(baselineStdDev, this.scaleFloor);
      if (zScore >= this.zThreshold) deviation = "spike";
      else if (zScore <= -this.zThreshold) deviation = "drop";
      else deviation = "normal";
    }

    const comparison: ActivityComparison = {
      value,
      mean: baselineMean,
      stdDev: baselineStdDev,
      zScore,
      samples,
      deviation,
      anomalous: deviation === "spike" || deviation === "drop",
    };

    if (comparison.anomalous) this.anomalyCount += 1;
    this.lastComparison = comparison;

    this.window.push(value);
    if (this.window.length > this.windowSize) this.window.shift();

    return comparison;
  }

  /** Current JSON-safe state. Never throws. */
  snapshot(): ActivityBaselineSnapshot {
    const last = this.lastComparison;
    return {
      windowSize: this.windowSize,
      minSamples: this.minSamples,
      zThreshold: this.zThreshold,
      samples: this.window.length,
      lastValue: last?.value ?? null,
      baselineMean: last?.mean ?? null,
      baselineStdDev: last?.stdDev ?? null,
      zScore: last?.zScore ?? null,
      deviation: last?.deviation ?? "warming-up",
      anomalies: this.anomalyCount,
    };
  }

  /** Drop all observations and anomaly history. Window size is retained. */
  reset(): void {
    this.window.length = 0;
    this.lastComparison = null;
    this.anomalyCount = 0;
  }
}

/** Snapshot of a baseline that has not observed anything yet. */
export function emptyActivityBaseline(
  options: ActivityBaselineOptions = {},
): ActivityBaselineSnapshot {
  return new ActivityBaseline(options).snapshot();
}
