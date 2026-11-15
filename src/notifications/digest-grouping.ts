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
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  escapeMd,
  formatDigest,
  formatDigestEventLine,
} from "./format.js";
import { validateDigestPageLimit } from "./schedule.js";

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

export interface PaginateDigestOptions {
  /** Group consecutive events by claim / squad market (`true` by default). */
  grouped?: boolean;
  /** Maximum characters per page (`1..4096`, defaults to `TELEGRAM_MAX_MESSAGE_LENGTH`). */
  maxPageChars?: number;
}

export interface DigestPage {
  /** 0-based page index (`0 .. totalPages - 1`). */
  pageIndex: number;
  /** 1-based page number (`1 .. totalPages`). */
  pageNumber: number;
  /** Total number of pages in this digest. */
  totalPages: number;
  /** Number of complete event summaries rendered on this page. */
  eventCount: number;
  /** Stable total event count across the entire digest. */
  totalEvents: number;
  /** Exact events rendered on this page, in rendered order. */
  events: DecodedEvent[];
  /** Complete Telegram-safe MarkdownV2 payload (`length <= maxPageChars`). */
  text: string;
}

interface DigestEntryBlock {
  event: DecodedEvent;
  groupKey: string | null;
  line: string;
}

function buildEntryBlocks(
  events: readonly DecodedEvent[],
  grouped: boolean,
): DigestEntryBlock[] {
  if (!grouped) {
    return events.map((event) => ({
      event,
      groupKey: null,
      line: formatDigestEventLine(event),
    }));
  }

  const groups = groupDigestEvents(events);
  const blocks: DigestEntryBlock[] = [];
  for (const group of groups) {
    if (group.events.length === 1) {
      const [sole] = group.events;
      if (sole) {
        blocks.push({
          event: sole,
          groupKey: null,
          line: formatDigestEventLine(sole),
        });
      }
    } else {
      for (const event of group.events) {
        blocks.push({
          event,
          groupKey: group.key,
          line: `  ${formatDigestEventLine(event)}`,
        });
      }
    }
  }
  return blocks;
}

function buildContinuationHeader(
  pageNumber: number,
  totalPages: number,
  pageEventCount: number,
  totalEvents: number,
): string {
  const title =
    pageNumber === 1
      ? "*Mimir Digest*"
      : `*Mimir Digest ${escapeMd("(continued)")}*`;
  const suffix = escapeMd(
    `(page ${pageNumber}/${totalPages}, ${pageEventCount} on this page)`,
  );
  return `${title} — ${totalEvents} events in this cycle ${suffix}`;
}

function renderGroupHeaderLine(groupKey: string, continued: boolean): string {
  return continued
    ? `${escapeMd(groupKey)} ${escapeMd("(cont.)")}`
    : escapeMd(groupKey);
}

interface RawPageDraft {
  events: DecodedEvent[];
  bodyLines: string[];
}

