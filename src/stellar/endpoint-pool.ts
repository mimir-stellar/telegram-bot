/**
 * Scored RPC endpoint pool for failover.
 *
 * Maintains a set of Soroban RPC URLs, scores them based on recent success
 * rate and latency, and quarantines failing endpoints with exponential backoff.
 * The pool never throws: when all endpoints are quarantined, it returns the
 * least-bad one (highest score, even if negative).
 *
 * Scoring is deterministic given an injected clock and the sequence of reports,
 * which makes the behavior testable and predictable.
 */

import { redactUrl } from "../redact.js";

/** Milliseconds for a score to decay by half (exponential decay). */
const SCORE_HALF_LIFE_MS = 300_000; // 5 minutes

/** Consecutive failures before quarantine. */
const QUARANTINE_THRESHOLD = 3;

/** Base quarantine duration in milliseconds. */
const QUARANTINE_BASE_MS = 10_000; // 10 seconds

/** Exponential backoff multiplier for quarantine. */
const QUARANTINE_BACKOFF = 2;

/** Maximum quarantine duration. */
const QUARANTINE_MAX_MS = 300_000; // 5 minutes

/**
 * Outcome of an RPC request for scoring purposes.
 */
export type EndpointOutcome = "success" | "error" | "timeout";

/**
 * Clock interface for deterministic testing.
 */
export interface Clock {
  now(): number;
}

/** Real-time clock using Date.now(). */
export const realClock: Clock = {
  now: () => Date.now(),
};

/**
 * Per-endpoint state tracked by the pool.
 */
interface EndpointState {
  url: string;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  quarantineAttemptCount: number;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastLatencyMs: number | null;
  quarantinedUntilMs: number;
}

/**
 * Snapshot of endpoint state for diagnostics (URLs redacted).
 */
export interface EndpointSnapshot {
  url: string; // redacted
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  quarantineAttemptCount: number;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastLatencyMs: number | null;
  quarantinedUntilMs: number;
  score: number;
}

/**
 * Full pool snapshot for diagnostics.
 */
export interface PoolSnapshot {
  endpoints: EndpointSnapshot[];
  selected: string; // redacted URL of current pick
}

/**
 * Options for creating an endpoint pool.
 */
export interface EndpointPoolOptions {
  clock?: Clock;
  scoreHalfLifeMs?: number;
  quarantineThreshold?: number;
  quarantineBaseMs?: number;
  quarantineBackoff?: number;
  quarantineMaxMs?: number;
}

/**
 * A scored pool of RPC endpoints with failover.
 */
export class EndpointPool {
  private readonly endpoints: Map<string, EndpointState>;
  private readonly clock: Clock;
  private readonly scoreHalfLifeMs: number;
  private readonly quarantineThreshold: number;
  private readonly quarantineBaseMs: number;
  private readonly quarantineBackoff: number;
  private readonly quarantineMaxMs: number;

  constructor(urls: readonly string[], options: EndpointPoolOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.scoreHalfLifeMs = options.scoreHalfLifeMs ?? SCORE_HALF_LIFE_MS;
    this.quarantineThreshold = options.quarantineThreshold ?? QUARANTINE_THRESHOLD;
    this.quarantineBaseMs = options.quarantineBaseMs ?? QUARANTINE_BASE_MS;
    this.quarantineBackoff = options.quarantineBackoff ?? QUARANTINE_BACKOFF;
    this.quarantineMaxMs = options.quarantineMaxMs ?? QUARANTINE_MAX_MS;

    this.endpoints = new Map();
    for (const url of urls) {
      this.endpoints.set(url, {
        url,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        quarantineAttemptCount: 0,
        lastSuccessMs: null,
        lastFailureMs: null,
        lastLatencyMs: null,
        quarantinedUntilMs: 0,
      });
    }
  }

