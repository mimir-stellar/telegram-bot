/**
 * `/events`: bounded, read-only lookup of retained canonical event summaries.
 *
 * Reads only from the in-memory retained event summaries (or poller status),
 * never from the filesystem or arbitrary user-supplied paths, and paginates
 * results safely within Telegram's message limits.
 */

import type { StellarConfig } from "../config.js";
import { eventKey } from "../dedup.js";
import { networkLabel } from "../config.js";
import { escapeMd } from "../notifications/format.js";
import { pageKeyboard, paginate } from "../notifications/pagination.js";
import { txExplorerUrl } from "../stellar/client.js";
import {
  SQUAD_SIDE,
  formatUsdc,
  shortAddress,
  winnerSideLabel,
  type ContractSource,
  type DecodedEvent,
} from "../stellar/decode.js";
import { defineCommand, type CommandDeps } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

/** Default maximum number of canonical event summaries retained in memory. */
export const DEFAULT_MAX_RETAINED_EVENTS = 100;

/** Number of event summaries shown per page. */
export const EVENTS_PAGE_SIZE = 5;

/** Maximum character length of a single canonical event summary line. */
export const MAX_EVENT_SUMMARY_CHARS = 160;

/** Upper bound on user-supplied 1-based page numbers. */
export const MAX_EVENT_PAGE_ARG = 10_000;

/** Usage reply when `/events` receives an invalid page argument. */
export const EVENTS_USAGE_MESSAGE =
  "*Usage:* `/events [page]`\nPlease provide a positive integer page number\\.";

/** Bounded, canonical summary of an observed contract event. */
export interface CanonicalEventSummary {
  /** Canonical event key (from `eventKey`, or a bounded fallback). */
  readonly id: string;
  readonly source: ContractSource;
  readonly ledger: number;
  readonly at: number;
  readonly eventId: string;
  readonly txHash: string;
  readonly eventName: string;
  /** Bounded single-line plain-text summary. */
  readonly summary: string;
}

/**
 * Strip control/bidi characters, collapse whitespace, and clip to `maxChars`
 * code points without splitting surrogate pairs.
 */
