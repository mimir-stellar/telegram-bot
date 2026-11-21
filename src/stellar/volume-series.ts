import type { DecodedEvent } from "./decode.js";

export type VolumeBucketUnit = "hour" | "day";

export interface VolumeSeriesOptions {
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

  const stepSeconds = bucketUnit === "hour" ? SECONDS_PER_HOUR : SECONDS_PER_DAY;
  const identityOf = options.identity ?? defaultIdentity;

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
      skippedWithoutAt++;
      continue;
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

    totalChallengeStakeBigInt += challengeStakeDelta;
    totalSquadDepositBigInt += squadDepositDelta;

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
    totalChallengeStake: totalChallengeStakeBigInt.toString(),
    totalSquadDeposit: totalSquadDepositBigInt.toString(),
    skippedWithoutAt,
    processedEvents,
  };
}
