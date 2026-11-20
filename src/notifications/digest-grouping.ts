/**
 * Group a flat array of decoded events by claim or squad market.
 *
 * Events from `mimir-market` are keyed by `claimId`; events from `mimir-squad`
 * are keyed by `marketId`. Everything else (admin events, unknowns, or market /
 * squad events whose payload lacks the id field) forms its own singleton group.
 *
 * Group order follows First-Seen insertion order. Within each group events are
 * sorted deterministically by {@link compareEvents}.
 */

import { compareEvents, sortEvents, type DecodedEvent } from "../stellar/decode.js";
import {
  decide,
  DEFAULT_ALWAYS_SEND_EVENTS,
  isInQuietHours,
  type QuietHoursPolicy,
} from "./quiet-hours.js";

export interface DigestGroup {
  /**
   * Identifier for this group.
   * - `"market:<claimId>"` for mimir-market events that carry a claimId
   * - `"squad:<marketId>"` for mimir-squad events that carry a marketId
   * - `"ungroupable:<eventId>"` for everything else (one event per group)
   */
  key: string;
  events: DecodedEvent[];
}

/**
 * Derive the Group_Key for a single event.
 *
 * Returns a stable, human-readable key used both as the bucket identifier and
 * as the group header text in the digest.
 */
function groupKeyFor(event: DecodedEvent): string {
  const p = event.payload;

  if (event.source === "market" && "claimId" in p && p.claimId !== undefined) {
    return `market:${p.claimId}`;
  }

  if (event.source === "squad" && "marketId" in p && p.marketId !== undefined) {
    return `squad:${p.marketId}`;
  }

  // Admin events, unknown events, and any market/squad event whose payload
  // lacks the expected id field fall here.  Using eventId makes the key unique
  // so each such event forms its own singleton group.
  return `ungroupable:${event.eventId}`;
}

/**
 * Bucket `events` by Group_Key, preserving First-Seen insertion order of keys.
 *
 * Events within each bucket are sorted with {@link compareEvents} (ledger →
 * transaction index → operation index → paging token → tx hash).
 *
 * Returns an empty array when `events` is empty.
 */
export function groupDigestEvents(events: readonly DecodedEvent[]): DigestGroup[] {
  if (events.length === 0) return [];

  // insertion-order Map so the output order of groups mirrors the order in
  // which their keys were first encountered while iterating events.
  const buckets = new Map<string, DecodedEvent[]>();

  for (const event of events) {
    const key = groupKeyFor(event);
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.push(event);
    } else {
      buckets.set(key, [event]);
    }
  }

  const groups: DigestGroup[] = [];
  for (const [key, raw] of buckets) {
    groups.push({ key, events: sortEvents(raw) });
  }
  return groups;
}

/** Default maximum number of deferred digest entries retained in memory. */
export const DEFAULT_MAX_DIGEST_ENTRIES = 1000;

export interface DigestDeferralOptions {
  /** Quiet-hours policy used to decide when digests are deferred. */
  policy?: QuietHoursPolicy;
  /** Maximum number of deferred entries retained before excess entries are dropped. Defaults to 1000. */
  maxEntries?: number;
  /** Critical event names that always bypass quiet-hours deferral. Defaults to {@link DEFAULT_ALWAYS_SEND_EVENTS} when the policy does not specify one. */
  alwaysSend?: Iterable<string>;
}

export interface DigestPartitionResult {
  immediate: DecodedEvent[];
  deferred: DecodedEvent[];
}

export interface DigestIngestResult {
  immediate: DecodedEvent[];
  deferredCount: number;
  droppedCount: number;
  bufferedCount: number;
}

export interface DigestFlushResult {
  events: DecodedEvent[];
  groups: DigestGroup[];
  droppedCount: number;
}

