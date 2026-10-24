/**
 * Bounded ring buffer of delivered notifications.
 *
 * Fed by one call (`record`) after each successful Telegram send so the
 * `/events` command can scroll back through recent activity. Memory use is
 * bounded by a constant: the buffer holds at most `maxEvents` entries and
 * evicts the oldest when full. Nothing is persisted across restarts.
 */

import type { ContractSource, DecodedEvent } from "../stellar/decode.js";

export interface RecentEvent {
  source: ContractSource;
  ledger: number;
  eventId: string;
  eventName: string;
  marketId: number | undefined;
  txHash: string;
  /** Ledger close time, unix seconds. */
  at: number;
}

/** Default ceiling on retained events in memory. */
export const DEFAULT_MAX_EVENTS = 1000;

export interface RecentEventsOptions {
  maxEvents?: number;
}

/**
 * Bounded FIFO ring buffer of delivered events, newest at the end of the
 * internal array. `list` returns newest first.
 */
export class RecentEvents {
  private readonly buffer: RecentEvent[] = [];
  private readonly maxEvents: number;

  constructor(options: RecentEventsOptions = {}) {
    this.maxEvents =
      typeof options.maxEvents === "number" && options.maxEvents > 0
        ? options.maxEvents
        : DEFAULT_MAX_EVENTS;
  }

  /** Record a delivered event after a successful send. */
  record(event: DecodedEvent): void {
    this.buffer.push({
      source: event.source,
      ledger: event.ledger,
      eventId: event.eventId,
      eventName:
        event.payload.name === "unknown" ? event.payload.eventName : event.payload.name,
      marketId: this.marketId(event.payload),
      txHash: event.txHash,
      at: event.at,
    });
    if (this.buffer.length > this.maxEvents) this.buffer.shift();
  }

  private marketId(payload: unknown): number | undefined {
    if (payload && typeof payload === "object" && "marketId" in payload) {
      return (payload as { marketId?: number }).marketId;
    }
    return undefined;
  }

  /**
   * Events newest first, optionally filtered by source and capped by `limit`.
   * Does not mutate the buffer.
   */
  list(options: { source?: ContractSource; limit?: number } = {}): RecentEvent[] {
    let limit =
      typeof options.limit === "number" && options.limit > 0 ? options.limit : this.buffer.length;
    const filtered = options.source
      ? this.buffer.filter((e) => e.source === options.source)
      : this.buffer;
    return filtered.slice().reverse().slice(0, limit);
  }

  /** Number of events currently retained. */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear all retained events (mainly for tests). */
  clear(): void {
    this.buffer.length = 0;
  }
}

/** Shared buffer fed by the poller after successful sends and read by /events. */
export const recentEvents = new RecentEvents();