export function sanitizeSummaryText(
  raw: string,
  maxChars: number = MAX_EVENT_SUMMARY_CHARS,
): string {
  // Strip ASCII control chars (\x00-\x1F, \x7F) and Unicode bidi overrides.
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

/** Return the canonical event name for a decoded event. */
export function canonicalEventName(event: DecodedEvent): string {
  if (event.payload.name === "unknown") {
    return sanitizeSummaryText(event.payload.eventName || "unknown", 64) || "unknown";
  }
  return event.payload.name;
}

/** Build a concise, bounded plain-text summary for a decoded event. */
export function summarizeDecodedEvent(event: DecodedEvent): string {
  const p = event.payload;
  let raw: string;
  switch (p.name) {
    case "claim_created":
      raw = `claim #${p.claimId} (${p.category}) by ${shortAddress(p.creator)}`;
      break;
    case "claim_challenged":
      raw = `claim #${p.claimId} challenged (${formatUsdc(p.stake)}) by ${shortAddress(p.challenger)}`;
      break;
    case "claim_resolved":
      raw = `claim #${p.claimId} resolved: ${winnerSideLabel(p.winnerSide)} (${p.confidence}%)`;
      break;
    case "claim_cancelled":
      raw = `claim #${p.claimId} cancelled`;
      break;
    case "market_settled":
      raw = `claim #${p.claimId} settled (${formatUsdc(p.totalPaid)} paid, ${formatUsdc(p.totalFees)} fees)`;
      break;
    case "challenger_paid":
      raw = `claim #${p.claimId} challenger ${shortAddress(p.challenger)} paid ${formatUsdc(p.net)}`;
      break;
    case "fee_claimed":
      raw = `fees ${formatUsdc(p.amount)} claimed by ${shortAddress(p.recipient)}`;
      break;
    case "withdrawal":
      raw = `withdrawal ${formatUsdc(p.amount)} to ${shortAddress(p.to)}`;
      break;
    case "withdrawal_pending":
      raw = `withdrawal pending ${formatUsdc(p.amount)} to ${shortAddress(p.to)}`;
      break;
    case "market_created":
      raw = `squad #${p.marketId} created by ${shortAddress(p.captain)}`;
      break;
    case "deposited":
      raw = `squad #${p.marketId} deposit ${formatUsdc(p.amount)} by ${shortAddress(p.participant)}`;
      break;
    case "withdrawn":
      raw = `squad #${p.marketId} withdrawal ${formatUsdc(p.amount)} by ${shortAddress(p.participant)}`;
      break;
    case "resolved": {
      const side = SQUAD_SIDE[p.result] ?? String(p.result);
      raw = `squad #${p.marketId} resolved (${side})`;
      break;
    }
    case "claimed":
      raw = `squad #${p.marketId} claimed ${formatUsdc(p.net)} by ${shortAddress(p.participant)}`;
      break;
    case "fees_claimed":
      raw = `squad fees ${formatUsdc(p.amount)} claimed by ${shortAddress(p.recipient)}`;
      break;
    case "unknown":
      raw = p.eventName ? `event ${p.eventName}` : "unrecognized event";
      break;
    default: {
      const name = "name" in p ? String((p as { name: unknown }).name) : "event";
      raw = name.replace(/_/g, " ");
      break;
    }
  }
  return sanitizeSummaryText(raw, MAX_EVENT_SUMMARY_CHARS) || "contract event";
}

/** Convert a {@link DecodedEvent} into a bounded {@link CanonicalEventSummary}. */
export function toCanonicalEventSummary(event: DecodedEvent): CanonicalEventSummary {
  const canonicalId =
    eventKey(event) ??
    `${event.source}:${event.ledger}:${event.eventId || "unknown"}`;
  return {
    id: sanitizeSummaryText(canonicalId, 256) || `${event.source}:${event.ledger}`,
    source: event.source,
    ledger: Number.isSafeInteger(event.ledger) && event.ledger >= 0 ? event.ledger : 0,
    at: typeof event.at === "number" && Number.isFinite(event.at) && event.at > 0 ? event.at : 0,
    eventId: sanitizeSummaryText(event.eventId ?? "", 128),
    txHash: sanitizeSummaryText(event.txHash ?? "", 128),
    eventName: canonicalEventName(event),
    summary: summarizeDecodedEvent(event),
  };
}

/**
 * Bounded in-memory store of recent canonical event summaries.
 *
 * Deduplicates by canonical `id` and evicts the oldest entries when capacity
 * is reached.
 */
export class RecentEventStore {
  readonly maxEntries: number;
  private readonly entries = new Map<string, CanonicalEventSummary>();

  constructor(maxEntries: number = DEFAULT_MAX_RETAINED_EVENTS) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : DEFAULT_MAX_RETAINED_EVENTS;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Record a batch of decoded events into the bounded store. */
  record(events: readonly DecodedEvent[]): void {
    if (this.maxEntries === 0 || !events || events.length === 0) return;
    for (const event of events) {
      this.recordSummary(toCanonicalEventSummary(event));
    }
  }

  /** Record a single pre-built canonical event summary. */
  recordSummary(summary: CanonicalEventSummary): void {
    if (this.maxEntries === 0) return;
    if (this.entries.has(summary.id)) {
      this.entries.delete(summary.id);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(summary.id, summary);
  }

  /** Return retained summaries ordered newest-first (descending by ledger). */
  list(): readonly CanonicalEventSummary[] {
    // Map iterates oldest-inserted to newest-inserted; reverse so recency
    // breaks ledger ties newest-first.
    const reversed = [...this.entries.values()].reverse();
    return reversed.sort((a, b) => b.ledger - a.ledger || b.at - a.at);
  }

  clear(): void {
    this.entries.clear();
  }
}

export type ParseEventsPageResult =
  | { ok: true; page: number }
  | { ok: false; reason: "invalid-page" };

/**
 * Parse the optional 1-based page argument from `/events [page]`.
 * Strictly rejects non-integer, zero, negative, or path-like arguments.
 */
export function parseEventsPageArg(text?: string | null): ParseEventsPageResult {
  if (text === undefined || text === null) return { ok: true, page: 1 };
  let trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) return { ok: true, page: 1 };
    trimmed = trimmed.slice(spaceIdx).trim();
  }
  if (trimmed === "") return { ok: true, page: 1 };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "invalid-page" };
  }
  const page = Number(trimmed);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_EVENT_PAGE_ARG) {
    return { ok: false, reason: "invalid-page" };
  }
  return { ok: true, page };
}

