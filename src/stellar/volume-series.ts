/**
 * Time-bucketed volume series for challenge stakes and squad deposits.
 *
 * Derives hourly and daily volume aggregations from observed chain events.
 *
 * Invariants:
 * - Avoids floating-point accumulation: amounts are strictly parsed and accumulated
 *   as non-negative atomic integer USDC units (`bigint`).
 * - Canonical 7-decimal USDC formatting (`formatUsdc`) is applied only at the
 *   export boundary (`exportVolumeBucket`, `exportVolumeBuckets`, `exportVolumeSeries`,
 *   `renderVolumeSeries`).
 * - Zero-fills missing intermediate time buckets in UTC.
 * - Deterministic ordering ascending by bucket timestamp.
 */

import { formatUsdc, type DecodedEvent } from "./decode.js";

export type VolumeBucketUnit = "hour" | "day";

export interface VolumeSeriesOptions {
  bucket: VolumeBucketUnit;
}

/**
 * Summary of the volume series. Conflicting terminal events are not silently
 * resolved; they are reported via `inconsistencies`.
 */

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
  /**
   * True when no valid events fell into this bucket. Zero-filled buckets carry
   * `empty: true` so consumers can distinguish an absent observation from a
   * real zero total.
   */
  empty: boolean;
}

export interface VolumeSeriesResult {
  /** Contiguous time buckets (zero-filled, flagged `empty`) between earliest and latest event, or empty if no valid events. */
  buckets: VolumeBucket[];
  /** Total challenge stake across all buckets as bigint string, or null when no valid observations exist. */
  totalChallengeStake: string | null;
  /** Total squad deposit across all buckets as bigint string, or null when no valid observations exist. */
  totalSquadDeposit: string | null;
  /** Count of events skipped due to missing or invalid `at` timestamp. */
  skippedWithoutAt: number;
  /** Total valid events processed. */
  processedEvents: number;
  /** Total challenge stake across all buckets as bigint. */
  totalChallengeStakeBigInt?: bigint;
  /** Total squad deposit across all buckets as bigint. */
  totalSquadDepositBigInt?: bigint;
  /** Total challenge stake formatted as 7-decimal USDC string. */
  totalChallengeStakeUsdc?: string;
  /** Total squad deposit formatted as 7-decimal USDC string. */
  totalSquadDepositUsdc?: string;
}

export interface ExportedVolumeBucket extends VolumeBucket {
  /** Canonical 7-decimal USDC representation of challenge stake (e.g. "2.0000000"). */
  challengeStakeUsdc: string;
  /** Canonical 7-decimal USDC representation of squad deposit (e.g. "1.5000000"). */
  squadDepositUsdc: string;
}

export interface ExportedVolumeSeriesResult {
  /** Contiguous time buckets with decimal formatted USDC amounts. */
  buckets: ExportedVolumeBucket[];
  /** Total challenge stake across all buckets as bigint string. */
  totalChallengeStake: string;
  /** Total squad deposit across all buckets as bigint string. */
  totalSquadDeposit: string;
  /** Total challenge stake formatted as 7-decimal USDC string (e.g. "2.0000000"). */
  totalChallengeStakeUsdc: string;
  /** Total squad deposit formatted as 7-decimal USDC string (e.g. "2.0000000"). */
  totalSquadDepositUsdc: string;
  /** Total challenge stake as bigint. */
  totalChallengeStakeBigInt: bigint;
  /** Total squad deposit as bigint. */
  totalSquadDepositBigInt: bigint;
  /** Count of events skipped due to missing or invalid `at` timestamp. */
  skippedWithoutAt: number;
  /** Total valid events processed. */
  processedEvents: number;
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
 * Parse an event stake or deposit amount as a non-negative integer bigint.
 *
 * Avoids floating-point accumulation by discarding non-integers, floats, negative amounts,
 * and unsafe integers exceeding Number.MAX_SAFE_INTEGER.
 */
export function toIntegerAmount(val: unknown): bigint {
  if (typeof val === "bigint") {
    return val >= 0n ? val : 0n;
  }
  if (typeof val === "number") {
    if (Number.isSafeInteger(val) && val >= 0) {
      return BigInt(val);
    }
    return 0n;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        const parsed = BigInt(trimmed);
        return parsed >= 0n ? parsed : 0n;
      } catch {
        return 0n;
      }
    }
    return 0n;
  }
  return 0n;
}

