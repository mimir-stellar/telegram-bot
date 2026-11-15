import type { DecodedEvent } from "./decode.js";
import {
  assertGlobalCapture,
  evaluateCaptureCompleteness,
  formatCaptureBanner,
  type CaptureCompletenessMetadata,
  type CaptureContextInput,
} from "./capture-completeness.js";

export type VolumeBucketUnit = "hour" | "day";

export interface VolumeSeriesOptions {
  bucket: VolumeBucketUnit;
  capture?: CaptureContextInput;
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
  /** Total challenge stake across all buckets as bigint string. */
  totalChallengeStake: string;
  /** Total squad deposit across all buckets as bigint string. */
  totalSquadDeposit: string;
  /** Count of events skipped due to missing or invalid `at` timestamp. */
  skippedWithoutAt: number;
  /** Total valid events processed. */
  processedEvents: number;
  /** Ledger range, gap, and global-vs-partial completeness metadata for this series. */
  capture?: CaptureCompletenessMetadata;
}

export interface AnnotatedVolumeSeriesResult extends VolumeSeriesResult {
  capture: CaptureCompletenessMetadata;
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
 */
export function volumeSeries(
  events: readonly DecodedEvent[] | null | undefined,
  options: VolumeSeriesOptions,
): VolumeSeriesResult {
  const bucketUnit = options?.bucket;
  if (bucketUnit !== "hour" && bucketUnit !== "day") {
    throw new Error(`Invalid bucket unit: expected "hour" or "day", got ${String(bucketUnit)}`);
  }

  const stepSeconds = bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;

  let skippedWithoutAt = 0;
  let processedEvents = 0;

  if (!events || !Array.isArray(events)) {
    const captureMeta = evaluateCaptureCompleteness(events, options?.capture, {
      skippedWithoutAt: 0,
      hasAnyEvents: false,
    });
    const emptyResult: VolumeSeriesResult = {
      buckets: [],
      totalChallengeStake: "0",
      totalSquadDeposit: "0",
      skippedWithoutAt: 0,
      processedEvents: 0,
    };
    if (options?.capture !== undefined) {
      emptyResult.capture = captureMeta;
    } else {
      Object.defineProperty(emptyResult, "capture", {
        value: captureMeta,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return emptyResult;
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
    const captureMeta = evaluateCaptureCompleteness(events, options?.capture, {
      skippedWithoutAt,
      hasAnyEvents: events.length > 0,
    });
    const emptyBucketsResult: VolumeSeriesResult = {
      buckets: [],
      totalChallengeStake: "0",
      totalSquadDeposit: "0",
      skippedWithoutAt,
      processedEvents,
    };
    if (options?.capture !== undefined || skippedWithoutAt > 0 || processedEvents > 0) {
      emptyBucketsResult.capture = captureMeta;
    } else {
      Object.defineProperty(emptyBucketsResult, "capture", {
        value: captureMeta,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return emptyBucketsResult;
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

  const captureMeta = evaluateCaptureCompleteness(events, options?.capture, {
    skippedWithoutAt,
    hasAnyEvents: true,
  });

  return {
    buckets,
    totalChallengeStake: totalChallengeStakeBigInt.toString(),
    totalSquadDeposit: totalSquadDepositBigInt.toString(),
    skippedWithoutAt,
    processedEvents,
    capture: captureMeta,
  };
}

/**
 * Produce a volume series with `capture` completeness metadata always attached
 * as an enumerable field, including on empty inputs.
 */
export function annotatedVolumeSeries(
  events: readonly DecodedEvent[] | null | undefined,
  options: VolumeSeriesOptions,
): AnnotatedVolumeSeriesResult {
  const res = volumeSeries(events, {
    ...options,
    capture: options.capture ?? {},
  });
  return res as AnnotatedVolumeSeriesResult;
}

/**
 * Render a human-readable volume summary that labels partial/windowed captures
 * explicitly and refuses `requireGlobalTotal: true` unless the capture is complete
 * from contract genesis.
 */
export function formatVolumeCaptureSummary(
  result: VolumeSeriesResult,
  options: { requireGlobalTotal?: boolean } = {},
): string {
  const capture =
    result.capture ??
    evaluateCaptureCompleteness([], undefined, {
      skippedWithoutAt: result.skippedWithoutAt,
      hasAnyEvents: result.processedEvents > 0,
    });

  if (options.requireGlobalTotal) {
    assertGlobalCapture(capture, "volume series");
  }

  const prefix = capture.isGlobalTotal ? "global_total" : "observed_capture_total";
  return [
    formatCaptureBanner(capture),
    `${prefix}_challenge_stake=${result.totalChallengeStake} ${prefix}_squad_deposit=${result.totalSquadDeposit} buckets=${result.buckets.length}`,
  ].join("\n");
}

export {
  PartialCaptureError,
  assertGlobalCapture,
  evaluateCaptureCompleteness,
  formatCaptureBanner,
  observeEventLedgerBounds,
  type CaptureCompletenessMetadata,
  type CaptureCompletenessStatus,
  type CaptureContextInput,
  type CaptureGapInput,
  type CaptureGapReason,
  type CaptureIncompletenessReason,
  type CaptureLedgerGap,
  type CaptureLedgerRange,
  type CaptureScopeLabel,
} from "./capture-completeness.js";
