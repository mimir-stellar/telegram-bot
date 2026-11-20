/**
 * Group a flat array of decoded events by claim or squad market.
 *
 * Events from `mimir-market` are keyed by `claimId`; events from `mimir-squad`
 * are keyed by `marketId`. Everything else (admin events, unknowns, or market /
 * squad events whose payload lacks the id field) forms its own singleton group.
 *
 * Group order and intra-group order follow canonical timestamp + chain identity
 * ({@link compareDigestEvents}: `at` → {@link compareEvents} → contract / source /
 * canonical key / payload identity) so replay and live multi-contract processing
 * emit identical digests even when event timestamps are equal.
 */

import { eventKey } from "../dedup.js";
import { compareEvents, type DecodedEvent } from "../stellar/decode.js";
import { normalizeDigestEventTimestamp } from "./schedule.js";

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

function compareLexicographic(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function payloadEventName(event: DecodedEvent): string {
  return event.payload.name === "unknown"
    ? `unknown:${event.payload.eventName}`
    : event.payload.name;
}

/**
 * Deterministic canonical chain identity string for tie-breaking events whose
 * close timestamps and primary RPC coordinates match.
 */
export function canonicalDigestIdentity(event: DecodedEvent): string {
  const dedupId = eventKey(event) ?? "";
  return [
    String(event.ledger ?? 0),
    event.transactionIndex === null ? "_" : String(event.transactionIndex),
    event.operationIndex === null ? "_" : String(event.operationIndex),
    event.contractId ?? "",
    event.source ?? "",
    dedupId,
    event.txHash ?? "",
    payloadEventName(event),
    groupKeyFor(event),
  ].join("|");
}

/**
 * Strict total-order comparator for digest events:
 * 1. Chain close timestamp (`at`, normalized via {@link normalizeDigestEventTimestamp})
 * 2. Primary chain coordinates ({@link compareEvents}: ledger → txIndex → opIndex → eventId → txHash)
 * 3. Canonical contract & event identity (`contractId` → `source` → `eventKey` → payload name → group key)
 *
 * Consults zero wall-clock or arrival-order state so live multi-contract scans
 * and historical ledger replays produce identical ordering when timestamps tie.
 */
export function compareDigestEvents(a: DecodedEvent, b: DecodedEvent): number {
  const tsA = normalizeDigestEventTimestamp(a.at);
  const tsB = normalizeDigestEventTimestamp(b.at);
  if (tsA !== tsB) return tsA - tsB;

  const chainOrder = compareEvents(a, b);
  if (chainOrder !== 0) return chainOrder;

  const contractCmp = compareLexicographic(a.contractId ?? "", b.contractId ?? "");
  if (contractCmp !== 0) return contractCmp;

  const sourceCmp = compareLexicographic(a.source ?? "", b.source ?? "");
  if (sourceCmp !== 0) return sourceCmp;

  const keyA = eventKey(a) ?? "";
  const keyB = eventKey(b) ?? "";
  const keyCmp = compareLexicographic(keyA, keyB);
  if (keyCmp !== 0) return keyCmp;

  const nameCmp = compareLexicographic(payloadEventName(a), payloadEventName(b));
  if (nameCmp !== 0) return nameCmp;

  return compareLexicographic(groupKeyFor(a), groupKeyFor(b));
}

/**
 * Return a new array sorted deterministically by {@link compareDigestEvents},
 * falling back to input index only for completely indistinguishable clones.
 */
export function sortDigestEvents(events: readonly DecodedEvent[]): DecodedEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((x, y) => compareDigestEvents(x.event, y.event) || x.index - y.index)
    .map((entry) => entry.event);
}

/**
 * Bucket `events` by Group_Key after canonical digest sorting so both group
 * appearance order and intra-group order remain deterministic across replay and
 * live multi-contract arrival orders when timestamps are equal.
 *
 * Returns an empty array when `events` is empty.
 */
export function groupDigestEvents(events: readonly DecodedEvent[]): DigestGroup[] {
  if (events.length === 0) return [];

  const canonical = sortDigestEvents(events);
  const buckets = new Map<string, DecodedEvent[]>();

  for (const event of canonical) {
    const key = groupKeyFor(event);
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.push(event);
    } else {
      buckets.set(key, [event]);
    }
  }

  const groups: DigestGroup[] = [];
  for (const [key, ordered] of buckets) {
    groups.push({ key, events: ordered });
  }
  return groups;
}
