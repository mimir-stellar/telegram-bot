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
import { reviveDecodedEvent } from "../stellar/scan-reviver.js";

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

/** Current schema version for persisted poller digest checkpoints. */
export const DIGEST_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Default cap on buffered pending events between scheduled digest runs. */
export const DEFAULT_DIGEST_MAX_PENDING = 200 as const;

export interface DigestCheckpointFile {
  version: typeof DIGEST_CHECKPOINT_SCHEMA_VERSION;
  updatedAt: string;
  schedule: string;
  lastFlushAt: number | null;
  nextFlushAt: number;
  droppedCount: number;
  pendingEvents: DecodedEvent[];
}

function digestJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function isValidDecodedEventShape(value: unknown): value is DecodedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source !== "market" && obj.source !== "squad") return false;
  if (typeof obj.contractId !== "string") return false;
  if (typeof obj.ledger !== "number" || !Number.isSafeInteger(obj.ledger) || obj.ledger < 0) {
    return false;
  }
  if (typeof obj.eventId !== "string" || obj.eventId.length === 0) return false;
  if (obj.payload === null || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
    return false;
  }
  const payload = obj.payload as Record<string, unknown>;
  return typeof payload.name === "string" && payload.name.length > 0;
}

/**
 * Serialize a bounded digest checkpoint to JSON, converting bigint amounts to
 * decimal strings and enforcing `maxPending` before writing.
 */
export function serializeDigestCheckpoint(
  checkpoint: DigestCheckpointFile,
  maxPending: number = DEFAULT_DIGEST_MAX_PENDING,
): string {
  const cap = Math.max(1, Math.trunc(maxPending));
  const excess = Math.max(0, checkpoint.pendingEvents.length - cap);
  const bounded: DigestCheckpointFile = {
    version: DIGEST_CHECKPOINT_SCHEMA_VERSION,
    updatedAt: checkpoint.updatedAt,
    schedule: checkpoint.schedule,
    lastFlushAt: checkpoint.lastFlushAt,
    nextFlushAt: checkpoint.nextFlushAt,
    droppedCount: Math.max(0, Math.trunc(checkpoint.droppedCount)) + excess,
    pendingEvents: checkpoint.pendingEvents.slice(0, cap),
  };
  return `${JSON.stringify(bounded, digestJsonReplacer, 2)}\n`;
}

/**
 * Parse, validate, and revive a persisted digest checkpoint, bounding restored
 * pending events to `maxPending` and folding any excess into `droppedCount`.
 */
export function parseDigestCheckpoint(
  raw: string,
  maxPending: number = DEFAULT_DIGEST_MAX_PENDING,
): DigestCheckpointFile {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsedUnknown === null || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new Error("digest checkpoint root must be a JSON object");
  }
  const parsed = parsedUnknown as Record<string, unknown>;
  if (parsed.version !== DIGEST_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `digest checkpoint: unsupported schema version ${String(parsed.version)} ` +
        `(expected ${DIGEST_CHECKPOINT_SCHEMA_VERSION})`,
    );
  }
  if (typeof parsed.updatedAt !== "string") {
    throw new Error("digest checkpoint: updatedAt must be a string");
  }
  if (typeof parsed.schedule !== "string" || parsed.schedule.trim() === "") {
    throw new Error("digest checkpoint: schedule must be a non-empty string");
  }
  if (
    parsed.lastFlushAt !== null &&
    (typeof parsed.lastFlushAt !== "number" ||
      !Number.isSafeInteger(parsed.lastFlushAt) ||
      parsed.lastFlushAt < 0)
  ) {
    throw new Error("digest checkpoint: lastFlushAt must be a non-negative integer or null");
  }
  if (
    typeof parsed.nextFlushAt !== "number" ||
    !Number.isSafeInteger(parsed.nextFlushAt) ||
    parsed.nextFlushAt <= 0
  ) {
    throw new Error("digest checkpoint: nextFlushAt must be a positive integer");
  }
  if (
    typeof parsed.droppedCount !== "number" ||
    !Number.isSafeInteger(parsed.droppedCount) ||
    parsed.droppedCount < 0
  ) {
    throw new Error("digest checkpoint: droppedCount must be a non-negative integer");
  }
  if (!Array.isArray(parsed.pendingEvents)) {
    throw new Error("digest checkpoint: pendingEvents must be an array");
  }

  const revived: DecodedEvent[] = [];
  for (const item of parsed.pendingEvents) {
    if (!isValidDecodedEventShape(item)) {
      throw new Error("digest checkpoint: malformed event entry in pendingEvents");
    }
    revived.push(reviveDecodedEvent(item));
  }

  const cap = Math.max(1, Math.trunc(maxPending));
  const excess = Math.max(0, revived.length - cap);

  return {
    version: DIGEST_CHECKPOINT_SCHEMA_VERSION,
    updatedAt: parsed.updatedAt,
    schedule: parsed.schedule.trim(),
    lastFlushAt: parsed.lastFlushAt,
    nextFlushAt: parsed.nextFlushAt,
    droppedCount: parsed.droppedCount + excess,
    pendingEvents: revived.slice(0, cap),
  };
}