  /**
   * Pick the best available endpoint.
   *
   * Prefer unquarantined endpoints with higher scores. If all are quarantined,
   * return the least-bad (highest score) regardless of quarantine status.
   * Never throws: returns some endpoint if the pool is non-empty.
   */
  pick(): string {
    const candidates: { url: string; score: number; quarantined: boolean }[] = [];

    for (const [url, state] of this.endpoints) {
      const score = this.calculateScore(state);
      const quarantined = state.quarantinedUntilMs > this.clock.now();
      candidates.push({ url, score, quarantined });
    }

    // Separate quarantined and unquarantined
    const unquarantined = candidates.filter((c) => !c.quarantined);
    const quarantined = candidates.filter((c) => c.quarantined);

    // Prefer unquarantined, highest score first
    if (unquarantined.length > 0) {
      unquarantined.sort((a, b) => b.score - a.score);
      return unquarantined[0]!.url;
    }

    // Fallback to least-bad quarantined endpoint
    quarantined.sort((a, b) => b.score - a.score);
    return quarantined[0]?.url ?? "";
  }

  /**
   * Report the outcome of an RPC request for a specific endpoint.
   *
   * Updates scoring state and may trigger quarantine for consecutive failures.
   */
  report(url: string, outcome: EndpointOutcome, latencyMs: number): void {
    const state = this.endpoints.get(url);
    if (!state) return;

    const now = this.clock.now();

    if (outcome === "success") {
      state.successCount += 1;
      state.consecutiveFailures = 0;
      state.lastSuccessMs = now;
      state.lastLatencyMs = latencyMs;
      // Clear quarantine on success (keep attempt count for backoff)
      state.quarantinedUntilMs = 0;
    } else {
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      state.lastFailureMs = now;

      // Trigger quarantine if threshold exceeded
      if (state.consecutiveFailures >= this.quarantineThreshold) {
        state.quarantineAttemptCount += 1;
        const quarantineDuration = Math.min(
          this.quarantineBaseMs *
            Math.pow(this.quarantineBackoff, state.quarantineAttemptCount - 1),
          this.quarantineMaxMs,
        );
        state.quarantinedUntilMs = now + quarantineDuration;
      }
    }
  }

  /**
   * Get a snapshot of pool state for diagnostics.
   *
   * URLs are redacted using `redactUrl` to avoid leaking credentials.
   */
  snapshot(): PoolSnapshot {
    const selected = this.pick();

    const endpoints: EndpointSnapshot[] = [];
    for (const state of this.endpoints.values()) {
      const score = this.calculateScore(state);
      endpoints.push({
        url: redactUrl(state.url),
        successCount: state.successCount,
        failureCount: state.failureCount,
        consecutiveFailures: state.consecutiveFailures,
        quarantineAttemptCount: state.quarantineAttemptCount,
        lastSuccessMs: state.lastSuccessMs,
        lastFailureMs: state.lastFailureMs,
        lastLatencyMs: state.lastLatencyMs,
        quarantinedUntilMs: state.quarantinedUntilMs,
        score,
      });
    }

    return {
      endpoints,
      selected: redactUrl(selected),
    };
  }

  /**
   * Calculate the score for an endpoint.
   *
   * Higher score = better endpoint.
   * Score decays over time based on last success.
   * Latency penalty is logarithmic to avoid extreme values.
   * Consecutive failures apply a linear penalty.
   */
  private calculateScore(state: EndpointState): number {
    const now = this.clock.now();

    // Success rate with decay
    let successScore = 0;
    if (state.lastSuccessMs !== null) {
      const ageMs = now - state.lastSuccessMs;
      const decayFactor = Math.pow(0.5, ageMs / this.scoreHalfLifeMs);
      successScore = state.successCount * decayFactor;
    }

    // Latency penalty (logarithmic to avoid extreme values)
    let latencyPenalty = 0;
    if (state.lastLatencyMs !== null) {
      latencyPenalty = Math.log1p(state.lastLatencyMs);
    }

    // Consecutive failure penalty
    const failurePenalty = state.consecutiveFailures * 10;

    return successScore - latencyPenalty - failurePenalty;
  }
}

/**
 * Create an endpoint pool from a list of URLs.
 */
export function createEndpointPool(
  urls: readonly string[],
  options: EndpointPoolOptions = {},
): EndpointPool {
  return new EndpointPool(urls, options);
}
