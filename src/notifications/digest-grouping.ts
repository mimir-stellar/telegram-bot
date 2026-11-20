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
import { DEFAULT_ALWAYS_SEND_EVENTS, resolveEventName } from "./quiet-hours.js";

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

export interface PruneExpiredDigestEntriesOptions {
  /** Reference timestamp in epoch milliseconds (e.g. digest build time). */
  nowMs: number;
  /**
   * Maximum age in milliseconds for low-priority (non-critical) events.
   * Events with `nowMs - event.at > maxAgeMs` are omitted unless critical.
   * Must be a finite number `>= 0`.
   */
  maxAgeMs: number;
  /**
   * Event names treated as critical and retained regardless of age.
   * Defaults to {@link DEFAULT_ALWAYS_SEND_EVENTS}.
   */
  criticalEvents?: Iterable<string>;
}

export interface PrunedDigestEvents {
  /** Retained events in their original order. */
  events: DecodedEvent[];
  /** Explicit count of expired low-priority events omitted. */
  omittedCount: number;
}

/**
 * Drop expired low-priority digest entries while retaining critical events
 * and returning an explicit count of omitted entries.
 *
 * An event is considered expired when `nowMs - event.at > maxAgeMs`.
 * Events at the exact boundary (`nowMs - event.at === maxAgeMs`) are retained.
 *
 * Throws `RangeError` when `nowMs` is not finite or `maxAgeMs` is not a
 * finite non-negative number.
 */
export function pruneExpiredDigestEntries(
  events: readonly DecodedEvent[],
  options: PruneExpiredDigestEntriesOptions,
): PrunedDigestEvents {
  const { nowMs, maxAgeMs, criticalEvents } = options;
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite number");
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be a finite non-negative number");
  }

  const criticalSet: ReadonlySet<string> = criticalEvents
    ? new Set(criticalEvents)
    : DEFAULT_ALWAYS_SEND_EVENTS;

  const retained: DecodedEvent[] = [];
  let omittedCount = 0;

  for (const event of events) {
    const ageMs = nowMs - event.at;
    if (ageMs > maxAgeMs && !criticalSet.has(resolveEventName(event))) {
      omittedCount += 1;
    } else {
      retained.push(event);
    }
  }

  return { events: retained, omittedCount };
}
