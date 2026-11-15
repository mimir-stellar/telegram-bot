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
  nextChatDigestFlushMs,
  parseChatDigestPreference,
  type ChatDigestBounds,
  type ChatDigestPreference,
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

/**
 * Critical settlement and dispute events that always bypass per-chat digest
 * buffering and deliver immediately regardless of chat digest timing.
 */
export const CRITICAL_IMMEDIATE_EVENTS = [
  "claim_resolved",
  "market_settled",
  "resolved",
  "claim_challenged",
  "claim_cancelled",
] as const;

export interface PerChatDigestRouterOptions extends ChatDigestBounds {
  /** Initial per-destination schedule specs (`destination -> spec`). */
  preferences?: Readonly<Record<string, number | string>>;
  /** Maximum buffered digest events per chat (`1..2000`, default `200`). */
  maxPendingPerChat?: number;
  /** Event names treated as critical immediate notifications. */
  criticalEvents?: readonly string[];
  /** Seed UTC timestamp (ms) for interval scheduling. Defaults to `Date.now()`. */
  initialNowMs?: number;
}

export interface ImmediateChatDelivery {
  destination: string;
  event: DecodedEvent;
  reason: "critical_event" | "immediate_preference";
}

export interface FlushedChatDigest {
  destination: string;
  preference: ChatDigestPreference;
  events: DecodedEvent[];
  groups: DigestGroup[];
  droppedOverflow: number;
  text: string;
  flushedAtMs: number;
}

export interface PerChatIngestResult {
  immediateDeliveries: ImmediateChatDelivery[];
  bufferedByDestination: Record<string, number>;
}

export interface PerChatDigestRouter {
  setPreference(destination: string, spec: number | string, nowMs?: number): ChatDigestPreference;
  getPreference(destination: string): ChatDigestPreference | undefined;
  ingest(events: DecodedEvent | readonly DecodedEvent[], nowMs?: number): PerChatIngestResult;
  flushDue(nowMs: number): FlushedChatDigest[];
  pendingCount(destination: string): number;
}

function eventNameOf(event: DecodedEvent): string {
  return event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
}

/**
 * Coordinate independent per-chat digest schedules while keeping critical
 * notifications (`claim_resolved`, `market_settled`, `resolved`, etc.)
 * immediate and independent of each destination's digest interval.
 */
export function createPerChatDigestRouter(
  options: PerChatDigestRouterOptions = {},
): PerChatDigestRouter {
  const maxPendingPerChat = Math.max(1, Math.min(2_000, options.maxPendingPerChat ?? 200));
  const criticalSet = new Set(options.criticalEvents ?? CRITICAL_IMMEDIATE_EVENTS);
  const bounds: ChatDigestBounds = {
    minIntervalMs: options.minIntervalMs,
    maxIntervalMs: options.maxIntervalMs,
  };
  const seedNowMs = options.initialNowMs ?? Date.now();

  interface ChatState {
    preference: ChatDigestPreference;
    lastFlushMs: number;
    buffer: DecodedEvent[];
    droppedOverflow: number;
  }

  const states = new Map<string, ChatState>();

  function setPreference(
    destination: string,
    spec: number | string,
    nowMs: number = seedNowMs,
  ): ChatDigestPreference {
    const preference = parseChatDigestPreference(destination, spec, bounds);
    const existing = states.get(preference.destination);
    states.set(preference.destination, {
      preference,
      lastFlushMs: existing?.lastFlushMs ?? nowMs,
      buffer: existing ? existing.buffer : [],
      droppedOverflow: existing?.droppedOverflow ?? 0,
    });
    return preference;
  }

  for (const [dest, spec] of Object.entries(options.preferences ?? {})) {
    setPreference(dest, spec, seedNowMs);
  }

  return {
    setPreference,
    getPreference(destination) {
      return states.get(destination.trim())?.preference;
    },
    ingest(input) {
      const batch = Array.isArray(input) ? input : [input];
      const immediateDeliveries: ImmediateChatDelivery[] = [];
      const bufferedByDestination: Record<string, number> = {};

      for (const event of batch) {
        const isCritical = criticalSet.has(eventNameOf(event));
        for (const [destination, state] of states.entries()) {
          if (isCritical) {
            immediateDeliveries.push({
              destination,
              event,
              reason: "critical_event",
            });
            continue;
          }
          if (state.preference.mode === "immediate") {
            immediateDeliveries.push({
              destination,
              event,
              reason: "immediate_preference",
            });
            continue;
          }
          if (state.buffer.length < maxPendingPerChat) {
            state.buffer.push(event);
          } else {
            state.droppedOverflow += 1;
          }
        }
      }

      for (const [destination, state] of states.entries()) {
        bufferedByDestination[destination] = state.buffer.length;
      }
      return { immediateDeliveries, bufferedByDestination };
    },
    flushDue(nowMs: number) {
      const flushed: FlushedChatDigest[] = [];
      for (const [destination, state] of states.entries()) {
        if (state.preference.mode === "immediate") continue;
        const dueAt = nextChatDigestFlushMs(state.preference, state.lastFlushMs, nowMs);
        if (dueAt === null || nowMs < dueAt) continue;

        state.lastFlushMs = nowMs;
        if (state.buffer.length === 0) {
          state.droppedOverflow = 0;
          continue;
        }

        const events = [...state.buffer];
        const droppedOverflow = state.droppedOverflow;
        state.buffer = [];
        state.droppedOverflow = 0;

        const groups = groupDigestEvents(events);
        const text = formatDigest(events, { grouped: true }) ?? "";
        flushed.push({
          destination,
          preference: state.preference,
          events,
          groups,
          droppedOverflow,
          text,
          flushedAtMs: nowMs,
        });
      }
      return flushed;
    },
    pendingCount(destination: string) {
      return states.get(destination.trim())?.buffer.length ?? 0;
    },
  };
}
