import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey, type DedupableEvent } from "../dedup.js";
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
  /**
   * Builds a per-event identity component from a `DecodedEvent`. When omitted,
   * the key derives from the event's `contractId` and `source`, which is what
   * separates identical numeric IDs coming from different contracts. Include
   * the network here if a multi-network feed is ever merged, e.g.
   * `(e) => `${network}:${e.contractId}:${e.source}``.
   */
  identity?: (event: DecodedEvent) => string;
}

export interface VolumeBucket {
  /** UTC ISO string representing the start of the bucket. */
  timestamp: string;
  /** Unix timestamp in seconds for the start of the bucket. */
  startAt: number;
  /** Composite identity of the aggregate this bucket belongs to. */
  identityKey: string;
  challengeStakeTotal: string;
  squadDepositTotal: string;
  challengeStake: bigint;
  squadDeposit: bigint;
  challengeCount: number;
  depositCount: number;
  eventCount: number;
}

export interface VolumeSeriesResult {
  buckets: VolumeBucket[];
  totalChallengeStake: string;
  totalSquadDeposit: string;
  skippedWithoutAt: number;
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

export function floorToBucketUtc(unixSeconds: number, bucket: VolumeBucketUnit): number {
  if (bucket === "hour") {
    return Math.floor(unixSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  }
  return Math.floor(unixSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function defaultIdentity(event: DecodedEvent): string {
  const contract = typeof event.contractId === "string" ? event.contractId : "";
  const source = typeof event.source === "string" ? event.source : "";
  return `${contract}:${source}`;
}

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
  const identityOf = options.identity ?? defaultIdentity;

    this.minBucketStart = cp.minBucketStart;
    this.maxBucketStart = cp.maxBucketStart;
    try {
      this.totalChallengeStakeBigInt = BigInt(cp.totalChallengeStake);
    } catch {
      this.totalChallengeStakeBigInt = 0n;
    }
    try {
      this.totalSquadDepositBigInt = BigInt(cp.totalSquadDeposit);
    } catch {
      this.totalSquadDepositBigInt = 0n;
    }
    this.skippedWithoutAt = cp.skippedWithoutAt;
    this.processedEvents = cp.processedEvents;
    this.lastProcessedEventId = cp.lastProcessedEventId ?? null;

    for (const b of cp.buckets) {
      try {
        this.bucketMap.set(b.startAt, {
          startAt: b.startAt,
          challengeStake: BigInt(b.challengeStake),
          squadDeposit: BigInt(b.squadDeposit),
          challengeCount: b.challengeCount,
          depositCount: b.depositCount,
          eventCount: b.eventCount,
        });
      } catch {
        // Skip malformed individual bucket if bigint parse fails
      }
    }

    if (Array.isArray(cp.recentEventIds)) {
      for (const id of cp.recentEventIds) {
        if (typeof id === "string" && id !== "") {
          this.dedup.add(id);
          this.checkpointDedup.add(id);
        }
      }
    }
  }

  get stats(): { processedEvents: number; skippedWithoutAt: number; resumedDuplicates: number } {
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
    attachSeriesMetadata(emptyResult, 0n, 0n);
    return emptyResult;
  }

  interface IntermediateBucket {
    identityKey: string;
    startAt: number;
    challengeStake: bigint;
    squadDeposit: bigint;
    challengeCount: number;
    depositCount: number;
    eventCount: number;
  }

  const bucketMap = new Map<string, IntermediateBucket>();
  const minByKey = new Map<string, number>();
  const maxByKey = new Map<string, number>();
  let totalChallengeStakeBigInt = 0n;
  let totalSquadDepositBigInt = 0n;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    const at = (event as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      this.skippedWithoutAt++;
      if (key !== null) {
        this.dedup.add(key);
        this.lastProcessedEventId = key;
      }
      return false;
    }

    const payload = (event as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") continue;

    const payloadName = (payload as { name?: unknown }).name;

    let challengeStakeDelta = 0n;
    let squadDepositDelta = 0n;
    let isChallenge = false;
    let isDeposit = false;

    if (payloadName === "claim_challenged") {
      const stake = (payload as { stake?: unknown }).stake;
      if (typeof stake === "bigint") challengeStakeDelta = stake;
      else if (typeof stake === "string" || typeof stake === "number") {
        try { challengeStakeDelta = BigInt(stake); } catch { challengeStakeDelta = 0n; }
      }
      isChallenge = true;
    } else if (payloadName === "deposited") {
      const amt = (payload as { amount?: unknown }).amount;
      if (typeof amt === "bigint") squadDepositDelta = amt;
      else if (typeof amt === "string" || typeof amt === "number") {
        try { squadDepositDelta = BigInt(amt); } catch { squadDepositDelta = 0n; }
      }
      isDeposit = true;
    }

    processedEvents++;

    const identityKey = identityOf(event as DecodedEvent);
    const bucketStart = floorToBucketUtc(Math.floor(at), bucketUnit);
    const compositeKey = `${identityKey}:${bucketStart}`;

    const prevMin = minByKey.get(identityKey);
    if (prevMin === undefined || bucketStart < prevMin) minByKey.set(identityKey, bucketStart);
    const prevMax = maxByKey.get(identityKey);
    if (prevMax === undefined || bucketStart > prevMax) maxByKey.set(identityKey, bucketStart);

    const bucketStart = floorToBucketUtc(Math.floor(at), this.bucketUnit);

    let existing = bucketMap.get(compositeKey);
    if (!existing) {
      existing = {
        identityKey, startAt: bucketStart,
        challengeStake: 0n, squadDeposit: 0n,
        challengeCount: 0, depositCount: 0, eventCount: 0,
      };
      bucketMap.set(compositeKey, existing);
    }

    existing.challengeStake += challengeStakeDelta;
    existing.squadDeposit += squadDepositDelta;
    if (isChallenge) existing.challengeCount++;
    if (isDeposit) existing.depositCount++;
    existing.eventCount++;

    if (this.maxBuckets !== undefined && this.bucketMap.size > this.maxBuckets) {
      const sortedKeys = Array.from(this.bucketMap.keys()).sort((a, b) => a - b);
      const toEvict = sortedKeys.slice(0, this.bucketMap.size - this.maxBuckets);
      for (const k of toEvict) {
        this.bucketMap.delete(k);
      }
      if (sortedKeys.length > toEvict.length) {
        this.minBucketStart = sortedKeys[toEvict.length]!;
      }
    }

    return true;
  }

  const buckets: VolumeBucket[] = [];
  for (const [identityKey, minStart] of minByKey) {
    const maxStart = maxByKey.get(identityKey)!;
    for (let t = minStart; t <= maxStart; t += stepSeconds) {
      const data = bucketMap.get(`${identityKey}:${t}`);
      buckets.push({
        timestamp: new Date(t * 1000).toISOString(),
        startAt: t,
        identityKey,
        challengeStakeTotal: (data ? data.challengeStake : 0n).toString(),
        squadDepositTotal: (data ? data.squadDeposit : 0n).toString(),
        challengeStake: data ? data.challengeStake : 0n,
        squadDeposit: data ? data.squadDeposit : 0n,
        challengeCount: data ? data.challengeCount : 0,
        depositCount: data ? data.depositCount : 0,
        eventCount: data ? data.eventCount : 0,
      });
    }
  }
  buckets.sort((a, b) =>
    a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : a.startAt - b.startAt,
  );

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
