import { eventKey } from "../dedup.js";
import { readArchive } from "./archive.js";
import type { DecodedEvent } from "./decode.js";
import {
  resolutionLatency,
  type ClaimLatency,
  type LatencySummary,
  type ResolutionLatencyReport,
} from "./resolution-latency.js";
import {
  volumeSeries,
  type VolumeBucket,
  type VolumeBucketUnit,
  type VolumeSeriesResult,
} from "./volume-series.js";

export interface LedgerSpan {
  minLedger: number | null;
  maxLedger: number | null;
}

export interface AggregateSnapshot {
  bucketUnit: VolumeBucketUnit;
  eventCount: number;
  ledgerSpan: LedgerSpan;
  bucketLedgerSpans: Record<string, { minLedger: number; maxLedger: number }>;
  volume: VolumeSeriesResult;
  latency: ResolutionLatencyReport;
}

export type ReconciliationStatus =
  | "match"
  | "range_loss"
  | "arithmetic_mismatch"
  | "range_loss_and_arithmetic_mismatch";

export type RangeLossKind =
  | "ledger_head_trimmed"
  | "ledger_tail_trimmed"
  | "volume_bucket_missing"
  | "volume_bucket_trimmed"
  | "volume_bucket_added"
  | "claim_missing"
  | "claim_added";

export interface RangeLossDetail {
  kind: RangeLossKind;
  scope: "ledger" | "volume" | "latency";
  identifier: string;
  beforeValue: string;
  afterValue: string;
}

export type ArithmeticMismatchKind =
  | "bucket_challenge_stake_mismatch"
  | "bucket_squad_deposit_mismatch"
  | "bucket_count_mismatch"
  | "overlap_total_mismatch"
  | "claim_duration_mismatch"
  | "claim_outcome_mismatch"
  | "latency_summary_mismatch";

export interface ArithmeticMismatchDetail {
  kind: ArithmeticMismatchKind;
  scope: "volume" | "latency";
  identifier: string;
  beforeValue: string;
  afterValue: string;
}

export interface AggregateReconciliationReport {
  schemaVersion: 1;
  bucketUnit: VolumeBucketUnit;
  status: ReconciliationStatus;
  ok: boolean;
  hasRangeLoss: boolean;
  hasArithmeticMismatch: boolean;
  ledgerSpan: {
    before: LedgerSpan;
    after: LedgerSpan;
  };
  totals: {
    beforeChallengeStake: string;
    afterChallengeStake: string;
    overlapBeforeChallengeStake: string;
    overlapAfterChallengeStake: string;
    beforeSquadDeposit: string;
    afterSquadDeposit: string;
    overlapBeforeSquadDeposit: string;
    overlapAfterSquadDeposit: string;
    beforeResolvedClaims: number;
    afterResolvedClaims: number;
    beforeCancelledClaims: number;
    afterCancelledClaims: number;
  };
  rangeLosses: RangeLossDetail[];
  arithmeticMismatches: ArithmeticMismatchDetail[];
}

export interface ReconcileOptions {
  bucket?: VolumeBucketUnit;
  /**
   * When true, canonical duplicate events (`eventKey`) are collapsed before
   * computing aggregate snapshots so lossless deduplicating compaction compares
   * unique on-chain events. Defaults to false.
   */
  deduplicate?: boolean;
}

function deduplicateEvents(events: readonly DecodedEvent[]): DecodedEvent[] {
  const seen = new Set<string>();
  const out: DecodedEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const key = eventKey(ev);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(ev);
  }
  return out;
}

