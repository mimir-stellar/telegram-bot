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
import { formatDigest } from "./format.js";
import {
  normalizeDigestCompleteness,
  type DigestIncompletenessReason,
  type DigestPeriodCompleteness,
  type DigestPeriodCompletenessInput,
} from "./schedule.js";

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

const REASON_LABELS: Record<DigestIncompletenessReason, string> = {
  rpc_gap: "RPC retention gap",
  restart: "mid-period restart",
  rpc_error: "RPC scan interruption",
  cursor_reset: "cursor reset",
};

/**
 * Format a plain-text human-readable explanation of why a digest period is
 * incomplete (escaped by callers when embedded in MarkdownV2).
 */
export function describeIncompleteDigestReasons(
  completeness: DigestPeriodCompleteness,
): string {
  const parts = completeness.reasons.map((reason) => {
    if (reason === "rpc_gap") {
      if (completeness.gaps.length > 0) {
        const ranges = completeness.gaps
          .map((g) =>
            g.source
              ? `${g.source} ledgers ${g.fromLedger}-${g.toLedger}`
              : `ledgers ${g.fromLedger}-${g.toLedger}`,
          )
          .join(", ");
        return `RPC retention gap (${completeness.missedLedgers} missed ledgers: ${ranges})`;
      }
      if (completeness.missedLedgers > 0) {
        return `RPC retention gap (${completeness.missedLedgers} missed ledgers)`;
      }
    }
    return REASON_LABELS[reason];
  });
  return `Coverage affected by: ${parts.join("; ")}`;
}

export interface DigestPeriodSummary {
  status: "complete" | "incomplete";
  completeness: DigestPeriodCompleteness;
  /** Observed event count — explicitly scoped as partial when `status === "incomplete"`. */
  observedEventCount: number;
  groups: DigestGroup[];
  text: string | null;
}

/**
 * Build a structured digest summary that explicitly distinguishes complete
 * cycles from periods affected by RPC gaps, scan failures, or restarts.
 */
export function buildDigestPeriodSummary(
  events: readonly DecodedEvent[],
  options: {
    grouped?: boolean;
    completeness?: DigestPeriodCompletenessInput;
  } = {},
): DigestPeriodSummary {
  const completeness = normalizeDigestCompleteness(options.completeness);
  const groups = groupDigestEvents(events);
  const text = formatDigest(events, {
    grouped: options.grouped ?? true,
    completeness,
  });
  return {
    status: completeness.status,
    completeness,
    observedEventCount: events.length,
    groups,
    text,
  };
}
