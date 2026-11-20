/**
 * Build an Atom 1.0 feed document from decoded Mimir contract events.
 *
 * No external XML library is needed: the Atom schema is small and every
 * interpolated value goes through {@link escapeXml}, so hostile strings
 * (including those that embed `<`, `>`, `"`, `'`, and `&`) cannot break out of
 * an element or attribute. URL values are validated before interpolation.
 *
 * References:
 *   RFC 4287 – The Atom Syndication Format
 *   https://www.rfc-editor.org/rfc/rfc4287
 */

import { formatPlainTextEvent, eventExplorerUrl } from "../notifications/format.js";
import type { DecodedEvent } from "./decode.js";
import type { StellarConfig } from "../config.js";

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

/** Maximum byte length of a single feed-entry content block. */
export const FEED_CONTENT_MAX_CHARS = 2_000;

/** Maximum byte length of a title or subtitle string. */
export const FEED_TITLE_MAX_CHARS = 500;

/**
 * Escape the five XML predefined entities so a string is safe inside any
 * element text node or double-quoted attribute value.
 *
 * Order matters: `&` must be replaced first, otherwise the `&` introduced by
 * the other replacements would be re-escaped on a second pass.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Remove XML-illegal characters (C0 controls except tab, LF, CR) so no
 * well-formedness error survives into the document.  Printable Unicode,
 * including supplementary planes, passes through unchanged.
 */
export function stripXmlIllegal(text: string): string {
  // XML 1.0 §2.2: legal chars are #x9 | #xA | #xD | [#x20–#xD7FF] | [#xE000–#xFFFD] | [#x10000–#x10FFFF]
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Clip and clean a string for use inside an XML element.
 * Strips XML-illegal control characters, clips to `max` Unicode code points,
 * then XML-escapes the result.
 */
export function xmlText(text: string, max: number): string {
  const cleaned = stripXmlIllegal(text);
  const chars = Array.from(cleaned);
  const clipped = chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("")}…`;
  return escapeXml(clipped);
}

/**
 * Return `url` as-is if it is a valid `https:` URL string, otherwise return
 * `null`.  Only `https:` is allowed: `http:` and other schemes are not safe to
 * embed as Atom `href` / `uri` values without a trusted origin.
 */
export function safeHttpsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Feed filtering
// ---------------------------------------------------------------------------

/**
 * Optional per-contract filter for a feed document.
 *
 * `contractIds` is a set of emitting contract ids; when present (and
 * non-empty) only events whose `contractId` is in the set are included.
 * `eventNames` optionally narrows further to specific event names.
 *
 * Filters are normalized via {@link normalizeFeedFilter} before use so that
 * equivalent filters (ordering, duplicates, whitespace, casing of contract
 * ids) produce identical cache identities.
 */
export interface FeedFilter {
  /** Emitting contract ids to include. Empty/undefined means "all contracts". */
  contractIds?: readonly string[];
  /** Event names to include. Empty/undefined means "all event names". */
  eventNames?: readonly string[];
}

/**
 * Normalized, canonical form of a {@link FeedFilter}.
 *
 * - `contractIds` are trimmed, lower-cased (Stellar contract ids are
 *   case-insensitive strkeys), de-duplicated, and sorted.
 * - `eventNames` are trimmed, de-duplicated, and sorted.
 * - Empty arrays are dropped so "no filter" and "empty filter" collapse to the
 *   same identity.
 */
export interface NormalizedFeedFilter {
  contractIds?: readonly string[];
  eventNames?: readonly string[];
}

function normalizeList(values: readonly string[] | undefined, lower: boolean): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    seen.add(lower ? trimmed.toLowerCase() : trimmed);
  }
  if (seen.size === 0) return undefined;
  return Array.from(seen).sort();
}

/**
 * Normalize a {@link FeedFilter} into a canonical form suitable for cache
 * identity and for filtering events.  Returns `undefined` when the filter is
 * absent or effectively empty (i.e. matches everything).
 */
export function normalizeFeedFilter(
  filter: FeedFilter | undefined,
): NormalizedFeedFilter | undefined {
  if (!filter) return undefined;
  const contractIds = normalizeList(filter.contractIds, true);
  const eventNames = normalizeList(filter.eventNames, false);
  if (!contractIds && !eventNames) return undefined;
  return {
    ...(contractIds ? { contractIds } : {}),
    ...(eventNames ? { eventNames } : {}),
  };
}

/**
 * Build a stable cache key for a feed document scoped to a normalized filter.
 *
 * The key embeds the normalized filter so that two different filters can never
 * share a cache entry (preventing one contract's feed response from leaking
 * into another filter).  Equivalent filters normalize to the same key.
 */
export function feedCacheKey(
  baseKey: string,
  filter: FeedFilter | NormalizedFeedFilter | undefined,
): string {
  const normalized = normalizeFeedFilter(filter as FeedFilter | undefined);
  if (!normalized) return baseKey;
  const parts: string[] = [];
  if (normalized.contractIds) {
    parts.push(`contracts=${normalized.contractIds.map(encodeURIComponent).join(",")}`);
  }
  if (normalized.eventNames) {
    parts.push(`events=${normalized.eventNames.map(encodeURIComponent).join(",")}`);
  }
  return `${baseKey}#${parts.join("&")}`;
}

/**
 * Return true when `event` matches the (already normalized) filter.
 * An absent filter matches every event.
 */
