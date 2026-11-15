/**
 * Bounded in-memory ring of canonical event summaries retained from recent
 * poller cycles for `/events`.
 *
 * Strictly in-memory: never reads or writes arbitrary filesystem paths.
 */

import type { StellarConfig } from "./config.js";
import { clip, formatPlainTextEvent } from "./notifications/format.js";
import { txExplorerUrl } from "./stellar/client.js";
import {
  summarizePayloadForLog,
  type ContractSource,
  type DecodedEvent,
} from "./stellar/decode.js";

/** Default maximum number of canonical event summaries retained in memory. */
export const DEFAULT_RECENT_EVENTS_CAPACITY = 50;

/** Maximum character length of a single retained canonical summary string. */
export const MAX_EVENT_SUMMARY_CHARS = 160;

/** Compact, canonical, serializable summary of a decoded contract event. */
export interface CanonicalEventSummary {
  readonly eventId: string;
  readonly source: ContractSource;
  readonly eventName: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly at: number;
  readonly summary: string;
  readonly explorerUrl: string | null;
}

export interface RecentEventRing {
  record(event: DecodedEvent | CanonicalEventSummary, config?: StellarConfig): void;
  recordAll(
    events: readonly (DecodedEvent | CanonicalEventSummary)[],
    config?: StellarConfig,
  ): void;
  /** Retained canonical summaries ordered newest-first. */
  entries(): readonly CanonicalEventSummary[];
  size(): number;
  readonly capacity: number;
  clear(): void;
}

function safeHttpsExplorerUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function compactSingleLine(text: string, maxChars: number = MAX_EVENT_SUMMARY_CHARS): string {
  const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return clip(cleaned, maxChars);
}

/** True when `value` already conforms to {@link CanonicalEventSummary}. */
export function isCanonicalEventSummary(value: unknown): value is CanonicalEventSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === "string" &&
    (candidate.source === "market" || candidate.source === "squad") &&
    typeof candidate.eventName === "string" &&
    typeof candidate.ledger === "number" &&
    typeof candidate.txHash === "string" &&
    typeof candidate.at === "number" &&
    typeof candidate.summary === "string" &&
    (candidate.explorerUrl === null || typeof candidate.explorerUrl === "string")
  );
}

/** Convert a {@link DecodedEvent} into a bounded {@link CanonicalEventSummary}. */
export function toCanonicalEventSummary(
  event: DecodedEvent,
  config?: StellarConfig,
): CanonicalEventSummary {
  const eventName =
    event.payload.name === "unknown"
      ? event.payload.eventName || "unknown"
      : event.payload.name;

  let rawSummary: string | null = null;
  if (config) {
    try {
      const plain = formatPlainTextEvent(config, event);
      if (plain) {
        const firstLine = plain.split(/\r?\n/)[0] ?? plain;
        rawSummary = firstLine;
      }
    } catch {
      rawSummary = null;
    }
  }

  if (!rawSummary) {
    rawSummary = `${eventName} — ${summarizePayloadForLog(event.payload, 120)}`;
  }

  let explorerUrl: string | null = null;
  if (config && event.txHash) {
    try {
      explorerUrl = safeHttpsExplorerUrl(txExplorerUrl(config, event.txHash));
    } catch {
      explorerUrl = null;
    }
  }

  return {
    eventId: String(event.eventId ?? `${event.ledger}-${event.txHash}`),
    source: event.source,
    eventName: compactSingleLine(eventName, 64),
    ledger: Number.isFinite(event.ledger) ? event.ledger : 0,
    txHash: typeof event.txHash === "string" ? event.txHash : "",
    at: Number.isFinite(event.at) ? event.at : 0,
    summary: compactSingleLine(rawSummary, MAX_EVENT_SUMMARY_CHARS),
    explorerUrl,
  };
}

/** Create a bounded in-memory ring of {@link CanonicalEventSummary} items. */
export function createRecentEventRing(
  capacity: number = DEFAULT_RECENT_EVENTS_CAPACITY,
): RecentEventRing {
  const maxEntries = Number.isFinite(capacity)
    ? Math.max(0, Math.floor(capacity))
    : DEFAULT_RECENT_EVENTS_CAPACITY;

  // Insertion-ordered Map keyed by `<source>:<eventId>` so duplicates update in place.
  const store = new Map<string, CanonicalEventSummary>();

  function recordOne(
    input: DecodedEvent | CanonicalEventSummary,
    config?: StellarConfig,
  ): void {
    if (maxEntries === 0 || !input || typeof input !== "object") return;
    const summary = isCanonicalEventSummary(input)
      ? {
          ...input,
          eventName: compactSingleLine(input.eventName, 64),
          summary: compactSingleLine(input.summary, MAX_EVENT_SUMMARY_CHARS),
          explorerUrl: input.explorerUrl ? safeHttpsExplorerUrl(input.explorerUrl) : null,
        }
      : toCanonicalEventSummary(input, config);

    const key = `${summary.source}:${summary.eventId}`;
    if (store.has(key)) {
      store.delete(key);
    } else if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) {
        store.delete(oldestKey);
      }
    }
    store.set(key, summary);
  }

  return {
    capacity: maxEntries,
    record(event, config) {
      recordOne(event, config);
    },
    recordAll(events, config) {
      for (const event of events) {
        recordOne(event, config);
      }
    },
    entries() {
      const items = [...store.values()];
      // Sort newest-first by ledger descending, preserving newest insertion order on ties.
      return items
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) =>
          b.item.ledger !== a.item.ledger ? b.item.ledger - a.item.ledger : b.idx - a.idx,
        )
        .map(({ item }) => item);
    },
    size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
}
