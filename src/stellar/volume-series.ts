import type { DecodedEvent } from "./decode.js";
import {
  computeCaptureCompleteness,
  type CaptureCompleteness,
  type CaptureCompletenessOptions,
} from "./capture-completeness.js";

export {
  assertCompleteCapture,
  computeCaptureCompleteness,
  IncompleteCaptureError,
  type CaptureCompleteness,
  type CaptureCompletenessOptions,
  type CaptureGap,
  type CaptureGapInput,
  type LedgerRange,
} from "./capture-completeness.js";

export type VolumeBucketUnit = "hour" | "day";

export interface VolumeSeriesOptions extends CaptureCompletenessOptions {
  bucket: VolumeBucketUnit;
}

export interface VolumeBucket {
  /** UTC ISO string representing the start of the bucket (e.g. "2026-10-20T16:00:00.000Z" or "2026-10-20T00:00:00.000Z"). */
  timestamp: string;
  /** Unix timestamp in seconds for the start of the bucket. */
  startAt: number;
  /** Cumulative challenge stakes within the bucket formatted as bigint string. */
  challengeStakeTotal: string;
  /** Cumulative squad deposits within the bucket formatted as bigint string. */
  squadDepositTotal: string;
  /** Cumulative challenge stakes as bigint. */
  challengeStake: bigint;
  /** Cumulative squad deposits as bigint. */
  squadDeposit: bigint;
  /** Number of challenge events contributing to this bucket. */
  challengeCount: number;
  /** Number of squad deposit events contributing to this bucket. */
  depositCount: number;
  /** Total events aggregated into this bucket. */
  eventCount: number;
}

