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
import { escapeMd, formatDigest } from "./format.js";
import {
  DEFAULT_ALWAYS_SEND_EVENTS,
  isAlwaysSendEvent,
  isInQuietHours,
  resolveEventName,
  type QuietHoursPolicy,
} from "./quiet-hours.js";
import { nextAllowedWindow } from "./schedule.js";

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

/** Default bound on deferred digest entries accumulated while waiting for the allowed window. */
export const DEFAULT_MAX_DEFERRED_DIGEST_ENTRIES = 200;

export interface QuietHoursDigestDeferralOptions {
  /** Quiet-hours window and optional critical-event overrides. */
  policy: QuietHoursPolicy;
  /** Maximum number of eligible digest entries retained before dropping overflow. */
  maxEntries?: number;
  /** Group events by claim/market when rendering the digest. Defaults to `true`. */
  grouped?: boolean;
  /**
   * When `true`, non-critical events arriving outside quiet hours also return
   * `"immediate"` and only events arriving inside quiet hours enter the digest buffer.
   * Defaults to `false` (all non-critical events accumulate for digest release,
   * and digest release itself is deferred while quiet hours are active).
   */
  deferOnlyDuringQuietHours?: boolean;
}

export type DigestIngestResult =
  | { decision: "immediate"; reason: "critical" | "allowed-window"; event: DecodedEvent }
  | { decision: "deferred"; pendingCount: number }
  | { decision: "dropped"; reason: "max-entries"; overflowCount: number };

export interface DigestFlushResult {
  deferred: boolean;
  nextAllowedAtMs: number;
  events: DecodedEvent[];
  groups: DigestGroup[];
  overflowCount: number;
  pendingCount: number;
  message: string | null;
}

export interface QuietHoursDigestDeferral {
  readonly maxEntries: number;
  readonly pendingCount: number;
  readonly overflowCount: number;
  ingest(event: DecodedEvent, now?: Date | number | string): DigestIngestResult;
  flushAllowed(now: Date | number | string): DigestFlushResult;
  peek(): readonly DecodedEvent[];
}

function toEpochMs(now: Date | number | string): number {
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) throw new RangeError("Invalid Date passed to digest deferral");
    return ms;
  }
  if (typeof now === "number") {
    if (!Number.isFinite(now)) throw new RangeError("now must be a finite timestamp");
    return now;
  }
  if (typeof now === "string") {
    const parsed = Date.parse(now);
    if (!Number.isFinite(parsed)) {
      throw new RangeError(`Invalid timestamp "${now}" passed to digest deferral`);
    }
    return parsed;
  }
  throw new RangeError("Unsupported timestamp input for digest deferral");
}

function resolveCriticalEventSet(policy: QuietHoursPolicy): Set<string> {
  const custom =
    policy.alwaysSend ??
    policy.alwaysSendEvents ??
    policy.alwaysSendEventNames ??
    policy.criticalEvents;
  if (custom !== undefined) {
    return custom instanceof Set ? custom : new Set(custom);
  }
  return new Set(DEFAULT_ALWAYS_SEND_EVENTS);
}

/**
 * Coordinate bounded digest accumulation with UTC quiet-hours deferral while
 * keeping immediate critical alerts (`claim_resolved`, `market_settled`,
 * `resolved`, or policy-configured overrides) operational at all times.
 */
export function createQuietHoursDigestDeferral(
  options: QuietHoursDigestDeferralOptions,
): QuietHoursDigestDeferral {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_DEFERRED_DIGEST_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      `maxEntries must be a positive integer >= 1; got ${String(options.maxEntries)}`,
    );
  }

  const grouped = options.grouped ?? true;
  const deferOnlyDuringQuietHours = options.deferOnlyDuringQuietHours ?? false;
  let buffer: DecodedEvent[] = [];
  let overflowCount = 0;

  return {
    get maxEntries(): number {
      return maxEntries;
    },
    get pendingCount(): number {
      return buffer.length;
    },
    get overflowCount(): number {
      return overflowCount;
    },
    peek(): readonly DecodedEvent[] {
      return [...buffer];
    },
    ingest(event: DecodedEvent, now?: Date | number | string): DigestIngestResult {
      const criticalSet = resolveCriticalEventSet(options.policy);
      if (isAlwaysSendEvent(resolveEventName(event), criticalSet)) {
        return { decision: "immediate", reason: "critical", event };
      }

      if (deferOnlyDuringQuietHours && now !== undefined) {
        const atDate = typeof now === "number" ? new Date(toEpochMs(now)) : now;
        if (!isInQuietHours(options.policy, atDate)) {
          return { decision: "immediate", reason: "allowed-window", event };
        }
      }

      if (buffer.length >= maxEntries) {
        overflowCount += 1;
        return { decision: "dropped", reason: "max-entries", overflowCount };
      }

      buffer.push(event);
      return { decision: "deferred", pendingCount: buffer.length };
    },
    flushAllowed(now: Date | number | string): DigestFlushResult {
      const nowMs = toEpochMs(now);
      if (isInQuietHours(options.policy, new Date(nowMs))) {
        return {
          deferred: true,
          nextAllowedAtMs: nextAllowedWindow(options.policy, nowMs),
          events: [],
          groups: [],
          overflowCount,
          pendingCount: buffer.length,
          message: null,
        };
      }

      const drained = buffer;
      const omitted = overflowCount;
      buffer = [];
      overflowCount = 0;

      const groups = groupDigestEvents(drained);
      const baseMessage = formatDigest(drained, { grouped });
      const message =
        baseMessage !== null && omitted > 0
          ? `${baseMessage}\n\n_${escapeMd(
              `…and ${omitted} additional event${omitted === 1 ? "" : "s"} omitted (digest cap ${maxEntries})`,
            )}_`
          : baseMessage;

      return {
        deferred: false,
        nextAllowedAtMs: nowMs,
        events: drained,
        groups,
        overflowCount: omitted,
        pendingCount: 0,
        message,
      };
    },
  };
}
