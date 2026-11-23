import type { DecodedEvent } from "./decode.js";
import { resolutionLatency, type LatencyGroup } from "./resolution-latency.js";
import { volumeSeries, type VolumeBucketUnit } from "./volume-series.js";

/**
 * Stable, versioned JSON export of the analytical summaries (volume series and
 * resolution latency) derived from observed chain events.
 *
 * The contract is `docs/schemas/analytics-summary.schema.json`. Within one
 * `schemaVersion`, fields are only ever added; removing or retyping a field
 * needs a new version. The export is a pure function of its input events: it
 * carries no wall-clock time, host name or random id, and its key order is
 * fixed, so the same archived events always serialize to the same bytes.
 */

export const ANALYTICS_SUMMARY_SCHEMA = "mimir.analytics-summary";
export const ANALYTICS_SUMMARY_SCHEMA_VERSION = 1;

export interface AnalyticsSummaryOptions {
  /** Width of each volume bucket, aligned to UTC. */
  bucket: VolumeBucketUnit;
}

export interface AnalyticsTimeBounds {
  /** Earliest event `at` in the input, unix seconds. */
  firstAt: number;
  /** Latest event `at` in the input, unix seconds. */
  lastAt: number;
  firstAtIso: string;
  lastAtIso: string;
}

export interface AnalyticsLedgerBounds {
  firstLedger: number;
  lastLedger: number;
}

