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
import { escapeMd, formatDigest, type FormatDigestOptions } from "./format.js";
import { describePendingScheduleWindow, type Schedule } from "./schedule.js";

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

export const DEFAULT_PENDING_DIGEST_CAP = 500;

export interface PendingDigestSnapshot {
  /** Snapshot of queued events in the current pending digest window. */
  events: readonly DecodedEvent[];
  /** Optional UTC millisecond timestamp when the current window opened. */
  windowStartedAtMs?: number | null;
  /** Optional active schedule spec or parsed schedule. */
  schedule?: Schedule | string;
  /** Count of overflow events dropped if the pending cap was reached. */
  droppedCount?: number;
}

export interface PendingDigestWindow {
  append(events: DecodedEvent | readonly DecodedEvent[]): void;
  /** Non-destructive snapshot of the pending digest window (does not consume events). */
  peek(): PendingDigestSnapshot;
  /** Consume and reset the pending digest window for scheduled delivery. */
  drain(nowMs?: number): PendingDigestSnapshot;
  size(): number;
}

export interface PendingDigestWindowOptions {
  schedule?: Schedule | string;
  maxEvents?: number;
  now?: () => number;
}

export function createPendingDigestWindow(
  options: PendingDigestWindowOptions = {},
): PendingDigestWindow {
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_PENDING_DIGEST_CAP);
  const now = options.now ?? Date.now;
  let buffer: DecodedEvent[] = [];
  let windowStartedAtMs: number | null = null;
  let droppedCount = 0;

  return {
    append(input) {
      const items = Array.isArray(input) ? input : [input];
      if (items.length === 0) return;
      if (windowStartedAtMs === null) {
        windowStartedAtMs = now();
      }
      for (const item of items) {
        if (buffer.length < maxEvents) {
          buffer.push(item);
        } else {
          droppedCount += 1;
        }
      }
    },
    peek() {
      return {
        events: [...buffer],
        windowStartedAtMs,
        schedule: options.schedule,
        droppedCount,
      };
    },
    drain(nowMs = now()) {
      const snapshot: PendingDigestSnapshot = {
        events: [...buffer],
        windowStartedAtMs,
        schedule: options.schedule,
        droppedCount,
      };
      buffer = [];
      windowStartedAtMs = nowMs;
      droppedCount = 0;
      return snapshot;
    },
    size() {
      return buffer.length;
    },
  };
}

export interface OperatorDigestPreviewOptions {
  grouped?: boolean;
  nowMs?: number;
}

function isPendingDigestWindow(
  source: PendingDigestWindow | PendingDigestSnapshot,
): source is PendingDigestWindow {
  return typeof (source as PendingDigestWindow).peek === "function";
}

/**
 * Render an operator-facing MarkdownV2 preview of the current pending digest
 * window using the live {@link formatDigest} / {@link groupDigestEvents}
 * pipeline without consuming or mutating queued events.
 */
export function renderOperatorDigestPreview(
  source: PendingDigestWindow | PendingDigestSnapshot,
  options: OperatorDigestPreviewOptions = {},
): string {
  const snapshot = isPendingDigestWindow(source) ? source.peek() : source;
  const events = [...snapshot.events];
  const grouped = options.grouped ?? true;
  const formatOpts: FormatDigestOptions = { grouped };
  const groupCount = groupDigestEvents(events).length;
  const headerLines = [
    `*${escapeMd("[PREVIEW MODE]")}* — Pending Digest Window`,
    escapeMd(
      `Pending events: ${events.length} (${groupCount} ${groupCount === 1 ? "group" : "groups"})`,
    ),
  ];

  if (snapshot.schedule !== undefined) {
    const windowInfo = describePendingScheduleWindow(
      snapshot.schedule,
      options.nowMs ?? Date.now(),
      snapshot.windowStartedAtMs,
    );
    if (windowInfo.windowStartUtc) {
      headerLines.push(escapeMd(`Window start (UTC): ${windowInfo.windowStartUtc}`));
    }
    headerLines.push(escapeMd(`Next scheduled flush (UTC): ${windowInfo.nextFlushUtc}`));
  }

  if ((snapshot.droppedCount ?? 0) > 0) {
    headerLines.push(
      escapeMd(`Overflow omitted from pending window: ${snapshot.droppedCount}`),
    );
  }

  const liveDigest = formatDigest(events, formatOpts);
  if (liveDigest === null) {
    return [...headerLines, "", `_${escapeMd("No pending events in the current digest window.")}_`].join("\n");
  }

  return [...headerLines, "", liveDigest].join("\n");
}
