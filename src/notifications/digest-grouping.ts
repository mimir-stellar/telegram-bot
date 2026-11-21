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

/** Reasons why a digest period does not have complete ledger coverage. */
export type DigestIncompleteReason = "rpc_gap" | "restart";

/** Explicit completeness metadata for a digest period. */
export interface DigestPeriodCompleteness {
  /** Whether the digest period has complete ledger coverage. */
  complete: boolean;
  /**
   * Reasons why the period is incomplete.
   * Always empty when `complete` is `true`.
   */
  reasons: DigestIncompleteReason[];
}

/** Grouped digest payload paired with explicit period completeness metadata. */
export interface DigestPeriod {
  groups: DigestGroup[];
  eventCount: number;
  completeness: DigestPeriodCompleteness;
}

const VALID_INCOMPLETE_REASONS = new Set<DigestIncompleteReason>(["rpc_gap", "restart"]);

const REASON_LABELS: Record<DigestIncompleteReason, string> = {
  rpc_gap: "RPC gap",
  restart: "restart",
};

/**
 * Normalize digest period completeness metadata.
 *
 * Deduplicates valid reasons in first-seen order and enforces the invariant
 * that any period with one or more incomplete reasons is never marked complete.
 */
export function normalizeDigestCompleteness(
  input?: Partial<DigestPeriodCompleteness>,
): DigestPeriodCompleteness {
  if (!input) {
    return { complete: true, reasons: [] };
  }

  const reasons: DigestIncompleteReason[] = [];
  if (Array.isArray(input.reasons)) {
    for (const reason of input.reasons) {
      if (VALID_INCOMPLETE_REASONS.has(reason) && !reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }

  const complete = reasons.length === 0 && input.complete !== false;
  return { complete, reasons };
}

/**
 * Format a human-readable label for an incomplete digest period, or `null`
 * when the period is complete.
 */
export function formatCompletenessLabel(
  completeness: Partial<DigestPeriodCompleteness>,
): string | null {
  const normalized = normalizeDigestCompleteness(completeness);
  if (normalized.complete) return null;
  if (normalized.reasons.length === 0) return "Incomplete period";
  const detail = normalized.reasons.map((r) => REASON_LABELS[r]).join(", ");
  return `Incomplete period (${detail})`;
}

/**
 * Group `events` and attach normalized period completeness metadata.
 */
export function buildDigestPeriod(
  events: readonly DecodedEvent[],
  completeness?: Partial<DigestPeriodCompleteness>,
): DigestPeriod {
  return {
    groups: groupDigestEvents(events),
    eventCount: events.length,
    completeness: normalizeDigestCompleteness(completeness),
  };
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
