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

import {
  compareEvents,
  scanJsonReplacer,
  sortEvents,
  type DecodedEvent,
} from "../stellar/decode.js";
import {
  createDigestPeriodBounds,
  digestPeriodForSchedule,
  isWithinDigestPeriod,
  type DigestPeriodBounds,
  type Schedule,
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

export interface DigestExportOptions {
  /** Explicit inclusive start boundary (UTC ms or strict `...Z` ISO-8601 string). */
  periodStart?: number | string;
  /** Explicit exclusive end boundary (UTC ms or strict `...Z` ISO-8601 string). */
  periodEnd?: number | string;
  /** Pre-validated period bounds (alternative to `periodStart`/`periodEnd` or `schedule`). */
  bounds?: DigestPeriodBounds;
  /** Schedule used with `periodEnd` when `periodStart` is derived from cadence. */
  schedule?: Schedule | string;
  /**
   * Filter `events` by half-open `[periodStartMs, periodEndMs)` using `event.at`
   * (chain close time in unix seconds). Defaults to `true`.
   */
  filterByPeriod?: boolean;
}

export interface DigestExport {
  /** Inclusive UTC start timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  periodStartUtc: string;
  /** Exclusive UTC end timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  periodEndUtc: string;
  /** Inclusive UTC start epoch milliseconds. */
  periodStartMs: number;
  /** Exclusive UTC end epoch milliseconds. */
  periodEndMs: number;
  /** Explicit boundary contract (`[start, end)`). */
  inclusivity: "[start, end)";
  /** Always `"UTC"` regardless of host `TZ`. */
  timezone: "UTC";
  /** Total number of exported events across all groups. */
  eventCount: number;
  /** Deterministic grouped events within `[periodStartUtc, periodEndUtc)`. */
  groups: DigestGroup[];
}

function resolveExportBounds(options: DigestExportOptions): DigestPeriodBounds {
  if (options.bounds) {
    return createDigestPeriodBounds(options.bounds.periodStartMs, options.bounds.periodEndMs);
  }
  if (options.periodStart !== undefined && options.periodEnd !== undefined) {
    return createDigestPeriodBounds(options.periodStart, options.periodEnd);
  }
  if (options.schedule !== undefined && options.periodEnd !== undefined) {
    return digestPeriodForSchedule(options.schedule, options.periodEnd);
  }
  throw new TypeError(
    "exportDigest requires `bounds`, both `periodStart` and `periodEnd`, or `schedule` with `periodEnd`",
  );
}

/**
 * Build a deterministic, timezone-invariant digest export with explicit
 * start-inclusive and end-exclusive (`[periodStartUtc, periodEndUtc)`) boundaries.
 */
export function exportDigest(
  events: readonly DecodedEvent[],
  options: DigestExportOptions,
): DigestExport {
  const bounds = resolveExportBounds(options);
  const filterByPeriod = options.filterByPeriod ?? true;
  const matching = filterByPeriod
    ? events.filter((event) => isWithinDigestPeriod(event.at, bounds, "seconds"))
    : [...events];
  const groups = groupDigestEvents(matching);

  return {
    periodStartUtc: bounds.periodStartUtc,
    periodEndUtc: bounds.periodEndUtc,
    periodStartMs: bounds.periodStartMs,
    periodEndMs: bounds.periodEndMs,
    inclusivity: bounds.inclusivity,
    timezone: bounds.timezone,
    eventCount: matching.length,
    groups,
  };
}

/**
 * Serialize a {@link DigestExport} deterministically as UTF-8 JSON (with `bigint`
 * values encoded as decimal strings).
 */
export function serializeDigestExport(digest: DigestExport): string {
  return JSON.stringify(digest, scanJsonReplacer, 2);
}