function finiteInteger(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return Math.trunc(val);
  }
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) {
    const parsed = Number(val.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

export function computeLedgerSpan(
  events: readonly DecodedEvent[] | null | undefined,
): LedgerSpan {
  if (!events || !Array.isArray(events)) {
    return { minLedger: null, maxLedger: null };
  }
  let minLedger: number | null = null;
  let maxLedger: number | null = null;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const ledger = finiteInteger((ev as { ledger?: unknown }).ledger);
    if (ledger === null || ledger < 0) continue;
    if (minLedger === null || ledger < minLedger) minLedger = ledger;
    if (maxLedger === null || ledger > maxLedger) maxLedger = ledger;
  }
  return { minLedger, maxLedger };
}

function computeBucketLedgerSpans(
  events: readonly DecodedEvent[] | null | undefined,
  bucketUnit: VolumeBucketUnit,
): Record<string, { minLedger: number; maxLedger: number }> {
  const spans = new Map<number, { minLedger: number; maxLedger: number }>();
  if (!events || !Array.isArray(events)) return {};
  const step = bucketUnit === "hour" ? 3600 : 86400;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const at = (ev as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
    const ledger = finiteInteger((ev as { ledger?: unknown }).ledger);
    if (ledger === null || ledger < 0) continue;

    const bucketStart = Math.floor(Math.floor(at) / step) * step;
    const cur = spans.get(bucketStart);
    if (!cur) {
      spans.set(bucketStart, { minLedger: ledger, maxLedger: ledger });
    } else {
      if (ledger < cur.minLedger) cur.minLedger = ledger;
      if (ledger > cur.maxLedger) cur.maxLedger = ledger;
    }
  }

  const ordered: Record<string, { minLedger: number; maxLedger: number }> = {};
  for (const key of [...spans.keys()].sort((a, b) => a - b)) {
    ordered[String(key)] = spans.get(key)!;
  }
  return ordered;
}

export function buildAggregateSnapshot(
  events: readonly DecodedEvent[] | null | undefined,
  options: ReconcileOptions = {},
): AggregateSnapshot {
  const bucketUnit: VolumeBucketUnit = options.bucket ?? "hour";
  const rawEvents = Array.isArray(events) ? events : [];
  const safeEvents = options.deduplicate ? deduplicateEvents(rawEvents) : rawEvents;
  return {
    bucketUnit,
    eventCount: safeEvents.length,
    ledgerSpan: computeLedgerSpan(safeEvents),
    bucketLedgerSpans: computeBucketLedgerSpans(safeEvents, bucketUnit),
    volume: volumeSeries(safeEvents, { bucket: bucketUnit }),
    latency: resolutionLatency(safeEvents),
  };
}

function formatSummary(summary: LatencySummary | null): string {
  if (!summary) return "null";
  return (
    `p50=${summary.p50.seconds}s/${summary.p50.ledgers}L,` +
    `p90=${summary.p90.seconds}s/${summary.p90.ledgers}L,` +
    `max=${summary.max.seconds}s/${summary.max.ledgers}L`
  );
}

function isBucketStraddlingCut(
  startAt: number,
  before: AggregateSnapshot,
  after: AggregateSnapshot,
): boolean {
  const span = before.bucketLedgerSpans[String(startAt)];
  if (!span) return false;
  const afterMin = after.ledgerSpan.minLedger;
  const afterMax = after.ledgerSpan.maxLedger;
  if (afterMin === null || afterMax === null) return true;
  const headCut =
    before.ledgerSpan.minLedger !== null &&
    afterMin > before.ledgerSpan.minLedger &&
    span.minLedger < afterMin;
  const tailCut =
    before.ledgerSpan.maxLedger !== null &&
    afterMax < before.ledgerSpan.maxLedger &&
    span.maxLedger > afterMax;
  return headCut || tailCut;
}

function isMonotonicSubsetBucket(beforeBucket: VolumeBucket, afterBucket: VolumeBucket): boolean {
  return (
    afterBucket.challengeStake <= beforeBucket.challengeStake &&
    afterBucket.squadDeposit <= beforeBucket.squadDeposit &&
    afterBucket.challengeCount <= beforeBucket.challengeCount &&
    afterBucket.depositCount <= beforeBucket.depositCount &&
    afterBucket.eventCount < beforeBucket.eventCount
  );
}

/**
 * Reconcile pre- and post-compaction aggregate snapshots into a deterministic report
 * that separates range loss (trimmed ledgers, missing edge buckets, out-of-window claims)
 * from arithmetic mismatches (divergent bucket amounts/counts, overlap total drift, or
 * altered claim durations/outcomes).
 */
export function reconcileAggregateSnapshots(
  before: AggregateSnapshot,
  after: AggregateSnapshot,
): AggregateReconciliationReport {
  if (before.bucketUnit !== after.bucketUnit) {
    throw new Error(
      `Cannot reconcile snapshots with different bucket units (${before.bucketUnit} vs ${after.bucketUnit})`,
    );
  }

  const rangeLosses: RangeLossDetail[] = [];
  const arithmeticMismatches: ArithmeticMismatchDetail[] = [];

  // 1. Ledger range comparison
  const bMin = before.ledgerSpan.minLedger;
  const bMax = before.ledgerSpan.maxLedger;
  const aMin = after.ledgerSpan.minLedger;
  const aMax = after.ledgerSpan.maxLedger;

  if (bMin !== null && (aMin === null || aMin > bMin)) {
    rangeLosses.push({
      kind: "ledger_head_trimmed",
      scope: "ledger",
      identifier: "minLedger",
      beforeValue: String(bMin),
      afterValue: aMin === null ? "null" : String(aMin),
    });
  }

  if (bMax !== null && (aMax === null || aMax < bMax)) {
    rangeLosses.push({
      kind: "ledger_tail_trimmed",
      scope: "ledger",
      identifier: "maxLedger",
      beforeValue: String(bMax),
      afterValue: aMax === null ? "null" : String(aMax),
    });
  }

  // 2. Volume bucket comparison
  const beforeBuckets = new Map<number, VolumeBucket>(
    before.volume.buckets.map((b) => [b.startAt, b]),
  );
  const afterBuckets = new Map<number, VolumeBucket>(
    after.volume.buckets.map((b) => [b.startAt, b]),
  );

  const allBucketStarts = [...new Set([...beforeBuckets.keys(), ...afterBuckets.keys()])].sort(
    (a, b) => a - b,
  );

  let overlapBeforeChallenge = 0n;
  let overlapAfterChallenge = 0n;
  let overlapBeforeDeposit = 0n;
  let overlapAfterDeposit = 0n;

  for (const startAt of allBucketStarts) {
    const bBucket = beforeBuckets.get(startAt);
    const aBucket = afterBuckets.get(startAt);

    if (bBucket && !aBucket) {
      rangeLosses.push({
        kind: "volume_bucket_missing",
        scope: "volume",
        identifier: bBucket.timestamp,
        beforeValue: `stake=${bBucket.challengeStakeTotal},deposit=${bBucket.squadDepositTotal},events=${bBucket.eventCount}`,
        afterValue: "missing",
      });
      continue;
    }

    if (!bBucket && aBucket) {
      rangeLosses.push({
        kind: "volume_bucket_added",
        scope: "volume",
        identifier: aBucket.timestamp,
        beforeValue: "missing",
        afterValue: `stake=${aBucket.challengeStakeTotal},deposit=${aBucket.squadDepositTotal},events=${aBucket.eventCount}`,
      });
      continue;
    }

    if (!bBucket || !aBucket) continue;

    // If a boundary bucket straddled a ledger trim cut and strictly lost edge events,
    // classify that partial bucket reduction as range loss rather than arithmetic corruption.
    if (
      isBucketStraddlingCut(startAt, before, after) &&
      isMonotonicSubsetBucket(bBucket, aBucket)
    ) {
      rangeLosses.push({
        kind: "volume_bucket_trimmed",
        scope: "volume",
        identifier: bBucket.timestamp,
        beforeValue: `stake=${bBucket.challengeStakeTotal},deposit=${bBucket.squadDepositTotal},events=${bBucket.eventCount}`,
        afterValue: `stake=${aBucket.challengeStakeTotal},deposit=${aBucket.squadDepositTotal},events=${aBucket.eventCount}`,
      });
      continue;
    }

    overlapBeforeChallenge += bBucket.challengeStake;
    overlapAfterChallenge += aBucket.challengeStake;
    overlapBeforeDeposit += bBucket.squadDeposit;
    overlapAfterDeposit += aBucket.squadDeposit;

    if (bBucket.challengeStake !== aBucket.challengeStake) {
      arithmeticMismatches.push({
        kind: "bucket_challenge_stake_mismatch",
        scope: "volume",
        identifier: bBucket.timestamp,
        beforeValue: bBucket.challengeStakeTotal,
        afterValue: aBucket.challengeStakeTotal,
      });
    }

    if (bBucket.squadDeposit !== aBucket.squadDeposit) {
      arithmeticMismatches.push({
        kind: "bucket_squad_deposit_mismatch",
        scope: "volume",
        identifier: bBucket.timestamp,
        beforeValue: bBucket.squadDepositTotal,
        afterValue: aBucket.squadDepositTotal,
      });
    }

    if (
      bBucket.challengeCount !== aBucket.challengeCount ||
      bBucket.depositCount !== aBucket.depositCount ||
      bBucket.eventCount !== aBucket.eventCount
    ) {
      arithmeticMismatches.push({
        kind: "bucket_count_mismatch",
        scope: "volume",
        identifier: bBucket.timestamp,
        beforeValue: `challenges=${bBucket.challengeCount},deposits=${bBucket.depositCount},events=${bBucket.eventCount}`,
        afterValue: `challenges=${aBucket.challengeCount},deposits=${aBucket.depositCount},events=${aBucket.eventCount}`,
      });
    }
  }

  if (overlapBeforeChallenge !== overlapAfterChallenge) {
    arithmeticMismatches.push({
      kind: "overlap_total_mismatch",
      scope: "volume",
      identifier: "challengeStake",
      beforeValue: overlapBeforeChallenge.toString(),
      afterValue: overlapAfterChallenge.toString(),
    });
  }

  if (overlapBeforeDeposit !== overlapAfterDeposit) {
    arithmeticMismatches.push({
      kind: "overlap_total_mismatch",
      scope: "volume",
      identifier: "squadDeposit",
      beforeValue: overlapBeforeDeposit.toString(),
      afterValue: overlapAfterDeposit.toString(),
    });
  }

  // Also check serialized top-level totals when no volume range loss occurred
  const hasVolumeRangeLoss = rangeLosses.some((r) => r.scope === "volume");
  if (!hasVolumeRangeLoss) {
    if (
      before.volume.totalChallengeStake !== after.volume.totalChallengeStake &&
      overlapBeforeChallenge === overlapAfterChallenge
    ) {
      arithmeticMismatches.push({
        kind: "overlap_total_mismatch",
        scope: "volume",
        identifier: "totalChallengeStake",
        beforeValue: before.volume.totalChallengeStake,
        afterValue: after.volume.totalChallengeStake,
      });
    }
    if (
      before.volume.totalSquadDeposit !== after.volume.totalSquadDeposit &&
      overlapBeforeDeposit === overlapAfterDeposit
    ) {
      arithmeticMismatches.push({
        kind: "overlap_total_mismatch",
        scope: "volume",
        identifier: "totalSquadDeposit",
        beforeValue: before.volume.totalSquadDeposit,
        afterValue: after.volume.totalSquadDeposit,
      });
    }
  }

  // 3. Resolution-latency comparison
  interface IndexedClaim {
    outcome: "resolved" | "cancelled";
    claim: ClaimLatency;
  }

  const indexClaims = (report: ResolutionLatencyReport): Map<number, IndexedClaim> => {
    const map = new Map<number, IndexedClaim>();
    for (const claim of report.resolved.claims) {
      map.set(claim.claimId, { outcome: "resolved", claim });
    }
    for (const claim of report.cancelled.claims) {
      map.set(claim.claimId, { outcome: "cancelled", claim });
    }
    return map;
  };

  const beforeClaims = indexClaims(before.latency);
  const afterClaims = indexClaims(after.latency);
  const allClaimIds = [...new Set([...beforeClaims.keys(), ...afterClaims.keys()])].sort(
    (a, b) => a - b,
  );

  let claimRangeChanged = false;

  for (const claimId of allClaimIds) {
    const bEntry = beforeClaims.get(claimId);
    const aEntry = afterClaims.get(claimId);

    if (bEntry && !aEntry) {
      const outsideRetainedWindow =
        aMin === null ||
        aMax === null ||
        bEntry.claim.creationLedger < aMin ||
        bEntry.claim.resolutionLedger > aMax;

      if (outsideRetainedWindow) {
        claimRangeChanged = true;
        rangeLosses.push({
          kind: "claim_missing",
          scope: "latency",
          identifier: `claim:${claimId}`,
          beforeValue: `${bEntry.outcome}@${bEntry.claim.creationLedger}->${bEntry.claim.resolutionLedger}`,
          afterValue: "missing",
        });
      } else {
        arithmeticMismatches.push({
          kind: "claim_duration_mismatch",
          scope: "latency",
          identifier: `claim:${claimId}`,
          beforeValue: `${bEntry.outcome}:${bEntry.claim.duration.seconds}s/${bEntry.claim.duration.ledgers}L`,
          afterValue: "missing_in_retained_window",
        });
      }
      continue;
    }

    if (!bEntry && aEntry) {
      claimRangeChanged = true;
      rangeLosses.push({
        kind: "claim_added",
        scope: "latency",
        identifier: `claim:${claimId}`,
        beforeValue: "missing",
        afterValue: `${aEntry.outcome}@${aEntry.claim.creationLedger}->${aEntry.claim.resolutionLedger}`,
      });
      continue;
    }

    if (!bEntry || !aEntry) continue;

    if (bEntry.outcome !== aEntry.outcome) {
      arithmeticMismatches.push({
        kind: "claim_outcome_mismatch",
        scope: "latency",
        identifier: `claim:${claimId}`,
        beforeValue: bEntry.outcome,
        afterValue: aEntry.outcome,
      });
      continue;
    }

    if (
      bEntry.claim.duration.seconds !== aEntry.claim.duration.seconds ||
      bEntry.claim.duration.ledgers !== aEntry.claim.duration.ledgers
    ) {
      arithmeticMismatches.push({
        kind: "claim_duration_mismatch",
        scope: "latency",
        identifier: `claim:${claimId}`,
        beforeValue: `${bEntry.claim.duration.seconds}s/${bEntry.claim.duration.ledgers}L`,
        afterValue: `${aEntry.claim.duration.seconds}s/${aEntry.claim.duration.ledgers}L`,
      });
    }
  }

  if (!claimRangeChanged) {
    const bResSummary = formatSummary(before.latency.resolved.summary);
    const aResSummary = formatSummary(after.latency.resolved.summary);
    if (bResSummary !== aResSummary) {
      arithmeticMismatches.push({
        kind: "latency_summary_mismatch",
        scope: "latency",
        identifier: "resolved.summary",
        beforeValue: bResSummary,
        afterValue: aResSummary,
      });
    }

    const bCanSummary = formatSummary(before.latency.cancelled.summary);
    const aCanSummary = formatSummary(after.latency.cancelled.summary);
    if (bCanSummary !== aCanSummary) {
      arithmeticMismatches.push({
        kind: "latency_summary_mismatch",
        scope: "latency",
        identifier: "cancelled.summary",
        beforeValue: bCanSummary,
        afterValue: aCanSummary,
      });
    }
  }

  // Deterministic ordering of findings
  rangeLosses.sort((x, y) => {
    if (x.scope !== y.scope) return x.scope.localeCompare(y.scope);
    if (x.kind !== y.kind) return x.kind.localeCompare(y.kind);
    return x.identifier.localeCompare(y.identifier);
  });

  arithmeticMismatches.sort((x, y) => {
    if (x.scope !== y.scope) return x.scope.localeCompare(y.scope);
    if (x.kind !== y.kind) return x.kind.localeCompare(y.kind);
    return x.identifier.localeCompare(y.identifier);
  });

  const hasRangeLoss = rangeLosses.length > 0;
  const hasArithmeticMismatch = arithmeticMismatches.length > 0;

  let status: ReconciliationStatus = "match";
  if (hasRangeLoss && hasArithmeticMismatch) {
    status = "range_loss_and_arithmetic_mismatch";
  } else if (hasRangeLoss) {
    status = "range_loss";
  } else if (hasArithmeticMismatch) {
    status = "arithmetic_mismatch";
  }

  return {
    schemaVersion: 1,
    bucketUnit: before.bucketUnit,
    status,
    ok: status === "match",
    hasRangeLoss,
    hasArithmeticMismatch,
    ledgerSpan: {
      before: { ...before.ledgerSpan },
      after: { ...after.ledgerSpan },
    },
    totals: {
      beforeChallengeStake: before.volume.totalChallengeStake,
      afterChallengeStake: after.volume.totalChallengeStake,
      overlapBeforeChallengeStake: overlapBeforeChallenge.toString(),
      overlapAfterChallengeStake: overlapAfterChallenge.toString(),
      beforeSquadDeposit: before.volume.totalSquadDeposit,
      afterSquadDeposit: after.volume.totalSquadDeposit,
      overlapBeforeSquadDeposit: overlapBeforeDeposit.toString(),
      overlapAfterSquadDeposit: overlapAfterDeposit.toString(),
      beforeResolvedClaims: before.latency.resolved.claims.length,
      afterResolvedClaims: after.latency.resolved.claims.length,
      beforeCancelledClaims: before.latency.cancelled.claims.length,
      afterCancelledClaims: after.latency.cancelled.claims.length,
    },
    rangeLosses,
    arithmeticMismatches,
  };
}

/**
 * Compute aggregate snapshots for `beforeEvents` and `afterEvents` and return a
 * deterministic compaction reconciliation report.
 */
export function compareCompactedAggregates(
  beforeEvents: readonly DecodedEvent[] | null | undefined,
  afterEvents: readonly DecodedEvent[] | null | undefined,
  options: ReconcileOptions = {},
): AggregateReconciliationReport {
  const before = buildAggregateSnapshot(beforeEvents, options);
  const after = buildAggregateSnapshot(afterEvents, options);
  return reconcileAggregateSnapshots(before, after);
}

/**
 * Stream events from two archive directories (before and after compaction) and
 * produce a deterministic aggregate reconciliation report.
 */
export async function reconcileArchiveCompaction(
  beforeArchiveDir: string,
  afterArchiveDir: string,
  options: ReconcileOptions = {},
): Promise<AggregateReconciliationReport> {
  const beforeEvents: DecodedEvent[] = [];
  for await (const ev of readArchive(beforeArchiveDir)) {
    beforeEvents.push(ev);
  }

  const afterEvents: DecodedEvent[] = [];
  for await (const ev of readArchive(afterArchiveDir)) {
    afterEvents.push(ev);
  }

  return compareCompactedAggregates(beforeEvents, afterEvents, options);
}

/**
 * Render a deterministic, human-readable summary of an aggregate reconciliation report.
 */
export function formatReconciliationReport(report: AggregateReconciliationReport): string {
  const bSpan =
    report.ledgerSpan.before.minLedger === null
      ? "empty"
      : `${report.ledgerSpan.before.minLedger}..${report.ledgerSpan.before.maxLedger}`;
  const aSpan =
    report.ledgerSpan.after.minLedger === null
      ? "empty"
      : `${report.ledgerSpan.after.minLedger}..${report.ledgerSpan.after.maxLedger}`;

  const lines: string[] = [
    `status=${report.status} ok=${report.ok} bucket=${report.bucketUnit}`,
    `ledgers before=${bSpan} after=${aSpan}`,
    `overlap_stake before=${report.totals.overlapBeforeChallengeStake} after=${report.totals.overlapAfterChallengeStake}`,
    `overlap_deposit before=${report.totals.overlapBeforeSquadDeposit} after=${report.totals.overlapAfterSquadDeposit}`,
    `range_losses=${report.rangeLosses.length} arithmetic_mismatches=${report.arithmeticMismatches.length}`,
  ];

  for (const item of report.rangeLosses) {
    lines.push(
      `[range_loss] ${item.scope}:${item.kind}:${item.identifier} (${item.beforeValue} -> ${item.afterValue})`,
    );
  }
  for (const item of report.arithmeticMismatches) {
    lines.push(
      `[arithmetic_mismatch] ${item.scope}:${item.kind}:${item.identifier} (${item.beforeValue} -> ${item.afterValue})`,
    );
  }

  return lines.join("\n");
}
