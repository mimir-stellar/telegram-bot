/**
 * Inline query handling and bounded recent events store.
 *
 * Lets users type `@bot 42` or `@bot text` in any Telegram chat to share
 * a recent claim or squad market's summary as an InlineQueryResultArticle.
 */

import { InlineQueryResultBuilder, type Context } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import type { BotConfig, StellarConfig } from "../config.js";
import { formatEvent, formatPlainTextEvent, explorerKeyboard } from "../notifications/format.js";
import type { DecodedEvent } from "../stellar/decode.js";

/** Default maximum number of recent events retained in memory. */
export const DEFAULT_RECENT_EVENTS_CAPACITY = 50;

/** Maximum allowed character length for an inline query. */
export const MAX_INLINE_QUERY_LENGTH = 128;

/** Default cache time in seconds for inline query answers. */
export const DEFAULT_INLINE_CACHE_TIME = 10;

/**
 * Extract claimId or marketId as a string from a decoded event payload, if present.
 */
export function getEventId(event: DecodedEvent): string | null {
  const payload = event.payload as unknown as Record<string, unknown>;
  if (!payload || typeof payload !== "object") return null;

  if (typeof payload.claimId === "bigint" || typeof payload.claimId === "number") {
    return String(payload.claimId);
  }
  if (typeof payload.claimId === "string" && payload.claimId.trim().length > 0) {
    return payload.claimId.trim();
  }
  if (typeof payload.marketId === "bigint" || typeof payload.marketId === "number") {
    return String(payload.marketId);
  }
  if (typeof payload.marketId === "string" && payload.marketId.trim().length > 0) {
    return payload.marketId.trim();
  }
  return null;
}

/**
 * Bounded store of recently delivered contract events.
 * Older entries are automatically evicted when capacity is reached.
 */
export class RecentEventsStore {
  private readonly capacity: number;
  private readonly events: DecodedEvent[] = [];

  constructor(capacity = DEFAULT_RECENT_EVENTS_CAPACITY) {
    this.capacity = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : DEFAULT_RECENT_EVENTS_CAPACITY;
  }

  /**
   * Add a delivered event. If capacity is exceeded, older events are evicted (FIFO).
   */
  add(event: DecodedEvent): void {
    if (!event || typeof event !== "object") return;
    this.events.unshift(event);
    if (this.events.length > this.capacity) {
      this.events.length = this.capacity;
    }
  }

  /**
   * Return the latest events up to `limit`.
   */
  getRecent(limit = 10): readonly DecodedEvent[] {
    const safeLimit = Math.max(0, limit);
    return this.events.slice(0, safeLimit);
  }

  /**
   * Find an event matching the given claimId or marketId.
   */
  findById(id: string | number | bigint): DecodedEvent | null {
    const idStr = String(id).trim();
    if (!idStr) return null;
    for (const e of this.events) {
      if (getEventId(e) === idStr) {
        return e;
      }
    }
    return null;
  }

  /**
   * Find events whose payload (e.g. category, question, creator, or name) includes the query text.
   */
  findByText(query: string, limit = 5): readonly DecodedEvent[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: DecodedEvent[] = [];
    for (const e of this.events) {
      const p = e.payload as unknown as Record<string, unknown>;
      const match =
        (typeof p.name === "string" && p.name.toLowerCase().includes(q)) ||
        (typeof p.category === "string" && p.category.toLowerCase().includes(q)) ||
        (typeof p.question === "string" && p.question.toLowerCase().includes(q)) ||
        (typeof p.summary === "string" && p.summary.toLowerCase().includes(q)) ||
        (typeof p.creator === "string" && p.creator.toLowerCase().includes(q)) ||
        (typeof p.challenger === "string" && p.challenger.toLowerCase().includes(q)) ||
        (typeof p.participant === "string" && p.participant.toLowerCase().includes(q)) ||
        (getEventId(e) === q);
      if (match) {
        results.push(e);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** Current number of events in the store. */
  size(): number {
    return this.events.length;
  }

  /** Clear all events. */
  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Sanitize and bound the query string.
 */
export function sanitizeQuery(rawQuery: unknown): string {
  if (typeof rawQuery !== "string") return "";
  return rawQuery.trim().slice(0, MAX_INLINE_QUERY_LENGTH);
}

/**
 * Format a single DecodedEvent into an InlineQueryResultArticle.
 */
export function buildArticleResult(
  event: DecodedEvent,
  config?: StellarConfig,
): InlineQueryResultArticle | null {
  const stellarCfg: StellarConfig = config ?? {
    networkPassphrase: "",
    marketContractId: "",
    squadContractId: "",
    marketContractVersion: "1.0.0",
    squadContractVersion: "1.0.0",
    rpcUrl: "",
    horizonUrl: "",
    explorerBaseUrl: "",
  };

  const id = getEventId(event) ?? `${event.source}-${event.ledger}-${event.eventId ?? Math.random()}`;
  const eventName = event.payload?.name ? String(event.payload.name) : "event";
  const title = getEventId(event) ? `Claim #${id} (${eventName})` : `Event: ${eventName}`;

  const mdText = formatEvent(stellarCfg, event);
  const plainText = formatPlainTextEvent(stellarCfg, event) ?? title;
  const keyboard = explorerKeyboard(stellarCfg, event);

  const articleId = `${event.eventId ?? `${event.ledger}-${event.source}-${eventName}`}-${id}`;

  if (mdText) {
    const builder = InlineQueryResultBuilder.article(articleId, title, {
      description: plainText.slice(0, 100),
      reply_markup: keyboard,
    }).text(mdText, { parse_mode: "MarkdownV2" });
    return builder as unknown as InlineQueryResultArticle;
  } else {
    const builder = InlineQueryResultBuilder.article(articleId, title, {
      description: plainText.slice(0, 100),
      reply_markup: keyboard,
    }).text(plainText);
    return builder as unknown as InlineQueryResultArticle;
  }
}

/**
 * Build inline query result items based on query string and recent store.
 *
 * - Empty or invalid queries return the latest few events.
 * - Digits queries search by claimId / marketId first.
 * - Text queries search across payload fields.
 * - If search yields no matches, fall back to the latest few events.
 */
export function inlineResults(
  query: string,
  store: RecentEventsStore,
  config?: StellarConfig,
  limit = 5,
): InlineQueryResultArticle[] {
  const sanitized = sanitizeQuery(query);
  let matchedEvents: DecodedEvent[] = [];

  if (!sanitized) {
    matchedEvents = [...store.getRecent(limit)];
  } else if (/^\d+$/.test(sanitized)) {
    const byId = store.findById(sanitized);
    if (byId) {
      matchedEvents = [byId];
    } else {
      matchedEvents = [...store.findByText(sanitized, limit)];
    }
  } else {
    matchedEvents = [...store.findByText(sanitized, limit)];
  }

  // If query yielded no events, return latest few
  if (matchedEvents.length === 0) {
    matchedEvents = [...store.getRecent(limit)];
  }

  const results: InlineQueryResultArticle[] = [];
  for (const ev of matchedEvents) {
    const article = buildArticleResult(ev, config);
    if (article) {
      results.push(article);
    }
  }

  return results;
}

/**
 * Handle incoming inline queries from Telegram.
 */
export async function handleInlineQuery(
  ctx: Context,
  store: RecentEventsStore,
  config?: BotConfig,
): Promise<void> {
  const query = ctx.inlineQuery?.query ?? "";
  const results = inlineResults(query, store, config);
  await ctx.answerInlineQuery(results, {
    cache_time: DEFAULT_INLINE_CACHE_TIME,
    is_personal: false,
  });
}
