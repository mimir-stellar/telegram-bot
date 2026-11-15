import { USDC_UNIT, formatUsdc, type DecodedEvent } from "./decode.js";

export type VolumeBucketUnit = "hour" | "day";

export const USDC_ATOMIC_DECIMALS = 7;

export interface VolumeSeriesOptions {
  bucket: VolumeBucketUnit;
  /**
   * When true, non-integer, negative, or unsafe-number (`> Number.MAX_SAFE_INTEGER`)
   * stake/deposit values throw a `RangeError` rather than being ignored as `0n`.
   */
  strictAmounts?: boolean;
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
}

export interface ExportVolumeOptions {
  /** Include 7-decimal formatted USDC strings alongside integer atomic strings. Defaults to true. */
  includeDecimalDisplay?: boolean;
}

export interface ExportedVolumeBucket {
  timestamp: string;
  startAt: number;
  /** Integer atomic USDC units (1 USDC = 10_000_000) as base-10 integer string. */
  challengeStakeAtomic: string;
  /** Integer atomic USDC units (1 USDC = 10_000_000) as base-10 integer string. */
  squadDepositAtomic: string;
  /** Combined challenge + squad volume in integer atomic USDC units. */
  totalVolumeAtomic: string;
  /** Optional 7-decimal USDC string formatted purely via integer division at the export boundary. */
  challengeStakeUsdc?: string;
  /** Optional 7-decimal USDC string formatted purely via integer division at the export boundary. */
  squadDepositUsdc?: string;
  /** Optional 7-decimal combined USDC string formatted at the export boundary. */
  totalVolumeUsdc?: string;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

export interface ExportedVolumeTotals {
  challengeStakeAtomic: string;
  squadDepositAtomic: string;
  totalVolumeAtomic: string;
  challengeStakeUsdc?: string;
  squadDepositUsdc?: string;
  totalVolumeUsdc?: string;
}

export interface ExportedVolumeSeries {
  bucketUnit?: VolumeBucketUnit;
  usdcDecimals: typeof USDC_ATOMIC_DECIMALS;
  usdcAtomicUnit: string;
  buckets: ExportedVolumeBucket[];
  totals: ExportedVolumeTotals;
  skippedWithoutAt: number;
  processedEvents: number;
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

/**
 * Parse an atomic USDC integer amount strictly without floating-point conversion.
 *
 * Accepts non-negative `bigint`, safe integer `number`, or base-10 integer `string`.
 * Rejects floats (`12.34`), unsafe JS numbers (`> Number.MAX_SAFE_INTEGER`),
 * decimal strings (`"12.3400000"`), negative amounts, and empty strings.
 */
export function parseAtomicUsdc(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`Atomic USDC amount must be non-negative, got ${value.toString()}`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `Atomic USDC number must be a non-negative safe integer, got ${String(value)}`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new RangeError(
        `Atomic USDC string must be a base-10 non-negative integer, got "${value}"`,
      );
    }
    return BigInt(trimmed);
  }
  throw new RangeError(`Unsupported atomic USDC value type: ${typeof value}`);
}

function resolveAtomicDelta(value: unknown, strict: boolean): bigint {
  if (value === undefined || value === null) {
    if (strict) {
      throw new RangeError("Missing atomic USDC amount");
    }
    return 0n;
  }
  try {
    return parseAtomicUsdc(value);
  } catch (err) {
    if (strict) {
      throw err;
    }
    return 0n;
  }
}

/**
 * Format an integer atomic USDC amount into a 7-decimal string at the export
 * boundary using integer quotient/remainder arithmetic only (never IEEE-754 float).
 */
export function formatAtomicUsdcBoundary(atomicUnits: bigint | string): string {
  const units = typeof atomicUnits === "bigint" ? parseAtomicUsdc(atomicUnits) : parseAtomicUsdc(atomicUnits);
  return formatUsdc(units);
}

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
 * All accumulation uses exact integer `bigint` atomic USDC units (`10_000_000`
 * units per 1 USDC) — floating-point numbers and unsafe JS integers are never
 * accumulated. Empty buckets between earliest and latest events are filled with
 * zero values. Events without a valid `at` timestamp are skipped and counted in
 * `skippedWithoutAt`.
 */
export function volumeSeries(
  events: readonly DecodedEvent[] | null | undefined,
  options: VolumeSeriesOptions,
): VolumeSeriesResult {
  const bucketUnit = options?.bucket;
  if (bucketUnit !== "hour" && bucketUnit !== "day") {
    throw new Error(`Invalid bucket unit: expected "hour" or "day", got ${String(bucketUnit)}`);
  }
  const strictAmounts = options?.strictAmounts === true;

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
      challengeStakeDelta = resolveAtomicDelta(stake, strictAmounts);
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amount = (payload as { amount?: unknown }).amount;
      squadDepositDelta = resolveAtomicDelta(amount, strictAmounts);
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

  return {
    buckets,
    totalChallengeStake: totalChallengeStakeBigInt.toString(),
    totalSquadDeposit: totalSquadDepositBigInt.toString(),
    skippedWithoutAt,
    processedEvents,
  };
}

/**
 * Convert a single `VolumeBucket` into a JSON-ready `ExportedVolumeBucket`
 * preserving exact integer atomic USDC strings and applying 7-decimal formatting
 * strictly at the export boundary.
 */