export interface AnalyticsVolumeBucket {
  /** Bucket start, unix seconds (inclusive). */
  startAt: number;
  startAtIso: string;
  /** Sum of `claim_challenged` stakes, base units as a decimal string. */
  challengeStake: string;
  /** Sum of squad `deposited` amounts, base units as a decimal string. */
  squadDeposit: string;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

export interface AnalyticsLatencyStats {
  seconds: number;
  ledgers: number;
}

export interface AnalyticsLatencyGroup {
  count: number;
  /** Null when the group has no paired claims. */
  p50: AnalyticsLatencyStats | null;
  p90: AnalyticsLatencyStats | null;
  max: AnalyticsLatencyStats | null;
}

export interface AnalyticsSummary {
  schema: typeof ANALYTICS_SUMMARY_SCHEMA;
  schemaVersion: typeof ANALYTICS_SUMMARY_SCHEMA_VERSION;
  units: {
    /** Token amounts: integer base units of the contract token, as decimal strings. */
    amount: "base_units";
    /** Every timestamp field is unix seconds, UTC. */
    timestamp: "unix_seconds";
    /** Latency durations are given in both units. */
    duration: ["seconds", "ledgers"];
    /** Volume bucket width. */
    bucket: VolumeBucketUnit;
    /** How p50/p90 are computed. */
    percentile: "nearest_rank";
  };
  input: {
    /** Records offered to the export, valid or not. */
    records: number;
    /** Records that were not decoded events (null, non-object, no payload). */
    malformed: number;
    /** Records whose `at` or `ledger` is missing, negative or not finite. */
    missingTime: number;
    /** Time and ledger range covered by the usable events; null when there are none. */
    timeBounds: AnalyticsTimeBounds | null;
    ledgerBounds: AnalyticsLedgerBounds | null;
  };
  volume: {
    /** Bucket range, null when no event fell in a bucket. `endAt` is exclusive. */
    bounds: { startAt: number; endAt: number; bucketCount: number } | null;
    totals: { challengeStake: string; squadDeposit: string };
    buckets: AnalyticsVolumeBucket[];
    completeness: {
      processedEvents: number;
      skippedWithoutAt: number;
      /** True when every usable record landed in a bucket. */
      complete: boolean;
    };
  };
  latency: {
    resolved: AnalyticsLatencyGroup;
    cancelled: AnalyticsLatencyGroup;
    completeness: {
      /** Claims with both a creation and an end event. */
      pairedClaims: number;
      /** Claims seen without a creation or without an end event. */
      excludedClaims: number;
      /** True when every claim seen was paired. Open claims make this false. */
      complete: boolean;
    };
  };
  /** True when both the volume and the latency summaries are complete and no record was malformed. */
  complete: boolean;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function latencyGroup(group: LatencyGroup): AnalyticsLatencyGroup {
  const summary = group.summary;
  return {
    count: group.claims.length,
    p50: summary ? { seconds: summary.p50.seconds, ledgers: summary.p50.ledgers } : null,
    p90: summary ? { seconds: summary.p90.seconds, ledgers: summary.p90.ledgers } : null,
    max: summary ? { seconds: summary.max.seconds, ledgers: summary.max.ledgers } : null,
  };
}

/**
 * Build the versioned analytics summary for a set of decoded events, such as
 * the contents of an event archive. Input order does not affect the result.
 */
export function buildAnalyticsSummary(
  events: readonly unknown[] | null | undefined,
  options: AnalyticsSummaryOptions,
): AnalyticsSummary {
  const bucket = options?.bucket;
  if (bucket !== "hour" && bucket !== "day") {
    throw new Error(`Invalid bucket unit: expected "hour" or "day", got ${String(bucket)}`);
  }

  const records = Array.isArray(events) ? events : [];
  let malformed = 0;
  let missingTime = 0;
  const usable: DecodedEvent[] = [];
  let firstAt = Infinity;
  let lastAt = -Infinity;
  let firstLedger = Infinity;
  let lastLedger = -Infinity;

  for (const record of records) {
    if (!record || typeof record !== "object") {
      malformed++;
      continue;
    }
    const payload = (record as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      malformed++;
      continue;
    }
    const { at, ledger } = record as { at?: unknown; ledger?: unknown };
    if (!isFiniteNonNegative(at) || !isFiniteNonNegative(ledger)) {
      missingTime++;
      continue;
    }
    const atSeconds = Math.trunc(at);
    const ledgerSeq = Math.trunc(ledger);
    firstAt = Math.min(firstAt, atSeconds);
    lastAt = Math.max(lastAt, atSeconds);
    firstLedger = Math.min(firstLedger, ledgerSeq);
    lastLedger = Math.max(lastLedger, ledgerSeq);
    usable.push(record as DecodedEvent);
  }

  const volume = volumeSeries(usable, { bucket });
  const latency = resolutionLatency(usable);

  const buckets: AnalyticsVolumeBucket[] = volume.buckets.map((b) => ({
    startAt: b.startAt,
    startAtIso: b.timestamp,
    challengeStake: b.challengeStakeTotal,
    squadDeposit: b.squadDepositTotal,
    challengeCount: b.challengeCount,
    depositCount: b.depositCount,
    eventCount: b.eventCount,
  }));
  const step = bucket === "hour" ? 3600 : 86400;
  const firstBucket = buckets[0];
  const lastBucket = buckets[buckets.length - 1];

  const volumeComplete = volume.skippedWithoutAt === 0 && volume.processedEvents === usable.length;
  const pairedClaims = latency.resolved.claims.length + latency.cancelled.claims.length;
  const latencyComplete = latency.excludedCount === 0;

  return {
    schema: ANALYTICS_SUMMARY_SCHEMA,
    schemaVersion: ANALYTICS_SUMMARY_SCHEMA_VERSION,
    units: {
      amount: "base_units",
      timestamp: "unix_seconds",
      duration: ["seconds", "ledgers"],
      bucket,
      percentile: "nearest_rank",
    },
    input: {
      records: records.length,
      malformed,
      missingTime,
      timeBounds:
        usable.length > 0
          ? { firstAt, lastAt, firstAtIso: toIso(firstAt), lastAtIso: toIso(lastAt) }
          : null,
      ledgerBounds: usable.length > 0 ? { firstLedger, lastLedger } : null,
    },
    volume: {
      bounds:
        firstBucket && lastBucket
          ? { startAt: firstBucket.startAt, endAt: lastBucket.startAt + step, bucketCount: buckets.length }
          : null,
      totals: { challengeStake: volume.totalChallengeStake, squadDeposit: volume.totalSquadDeposit },
      buckets,
      completeness: {
        processedEvents: volume.processedEvents,
        skippedWithoutAt: volume.skippedWithoutAt,
        complete: volumeComplete,
      },
    },
    latency: {
      resolved: latencyGroup(latency.resolved),
      cancelled: latencyGroup(latency.cancelled),
      completeness: {
        pairedClaims,
        excludedClaims: latency.excludedCount,
        complete: latencyComplete,
      },
    },
    complete: malformed === 0 && missingTime === 0 && volumeComplete && latencyComplete,
  };
}

/**
 * Serialize a summary as canonical JSON: two-space indent, fixed key order and
 * a trailing newline. Identical input events give byte-identical output.
 */
export function serializeAnalyticsSummary(summary: AnalyticsSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