export interface VolumeSeriesResult {
  /** Contiguous time buckets (zero-filled) between earliest and latest event, or empty if no valid events. */
  buckets: VolumeBucket[];
  /** Total challenge stake across all buckets in this captured series as bigint string. */
  totalChallengeStake: string;
  /** Total squad deposit across all buckets in this captured series as bigint string. */
  totalSquadDeposit: string;
  /** Count of events skipped due to missing or invalid `at` timestamp. */
  skippedWithoutAt: number;
  /** Total valid events processed. */
  processedEvents: number;
  /** Capture completeness metadata including ledger range and gap information. */
  completeness: CaptureCompleteness;
  /** Alias for completeness metadata. */
  capture: CaptureCompleteness;
  /**
   * Verified global market totals across the entire market lifetime.
   * Only populated when `completeness.isComplete` is true.
   * `null` for partial captures to prevent partial captures from being presented as global market totals.
   */
  globalMarketTotals: {
    totalChallengeStake: string;
    totalSquadDeposit: string;
  } | null;
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

/**
 * Floor unix timestamp in seconds to the start of the UTC bucket.
 */
export function floorToBucketUtc(unixSeconds: number, bucket: VolumeBucketUnit): number {
  if (bucket === "hour") {
    return Math.floor(unixSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  }
  return Math.floor(unixSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/**
 * Produce time-bucketed volume series for stakes and deposits.
 *
 * Empty buckets between earliest and latest events are filled with zero values.
 * Events without a valid `at` timestamp are skipped and counted in `skippedWithoutAt`.
 * Annotates results with capture completeness metadata (ledger range and gaps).
 * Partial captures keep `globalMarketTotals: null` to prevent presenting partial captures
 * as global market totals.
 */
export function volumeSeries(
  events: readonly DecodedEvent[] | null | undefined,
  options: VolumeSeriesOptions,
): VolumeSeriesResult {
  const bucketUnit = options?.bucket;
  if (bucketUnit !== "hour" && bucketUnit !== "day") {
    throw new Error(`Invalid bucket unit: expected "hour" or "day", got ${String(bucketUnit)}`);
  }

  // Derive capture completeness metadata (and enforce requireComplete if requested)
  const completeness = computeCaptureCompleteness(events, options);

  const stepSeconds = bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;

  let skippedWithoutAt = 0;
  let processedEvents = 0;

  if (!events || !Array.isArray(events)) {
    return {
      buckets: [],
      totalChallengeStake: "0",
      totalSquadDeposit: "0",
      skippedWithoutAt: 0,
      processedEvents: 0,
      completeness,
      capture: completeness,
      globalMarketTotals: completeness.isComplete
        ? { totalChallengeStake: "0", totalSquadDeposit: "0" }
        : null,
    };
  }

  interface IntermediateBucket {
    startAt: number;
    challengeStake: bigint;
    squadDeposit: bigint;
    challengeCount: number;
    depositCount: number;
    eventCount: number;
  }

  const bucketMap = new Map<number, IntermediateBucket>();

  let minBucketStart: number | null = null;
  let maxBucketStart: number | null = null;
  let totalChallengeStakeBigInt = 0n;
  let totalSquadDepositBigInt = 0n;

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    // Events without valid at are skipped and counted
    const at = (event as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      skippedWithoutAt++;
      continue;
    }

    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }

    const payloadName = (payload as { name?: unknown }).name;

    let challengeStakeDelta = 0n;
    let squadDepositDelta = 0n;
    let isChallenge = false;
    let isDeposit = false;

    if (payloadName === "claim_challenged") {
      const stake = (payload as { stake?: unknown }).stake;
      if (typeof stake === "bigint") {
        challengeStakeDelta = stake;
      } else if (typeof stake === "string" || typeof stake === "number") {
        try {
          challengeStakeDelta = BigInt(stake);
        } catch {
          challengeStakeDelta = 0n;
        }
      }
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amount = (payload as { amount?: unknown }).amount;
      if (typeof amount === "bigint") {
        squadDepositDelta = amount;
      } else if (typeof amount === "string" || typeof amount === "number") {
        try {
          squadDepositDelta = BigInt(amount);
        } catch {
          squadDepositDelta = 0n;
        }
      }
      isDeposit = true;
    }

    processedEvents++;

    const bucketStart = floorToBucketUtc(Math.floor(at), bucketUnit);

    if (minBucketStart === null || bucketStart < minBucketStart) {
      minBucketStart = bucketStart;
    }
    if (maxBucketStart === null || bucketStart > maxBucketStart) {
      maxBucketStart = bucketStart;
    }

    totalChallengeStakeBigInt += challengeStakeDelta;
    totalSquadDepositBigInt += squadDepositDelta;

    let existing = bucketMap.get(bucketStart);
    if (!existing) {
      existing = {
        startAt: bucketStart,
        challengeStake: 0n,
        squadDeposit: 0n,
        challengeCount: 0,
        depositCount: 0,
        eventCount: 0,
      };
      bucketMap.set(bucketStart, existing);
    }

    existing.challengeStake += challengeStakeDelta;
    existing.squadDeposit += squadDepositDelta;
    if (isChallenge) existing.challengeCount++;
    if (isDeposit) existing.depositCount++;
    existing.eventCount++;
  }

  if (minBucketStart === null || maxBucketStart === null) {
    return {
      buckets: [],
      totalChallengeStake: "0",
      totalSquadDeposit: "0",
      skippedWithoutAt,
      processedEvents,
      completeness,
      capture: completeness,
      globalMarketTotals: completeness.isComplete
        ? { totalChallengeStake: "0", totalSquadDeposit: "0" }
        : null,
    };
  }

  // Generate contiguous buckets from minBucketStart to maxBucketStart (zero-filled)
  const buckets: VolumeBucket[] = [];

  for (let t = minBucketStart; t <= maxBucketStart; t += stepSeconds) {
    const data = bucketMap.get(t);
    const challengeStake = data ? data.challengeStake : 0n;
    const squadDeposit = data ? data.squadDeposit : 0n;
    const challengeCount = data ? data.challengeCount : 0;
    const depositCount = data ? data.depositCount : 0;
    const eventCount = data ? data.eventCount : 0;

    buckets.push({
      timestamp: new Date(t * 1000).toISOString(),
      startAt: t,
      challengeStakeTotal: challengeStake.toString(),
      squadDepositTotal: squadDeposit.toString(),
      challengeStake,
      squadDeposit,
      challengeCount,
      depositCount,
      eventCount,
    });
  }

  const totalChallengeStakeStr = totalChallengeStakeBigInt.toString();
  const totalSquadDepositStr = totalSquadDepositBigInt.toString();

  return {
    buckets,
    totalChallengeStake: totalChallengeStakeStr,
    totalSquadDeposit: totalSquadDepositStr,
    skippedWithoutAt,
    processedEvents,
    completeness,
    capture: completeness,
    globalMarketTotals: completeness.isComplete
      ? {
          totalChallengeStake: totalChallengeStakeStr,
          totalSquadDeposit: totalSquadDepositStr,
        }
      : null,
  };
}