function resolveEffectivePolicy(
  policy: QuietHoursPolicy | undefined,
  alwaysSend: Iterable<string> | undefined,
): QuietHoursPolicy {
  if (!policy) {
    return { alwaysSend: alwaysSend ?? DEFAULT_ALWAYS_SEND_EVENTS };
  }
  const hasPolicyAlwaysSend =
    policy.alwaysSend !== undefined ||
    policy.alwaysSendEvents !== undefined ||
    policy.alwaysSendEventNames !== undefined ||
    policy.criticalEvents !== undefined;
  if (alwaysSend !== undefined) {
    return { ...policy, alwaysSend };
  }
  if (!hasPolicyAlwaysSend) {
    return { ...policy, alwaysSend: DEFAULT_ALWAYS_SEND_EVENTS };
  }
  return policy;
}

/**
 * Partition `events` into `immediate` alerts (critical events or any event
 * outside quiet hours) and `deferred` digest candidates (non-critical events
 * arriving during quiet hours).
 */
export function partitionDigestEvents(
  events: readonly DecodedEvent[],
  policy: QuietHoursPolicy | undefined,
  now: Date | number | string,
  alwaysSend?: Iterable<string>,
): DigestPartitionResult {
  const effectivePolicy = resolveEffectivePolicy(policy, alwaysSend);
  const immediate: DecodedEvent[] = [];
  const deferred: DecodedEvent[] = [];

  for (const event of events) {
    if (decide(event, effectivePolicy, now) === "defer") {
      deferred.push(event);
    } else {
      immediate.push(event);
    }
  }

  return { immediate, deferred };
}

/**
 * Bounded quiet-hours-aware digest deferral buffer.
 *
 * - Critical events (`alwaysSend`) are returned immediately by {@link ingest}
 *   even during quiet hours.
 * - Eligible non-critical events arriving during quiet hours are accumulated up
 *   to `maxEntries`; excess entries are dropped and counted.
 * - {@link flushIfAllowed} returns `null` while quiet hours are active, and
 *   drains + groups accumulated entries via {@link groupDigestEvents} once the
 *   allowed window opens.
 */
export class DigestDeferralBuffer {
  readonly maxEntries: number;
  private readonly effectivePolicy: QuietHoursPolicy;
  private entries: DecodedEvent[] = [];
  private _droppedCount = 0;

  constructor(options: DigestDeferralOptions = {}) {
    const cap = options.maxEntries ?? DEFAULT_MAX_DIGEST_ENTRIES;
    if (!Number.isInteger(cap) || cap < 0) {
      throw new RangeError(`maxEntries must be a non-negative integer, got ${cap}`);
    }
    this.maxEntries = cap;
    this.effectivePolicy = resolveEffectivePolicy(options.policy, options.alwaysSend);
  }

  get size(): number {
    return this.entries.length;
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  peek(): readonly DecodedEvent[] {
    return [...this.entries];
  }

  /**
   * Evaluate `events` at `now`: return critical/allowed events in `immediate`
   * and buffer eligible quiet-hours events up to `maxEntries`.
   */
  ingest(events: readonly DecodedEvent[], now: Date | number | string): DigestIngestResult {
    const { immediate, deferred } = partitionDigestEvents(
      events,
      this.effectivePolicy,
      now,
    );

    let deferredCount = 0;
    let droppedInBatch = 0;
    for (const event of deferred) {
      if (this.entries.length >= this.maxEntries) {
        this._droppedCount++;
        droppedInBatch++;
      } else {
        this.entries.push(event);
        deferredCount++;
      }
    }

    return {
      immediate,
      deferredCount,
      droppedCount: droppedInBatch,
      bufferedCount: this.entries.length,
    };
  }

  /**
   * Flush and group buffered digest entries if `now` is in an allowed window.
   * Returns `null` while quiet hours are active so digests remain deferred.
   */
  flushIfAllowed(now: Date | number | string): DigestFlushResult | null {
    if (isInQuietHours(this.effectivePolicy, now)) {
      return null;
    }
    const events = this.entries;
    const droppedCount = this._droppedCount;
    this.entries = [];
    this._droppedCount = 0;
    return {
      events,
      groups: groupDigestEvents(events),
      droppedCount,
    };
  }
}