export function exportVolumeBucket(
  bucket: VolumeBucket,
  options: ExportVolumeOptions = {},
): ExportedVolumeBucket {
  const includeDecimalDisplay = options.includeDecimalDisplay ?? true;
  const challengeAtomic = parseAtomicUsdc(bucket.challengeStake ?? bucket.challengeStakeTotal);
  const depositAtomic = parseAtomicUsdc(bucket.squadDeposit ?? bucket.squadDepositTotal);
  const totalAtomic = challengeAtomic + depositAtomic;

  return {
    timestamp: bucket.timestamp,
    startAt: bucket.startAt,
    challengeStakeAtomic: challengeAtomic.toString(),
    squadDepositAtomic: depositAtomic.toString(),
    totalVolumeAtomic: totalAtomic.toString(),
    ...(includeDecimalDisplay
      ? {
          challengeStakeUsdc: formatUsdc(challengeAtomic),
          squadDepositUsdc: formatUsdc(depositAtomic),
          totalVolumeUsdc: formatUsdc(totalAtomic),
        }
      : {}),
    challengeCount: bucket.challengeCount,
    depositCount: bucket.depositCount,
    eventCount: bucket.eventCount,
  };
}

/**
 * Export a `VolumeSeriesResult` into a JSON-safe boundary structure carrying
 * integer atomic USDC strings throughout all buckets/totals and optional
 * integer-derived 7-decimal USDC display strings.
 */
export function exportVolumeSeries(
  series: VolumeSeriesResult,
  options: ExportVolumeOptions & { bucketUnit?: VolumeBucketUnit } = {},
): ExportedVolumeSeries {
  const includeDecimalDisplay = options.includeDecimalDisplay ?? true;
  const totalChallengeAtomic = parseAtomicUsdc(series.totalChallengeStake);
  const totalDepositAtomic = parseAtomicUsdc(series.totalSquadDeposit);
  const combinedTotalAtomic = totalChallengeAtomic + totalDepositAtomic;

  return {
    ...(options.bucketUnit !== undefined ? { bucketUnit: options.bucketUnit } : {}),
    usdcDecimals: USDC_ATOMIC_DECIMALS,
    usdcAtomicUnit: USDC_UNIT.toString(),
    buckets: series.buckets.map((b) => exportVolumeBucket(b, { includeDecimalDisplay })),
    totals: {
      challengeStakeAtomic: totalChallengeAtomic.toString(),
      squadDepositAtomic: totalDepositAtomic.toString(),
      totalVolumeAtomic: combinedTotalAtomic.toString(),
      ...(includeDecimalDisplay
        ? {
            challengeStakeUsdc: formatUsdc(totalChallengeAtomic),
            squadDepositUsdc: formatUsdc(totalDepositAtomic),
            totalVolumeUsdc: formatUsdc(combinedTotalAtomic),
          }
        : {}),
    },
    skippedWithoutAt: series.skippedWithoutAt,
    processedEvents: series.processedEvents,
  };
}

/**
 * Serialize a `VolumeSeriesResult` directly to deterministic JSON without raw
 * `bigint` serialization errors or floating-point rounding.
 */
export function serializeVolumeSeriesJson(
  series: VolumeSeriesResult,
  options: ExportVolumeOptions & { bucketUnit?: VolumeBucketUnit } = {},
): string {
  return `${JSON.stringify(exportVolumeSeries(series, options), null, 2)}\n`;
}

/**
 * Render a deterministic CSV export of volume buckets keeping integer atomic
 * columns alongside boundary-formatted 7-decimal USDC columns.
 */
export function formatVolumeSeriesCsv(
  series: VolumeSeriesResult,
  options: ExportVolumeOptions = {},
): string {
  const exported = exportVolumeSeries(series, options);
  const includeDecimalDisplay = options.includeDecimalDisplay ?? true;

  const header = includeDecimalDisplay
    ? "timestamp,start_at,challenge_stake_atomic,squad_deposit_atomic,total_volume_atomic,challenge_stake_usdc,squad_deposit_usdc,total_volume_usdc,challenge_count,deposit_count,event_count"
    : "timestamp,start_at,challenge_stake_atomic,squad_deposit_atomic,total_volume_atomic,challenge_count,deposit_count,event_count";

  const rows = [header];
  for (const b of exported.buckets) {
    if (includeDecimalDisplay) {
      rows.push(
        [
          b.timestamp,
          b.startAt,
          b.challengeStakeAtomic,
          b.squadDepositAtomic,
          b.totalVolumeAtomic,
          b.challengeStakeUsdc ?? "0.0000000",
          b.squadDepositUsdc ?? "0.0000000",
          b.totalVolumeUsdc ?? "0.0000000",
          b.challengeCount,
          b.depositCount,
          b.eventCount,
        ].join(","),
      );
    } else {
      rows.push(
        [
          b.timestamp,
          b.startAt,
          b.challengeStakeAtomic,
          b.squadDepositAtomic,
          b.totalVolumeAtomic,
          b.challengeCount,
          b.depositCount,
          b.eventCount,
        ].join(","),
      );
    }
  }

  return `${rows.join("\n")}\n`;
}