/**
 * Resolve retained canonical event summaries from `CommandDeps`, falling back
 * to `status.targets[].lastEvent` when `recentEvents` is omitted.
 */
export function resolveRecentEvents(
  deps: Pick<CommandDeps, "status" | "recentEvents">,
): readonly CanonicalEventSummary[] {
  if (deps.recentEvents !== undefined) {
    return typeof deps.recentEvents === "function" ? deps.recentEvents() : deps.recentEvents;
  }
  const status = deps.status();
  const fallback: CanonicalEventSummary[] = [];
  for (const target of status.targets ?? []) {
    if (target.lastEvent) {
      fallback.push(toCanonicalEventSummary(target.lastEvent));
    }
  }
  return fallback.sort((a, b) => b.ledger - a.ledger || b.at - a.at);
}

/** Compute a clamped page slice from canonical event summaries. */
export function eventsPage(
  summaries: readonly CanonicalEventSummary[],
  requestedPageIndex: number,
  pageSize: number = EVENTS_PAGE_SIZE,
): {
  items: readonly CanonicalEventSummary[];
  pageIndex: number;
  totalPages: number;
  totalItems: number;
} {
  if (summaries.length === 0) {
    return { items: [], pageIndex: 0, totalPages: 0, totalItems: 0 };
  }
  const pages = paginate(summaries, pageSize);
  const totalPages = pages.length;
  const safeIndex = Number.isInteger(requestedPageIndex)
    ? Math.min(Math.max(0, requestedPageIndex), totalPages - 1)
    : 0;
  return {
    items: pages[safeIndex] ?? [],
    pageIndex: safeIndex,
    totalPages,
    totalItems: summaries.length,
  };
}

/** Render a MarkdownV2 page of retained canonical event summaries. */
export function eventsMessage(
  config: StellarConfig,
  summaries: readonly CanonicalEventSummary[],
  requestedPageIndex: number = 0,
): string {
  const network = escapeMd(networkLabel(config));
  if (summaries.length === 0) {
    return (
      `*Recent events* — Stellar ${network}\n\n` +
      `No recent events have been observed since this process started\\.`
    );
  }

  const { items, pageIndex, totalPages, totalItems } = eventsPage(
    summaries,
    requestedPageIndex,
  );
  const header =
    `*Recent events* — Stellar ${network} ` +
    `\\(page ${pageIndex + 1}/${totalPages}, ${totalItems} retained\\)`;

  const lines = items.map((item) => {
    const url = item.txHash ? txExplorerUrl(config, item.txHash) : "";
    const txPart = url ? ` · [tx](${url})` : "";
    return (
      `· *mimir\\-${escapeMd(item.source)}* \`${escapeMd(item.eventName)}\` ` +
      `\\(ledger ${item.ledger}${txPart}\\) — ${escapeMd(item.summary)}`
    );
  });

  return [header, "", ...lines].join("\n");
}

export const eventsCommand = defineCommand({
  command: "events",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const parsed = parseEventsPageArg(ctx.message?.text);
    if (!parsed.ok) {
      await ctx.reply(EVENTS_USAGE_MESSAGE, TELEGRAM_OPTIONS);
      return;
    }

    const summaries = resolveRecentEvents(deps);
    const { pageIndex, totalPages } = eventsPage(summaries, parsed.page - 1);
    const text = eventsMessage(deps.config, summaries, pageIndex);
    const keyboard =
      totalPages > 1 ? pageKeyboard("events", pageIndex, totalPages) : undefined;

    await ctx.reply(text, {
      ...TELEGRAM_OPTIONS,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  },
});