export function matchesFeedFilter(
  event: DecodedEvent,
  filter: NormalizedFeedFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.contractIds) {
    if (!filter.contractIds.includes(event.contractId.toLowerCase())) return false;
  }
  if (filter.eventNames) {
    const name =
      event.payload.name === "unknown"
        ? (event.payload.eventName ?? "unknown")
        : event.payload.name;
    if (!filter.eventNames.includes(name)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Feed entry
// ---------------------------------------------------------------------------

export interface AtomEntry {
  /**
   * RFC 4287 §4.1.2: permanent IRI derived from network, contract, and chain
   * event identity; it is independent of the entry's presentation text.
   */
  id: string;
  /** RFC 4287 §4.2.14: human-readable title. */
  title: string;
  /** RFC 4287 §4.2.15: last-modified timestamp in RFC 3339. */
  updated: string;
  /** RFC 4287 §4.1.3.1: plain-text content, or null when not notifiable. */
  content: string | null;
  /** RFC 4287 §4.2.7: alternate link (explorer URL), or null when absent. */
  link: string | null;
}

// ---------------------------------------------------------------------------
// Feed document
// ---------------------------------------------------------------------------

export interface AtomFeedOptions {
  /** `<title>` for the feed (e.g. "Mimir Events"). */
  title: string;
  /** Canonical URL of this feed document, used as `<id>` and `<link rel="self">`. */
  selfUrl: string;
  /** StellarConfig, forwarded to formatPlainTextEvent and eventExplorerUrl. */
  config: StellarConfig;
  /**
   * Override the feed's `<updated>` timestamp (ISO 8601 / RFC 3339).
   * Defaults to the `at` field of the most-recent event, or the current
   * wall-clock time when the events array is empty.
   */
  updatedAt?: string;
  /** Optional subtitle / description for the feed. */
  subtitle?: string;
  /**
   * Optional per-contract filter.  When set, only matching events are included
   * in the feed.  The filter is normalized before use, so equivalent filters
   * produce identical output.
   */
  filter?: FeedFilter;
}

/**
 * Build one `<entry>` element from a decoded event.
 *
 * The entry id is a stable tag URI derived from the network passphrase,
 * emitting contract id, and Soroban event id. Presentation text is excluded so
 * template changes do not create new entries.
 * The title is the event name (payload.name).
 * The content is the plain-text rendering, bounded to {@link FEED_CONTENT_MAX_CHARS}.
 * The link is the explorer URL when one exists.
 * The updated timestamp comes from `event.at` (ledger close time).
 */
export function buildAtomEntry(event: DecodedEvent, config: StellarConfig): AtomEntry {
  const eventName =
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name;

  const title = `mimir-${event.source}: ${eventName}`;

  // Use ledger close time if available and looks reasonable (> Unix epoch start),
  // otherwise fall back to a synthetic epoch-based value.
  const updatedDate =
    typeof event.at === "number" && event.at > 0
      ? new Date(event.at * 1000)
      : new Date(0);
  const updated = updatedDate.toISOString();

  const rawContent = formatPlainTextEvent(config, event);
  const content =
    rawContent !== null
      ? Array.from(rawContent).slice(0, FEED_CONTENT_MAX_CHARS).join("")
      : null;

  const explorerUrl = eventExplorerUrl(config, event);
  const link = explorerUrl ? safeHttpsUrl(explorerUrl) : null;

  return {
    id: [
      "tag:mimir,event",
      encodeURIComponent(config.networkPassphrase),
      encodeURIComponent(event.contractId),
      encodeURIComponent(event.eventId),
    ].join(":"),
    title,
    updated,
    content,
    link,
  };
}

// ---------------------------------------------------------------------------
// Feed serialisation
// ---------------------------------------------------------------------------

function renderEntry(entry: AtomEntry): string {
  const titleEl = `    <title type="text">${xmlText(entry.title, FEED_TITLE_MAX_CHARS)}</title>`;
  const idEl = `    <id>${escapeXml(entry.id)}</id>`;
  const updatedEl = `    <updated>${escapeXml(entry.updated)}</updated>`;

  const linkEl =
    entry.link !== null
      ? `    <link rel="alternate" type="text/html" href="${escapeXml(entry.link)}"/>`
      : "";

  const contentEl =
    entry.content !== null
      ? `    <content type="text">${xmlText(entry.content, FEED_CONTENT_MAX_CHARS)}</content>`
      : `    <content type="text"/>`;

  return [
    "  <entry>",
    titleEl,
    idEl,
    updatedEl,
    linkEl,
    contentEl,
    "  </entry>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Build a complete Atom 1.0 feed document string from an array of decoded events.
 *
 * - `<feed id>` is the `selfUrl`.
 * - `<updated>` is the most recent `event.at` timestamp, or `updatedAt` when
 *   provided, or the current time for an empty event array.
 * - Each event becomes one `<entry>`.  Events with no plain-text rendering still
 *   get an entry (with an empty `<content/>`), so feed readers always see the
 *   full event count.
 * - When `options.filter` is set, only matching events are included; the filter
 *   is normalized first so equivalent filters yield identical output.
 * - All dynamic content is XML-escaped; XML-illegal control characters are
 *   stripped before escaping.
 */
export function buildAtomFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle } = options;

  const normalizedFilter = normalizeFeedFilter(options.filter);
  const filteredEvents = normalizedFilter
    ? events.filter((event) => matchesFeedFilter(event, normalizedFilter))
    : events;

  // Feed <updated>: caller override → latest event.at → now.
  let feedUpdated: string;
  if (options.updatedAt) {
    feedUpdated = options.updatedAt;
  } else if (filteredEvents.length > 0) {
    const maxAt = filteredEvents.

/* … truncated 1019 chars — edit only what you need near the top … */