function packDigestPages(
  blocks: readonly DigestEntryBlock[],
  totalEvents: number,
  maxPageChars: number,
  assumedTotalPages: number,
): RawPageDraft[] {
  const pages: RawPageDraft[] = [];
  const seenGroupsAcrossPages = new Set<string>();

  let currentEvents: DecodedEvent[] = [];
  let currentBodyLines: string[] = [];
  let activeGroupOnPage: string | null = null;

  const headerBudgetFor = (pageNumber: number): number => {
    // Worst-case header length on this page uses max digit widths for pageNumber,
    // assumedTotalPages, and totalEvents so the final rendered header never overflows.
    const worstHeader = buildContinuationHeader(
      Math.max(pageNumber, assumedTotalPages),
      assumedTotalPages,
      totalEvents,
      totalEvents,
    );
    return worstHeader.length + 2; // + "\n\n"
  };

  for (const block of blocks) {
    const pageNumber = pages.length + 1;
    const needsGroupHeader =
      block.groupKey !== null && block.groupKey !== activeGroupOnPage;
    const isGroupContinuation =
      block.groupKey !== null && seenGroupsAcrossPages.has(block.groupKey);
    const additions: string[] = [];
    if (needsGroupHeader && block.groupKey !== null) {
      additions.push(renderGroupHeaderLine(block.groupKey, isGroupContinuation));
    }
    additions.push(block.line);

    const candidateBodyLength =
      (currentBodyLines.length > 0 ? currentBodyLines.join("\n").length + 1 : 0) +
      additions.join("\n").length;
    const totalCandidateLength = headerBudgetFor(pageNumber) + candidateBodyLength;

    if (totalCandidateLength <= maxPageChars) {
      currentBodyLines.push(...additions);
      currentEvents.push(block.event);
      activeGroupOnPage = block.groupKey;
      if (block.groupKey !== null) {
        seenGroupsAcrossPages.add(block.groupKey);
      }
      continue;
    }

    if (currentEvents.length === 0) {
      throw new RangeError(
        `maxPageChars (${maxPageChars}) cannot fit a complete digest header and event summary`,
      );
    }

    // Close current page on a complete event boundary and start a continuation page.
    pages.push({ events: currentEvents, bodyLines: currentBodyLines });
    currentEvents = [];
    currentBodyLines = [];
    activeGroupOnPage = null;

    const nextPageNumber = pages.length + 1;
    const contAdditions: string[] = [];
    if (block.groupKey !== null) {
      contAdditions.push(
        renderGroupHeaderLine(block.groupKey, seenGroupsAcrossPages.has(block.groupKey)),
      );
    }
    contAdditions.push(block.line);

    const freshLength = headerBudgetFor(nextPageNumber) + contAdditions.join("\n").length;
    if (freshLength > maxPageChars) {
      throw new RangeError(
        `maxPageChars (${maxPageChars}) cannot fit continuation header and event summary`,
      );
    }

    currentBodyLines.push(...contAdditions);
    currentEvents.push(block.event);
    activeGroupOnPage = block.groupKey;
    if (block.groupKey !== null) {
      seenGroupsAcrossPages.add(block.groupKey);
    }
  }

  if (currentEvents.length > 0) {
    pages.push({ events: currentEvents, bodyLines: currentBodyLines });
  }

  return pages;
}

/**
 * Bound a digest into deterministic, Telegram-safe continuation pages.
 *
 * Splits strictly on complete event summaries (never mid-line or mid-MarkdownV2
 * escape/entity), repeats group headers with `(cont.)` when a group spans page
 * boundaries, and preserves a stable `totalEvents` count across all pages.
 */
export function paginateDigest(
  events: readonly DecodedEvent[],
  options: PaginateDigestOptions = {},
): DigestPage[] {
  const maxPageChars = validateDigestPageLimit(
    options.maxPageChars ?? TELEGRAM_MAX_MESSAGE_LENGTH,
  );
  if (events.length === 0) return [];

  const grouped = options.grouped ?? true;
  const singleText = formatDigest(events, { grouped });
  const blocks = buildEntryBlocks(events, grouped);

  if (singleText !== null && singleText.length <= maxPageChars) {
    const orderedEvents = blocks.map((b) => b.event);
    return [
      {
        pageIndex: 0,
        pageNumber: 1,
        totalPages: 1,
        eventCount: orderedEvents.length,
        totalEvents: events.length,
        events: orderedEvents,
        text: singleText,
      },
    ];
  }

  let assumedTotalPages = Math.max(
    2,
    Math.ceil((singleText?.length ?? maxPageChars + 1) / maxPageChars),
  );
  let drafts = packDigestPages(blocks, events.length, maxPageChars, assumedTotalPages);

  while (String(drafts.length).length > String(assumedTotalPages).length) {
    assumedTotalPages = drafts.length;
    drafts = packDigestPages(blocks, events.length, maxPageChars, assumedTotalPages);
  }

  const totalPages = drafts.length;
  return drafts.map((draft, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const header = buildContinuationHeader(
      pageNumber,
      totalPages,
      draft.events.length,
      events.length,
    );
    const text = [header, "", ...draft.bodyLines].join("\n");
    return {
      pageIndex,
      pageNumber,
      totalPages,
      eventCount: draft.events.length,
      totalEvents: events.length,
      events: draft.events,
      text,
    };
  });
}