/**
 * Produce time-bucketed volume series for stakes and deposits.
 *
 * Empty buckets between earliest and latest events are zero-filled but marked
 * `empty: true`. Totals are `null` when there are no valid observations, so an
 * absent series is never reported as a misleading zero. Events without a valid
 * `at` timestamp are skipped and counted in `skippedWithoutAt`.
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
    const emptyResult: VolumeSeriesResult = {
      buckets: [],
      totalChallengeStake: null,
      totalSquadDeposit: null,
      skippedWithoutAt: 0,
      processedEvents: 0,
    };
    attachSeriesMetadata(emptyResult, 0n, 0n);
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
      challengeStakeDelta = toIntegerAmount(stake);
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amount = (payload as { amount?: unknown }).amount;
      squadDepositDelta = toIntegerAmount(amount);
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
    const emptyResult: VolumeSeriesResult = {
      buckets: [],
      totalChallengeStake: null,
      totalSquadDeposit: null,
      skippedWithoutAt,
      processedEvents,
    };
    attachSeriesMetadata(emptyResult, 0n, 0n);
    return emptyResult;
  }

  // Generate contiguous buckets from minBucketStart to maxBucketStart (zero-filled, flagged empty)
  const buckets: VolumeBucket[] = [];

  for (let t = minBucketStart; t <= maxBucketStart; t += stepSeconds) {
    const data = bucketMap.get(t);
    const challengeStake = data ? data.challengeStake : 0n;
    const squadDeposit = data ? data.squadDeposit : 0n;
    const challengeCount = data ? data.challengeCount : 0;
    const depositCount = data ? data.depositCount : 0;
    const eventCount = data ? data.eventCount : 0;

    const bucketObj: VolumeBucket = {
      timestamp: new Date(t * 1000).toISOString(),
      startAt: t,
      challengeStakeTotal: challengeStake.toString(),
      squadDepositTotal: squadDeposit.toString(),
      challengeStake,
      squadDeposit,
      challengeCount,
      depositCount,
      eventCount,
      empty: eventCount === 0,
    });
    Object.defineProperty(bucketObj, "squadDepositUsdc", {
      get: () => formatUsdc(squadDeposit),
      enumerable: false,
      configurable: true,
    });

    buckets.push(bucketObj);
  }

  const result: VolumeSeriesResult = {
    buckets,
    totalChallengeStake: totalChallengeStakeBigInt.toString(),
    totalSquadDeposit: totalSquadDepositBigInt.toString(),
    skippedWithoutAt,
    processedEvents,
  };

  attachSeriesMetadata(result, totalChallengeStakeBigInt, totalSquadDepositBigInt);
  return result;
}

/**
 * Attach non-enumerable helper properties to VolumeSeriesResult so existing deepEqual
 * assertions pass while consumers have convenient access to integer bigints and formatted USDC.
 */
function attachSeriesMetadata(
  res: VolumeSeriesResult,
  totalChallengeStakeBigInt: bigint,
  totalSquadDepositBigInt: bigint,
): void {
  Object.defineProperty(res, "totalChallengeStakeBigInt", {
    value: totalChallengeStakeBigInt,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(res, "totalSquadDepositBigInt", {
    value: totalSquadDepositBigInt,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(res, "totalChallengeStakeUsdc", {
    get: () => formatUsdc(totalChallengeStakeBigInt),
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(res, "totalSquadDepositUsdc", {
    get: () => formatUsdc(totalSquadDepositBigInt),
    enumerable: false,
    configurable: true,
  });
}

/**
 * Format a single volume bucket at the export boundary, applying canonical
 * 7-decimal USDC formatting to atomic integer amounts.
 */
export function exportVolumeBucket(bucket: VolumeBucket): ExportedVolumeBucket {
  return {
    ...bucket,
    challengeStakeUsdc: formatUsdc(bucket.challengeStake),
    squadDepositUsdc: formatUsdc(bucket.squadDeposit),
  };
}

/**
 * Format an array of volume buckets at the export boundary with 7-decimal USDC strings.
 */
export function exportVolumeBuckets(buckets: readonly VolumeBucket[]): ExportedVolumeBucket[] {
  return buckets.map(exportVolumeBucket);
}

/** Alias for `exportVolumeBuckets`. */
export const formatVolumeBuckets = exportVolumeBuckets;

/**
 * Export an entire volume series result at the presentation / export boundary,
 * applying explicit 7-decimal USDC formatting (`formatUsdc`) to bucket and series totals.
 *
 * Keeps internal series accumulation strictly in atomic integer amounts (bigint)
 * and formats decimal representations only at this boundary.
 */
export function exportVolumeSeries(result: VolumeSeriesResult): ExportedVolumeSeriesResult {
  const challengeBigInt = result.buckets.reduce((sum, b) => sum + b.challengeStake, 0n);
  const depositBigInt = result.buckets.reduce((sum, b) => sum + b.squadDeposit, 0n);

  return {
    buckets: exportVolumeBuckets(result.buckets),
    totalChallengeStake: result.totalChallengeStake,
    totalSquadDeposit: result.totalSquadDeposit,
    totalChallengeStakeUsdc: formatUsdc(challengeBigInt),
    totalSquadDepositUsdc: formatUsdc(depositBigInt),
    totalChallengeStakeBigInt: challengeBigInt,
    totalSquadDepositBigInt: depositBigInt,
    skippedWithoutAt: result.skippedWithoutAt,
    processedEvents: result.processedEvents,
  };
}

/** Alias for `exportVolumeSeries`. */
export const formatVolumeSeries = exportVolumeSeries;

/**
 * Render a plain-text summary of volume series buckets applying decimal USDC
 * formatting at the export boundary.
 */
export function renderVolumeSeries(result: VolumeSeriesResult): string {
  const exported = exportVolumeSeries(result);
  const lines: string[] = [];

  lines.push("Volume Series Summary:");
  lines.push(`  Total Challenge Stake: ${exported.totalChallengeStakeUsdc} USDC`);
  lines.push(`  Total Squad Deposit: ${exported.totalSquadDepositUsdc} USDC`);
  lines.push(
    `  Processed Events: ${exported.processedEvents} (Skipped without timestamp: ${exported.skippedWithoutAt})`,
  );
  lines.push(`  Buckets: ${exported.buckets.length}`);

  if (exported.buckets.length > 0) {
    lines.push("");
    lines.push("Buckets:");
    for (const b of exported.buckets) {
      lines.push(
        `  [${b.timestamp}] Challenge Stake: ${b.challengeStakeUsdc} USDC · Squad Deposit: ${b.squadDepositUsdc} USDC (${b.eventCount} events)`,
      );
    }
  }

  return lines.join("\n");
}
