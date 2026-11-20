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
import { appUrlFor } from "../notifications/app-links.js";
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
 * Strip XML-illegal control characters and clip a string to `max` Unicode code
 * points, appending an ellipsis when truncated.
 */
export function cleanFeedText(text: string, max: number): string {
  const cleaned = stripXmlIllegal(text);
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Clip and clean a string for use inside an XML element.
 * Strips XML-illegal control characters, clips to `max` Unicode code points,
 * then XML-escapes the result.
 */
export function xmlText(text: string, max: number): string {
  return escapeXml(cleanFeedText(text, max));
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
 * - All dynamic content is XML-escaped; XML-illegal control characters are
 *   stripped before escaping.
 */
export function buildAtomFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle } = options;

  // Feed <updated>: caller override → latest event.at → now.
  let feedUpdated: string;
  if (options.updatedAt) {
    feedUpdated = options.updatedAt;
  } else if (events.length > 0) {
    const maxAt = events.reduce((best, e) => Math.max(best, e.at ?? 0), 0);
    feedUpdated = new Date(maxAt > 0 ? maxAt * 1000 : Date.now()).toISOString();
  } else {
    feedUpdated = new Date().toISOString();
  }

  const validSelfUrl = safeHttpsUrl(selfUrl) ?? "";

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title type="text">${xmlText(title, FEED_TITLE_MAX_CHARS)}</title>`,
  ];

  if (subtitle) {
    lines.push(`  <subtitle type="text">${xmlText(subtitle, FEED_TITLE_MAX_CHARS)}</subtitle>`);
  }

  lines.push(
    `  <id>${escapeXml(validSelfUrl || selfUrl)}</id>`,
    `  <updated>${escapeXml(feedUpdated)}</updated>`,
  );

  if (validSelfUrl) {
    lines.push(
      `  <link rel="self" type="application/atom+xml" href="${escapeXml(validSelfUrl)}"/>`,
    );
  }

  for (const event of events) {
    const entry = buildAtomEntry(event, config);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON Feed 1.1 export (bounded)
// ---------------------------------------------------------------------------

/** JSON Feed specification version URI (https://jsonfeed.org/version/1.1). */
export const JSON_FEED_VERSION = "https://jsonfeed.org/version/1.1";

/** Version of the Mimir-specific `_mimir` extension block in JSON Feed output. */
export const JSON_FEED_SCHEMA_VERSION = 1;

/** Default maximum number of items emitted in a single JSON Feed export. */
export const JSON_FEED_DEFAULT_MAX_ITEMS = 100;

/** Hard upper bound on `maxItems` to keep JSON Feed exports bounded. */
export const JSON_FEED_MAX_ITEMS_LIMIT = 500;

export interface JsonFeedItem {
  /** Permanent tag URI matching {@link AtomEntry.id}. */
  id: string;
  /** Human-readable event title, bounded to {@link FEED_TITLE_MAX_CHARS}. */
  title: string;
  /** Event ledger close timestamp in RFC 3339 / ISO 8601. */
  date_published: string;
  /** Plain-text event rendering, bounded to {@link FEED_CONTENT_MAX_CHARS}. */
  content_text?: string;
  /** Sanitized `https:` explorer URL matching {@link AtomEntry.link}. */
  url?: string;
  /** Sanitized `https:` Mimir web-app deep link when available. */
  external_url?: string;
  /** Event source and event name tags. */
  tags: string[];
}

export interface JsonFeedMimirExtension {
  schema_version: number;
  updated: string;
  total_items: number;
  max_items: number;
  truncated: boolean;
}

export interface JsonFeedDocument {
  version: string;
  title: string;
  home_page_url?: string;
  feed_url?: string;
  description?: string;
  _mimir: JsonFeedMimirExtension;
  items: JsonFeedItem[];
}

export type JsonFeedConfig = StellarConfig & {
  /** Optional Mimir web-app base URL (`MIMIR_APP_URL`). */
  mimirAppUrl?: string | null;
};

export interface JsonFeedOptions extends Omit<AtomFeedOptions, "config"> {
  /** StellarConfig (with optional `mimirAppUrl`), forwarded to event/link builders. */
  config: JsonFeedConfig;
  /** Optional `https:` home page URL; defaults to `config.mimirAppUrl` when valid. */
  homePageUrl?: string;
  /**
   * Maximum number of items to include in the exported feed.
   * Defaults to {@link JSON_FEED_DEFAULT_MAX_ITEMS} and is capped at
   * {@link JSON_FEED_MAX_ITEMS_LIMIT}. Must be a non-negative integer.
   */
  maxItems?: number;
}

function resolveFeedUpdated(
  events: readonly DecodedEvent[],
  updatedAt?: string,
): string {
  if (updatedAt) return updatedAt;
  if (events.length > 0) {
    const maxAt = events.reduce((best, e) => Math.max(best, e.at ?? 0), 0);
    return new Date(maxAt > 0 ? maxAt * 1000 : Date.now()).toISOString();
  }
  return new Date().toISOString();
}

function resolveMaxItems(maxItems?: number): number {
  if (maxItems === undefined) return JSON_FEED_DEFAULT_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 0) {
    throw new RangeError(
      `maxItems must be a non-negative integer, received: ${String(maxItems)}`,
    );
  }
  return Math.min(maxItems, JSON_FEED_MAX_ITEMS_LIMIT);
}

/**
 * Build one JSON Feed 1.1 item from a decoded event using the same canonical
 * entry derivation as {@link buildAtomEntry}, preserving ID, timestamp,
 * bounded plain-text content, and sanitized `https:` explorer and app links.
 */
export function buildJsonFeedItem(
  event: DecodedEvent,
  config: JsonFeedConfig,
): JsonFeedItem {
  const entry = buildAtomEntry(event, config);
  const eventName =
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name;

  const item: JsonFeedItem = {
    id: entry.id,
    title: cleanFeedText(entry.title, FEED_TITLE_MAX_CHARS),
    date_published: entry.updated,
    tags: [
      cleanFeedText(event.source, FEED_TITLE_MAX_CHARS),
      cleanFeedText(eventName, FEED_TITLE_MAX_CHARS),
    ],
  };

  if (entry.content !== null) {
    item.content_text = cleanFeedText(entry.content, FEED_CONTENT_MAX_CHARS);
  }

  if (entry.link !== null) {
    item.url = entry.link;
  }

  const rawAppUrl = appUrlFor(event, config.mimirAppUrl);
  const appUrl = rawAppUrl ? safeHttpsUrl(rawAppUrl) : null;
  if (appUrl !== null) {
    item.external_url = appUrl;
  }

  return item;
}

/**
 * Build a bounded, versioned JSON Feed 1.1 document object from decoded events.
 *
 * Preserves input ordering across the bounded slice (`events.slice(0, maxItems)`)
 * and sanitizes all URLs to `https:` only.
 */
export function buildJsonFeedDocument(
  events: readonly DecodedEvent[],
  options: JsonFeedOptions,
): JsonFeedDocument {
  const { title, selfUrl, config, subtitle, updatedAt, homePageUrl } = options;
  const maxItems = resolveMaxItems(options.maxItems);
  const feedUpdated = resolveFeedUpdated(events, updatedAt);

  const validSelfUrl = safeHttpsUrl(selfUrl);
  const candidateHomeUrl = homePageUrl ?? config.mimirAppUrl ?? null;
  const validHomeUrl = candidateHomeUrl ? safeHttpsUrl(candidateHomeUrl) : null;

  const boundedEvents = events.slice(0, maxItems);
  const items = boundedEvents.map((event) => buildJsonFeedItem(event, config));

  const doc: JsonFeedDocument = {
    version: JSON_FEED_VERSION,
    title: cleanFeedText(title, FEED_TITLE_MAX_CHARS),
    ...(validHomeUrl ? { home_page_url: validHomeUrl } : {}),
    ...(validSelfUrl ? { feed_url: validSelfUrl } : {}),
    ...(subtitle ? { description: cleanFeedText(subtitle, FEED_TITLE_MAX_CHARS) } : {}),
    _mimir: {
      schema_version: JSON_FEED_SCHEMA_VERSION,
      updated: feedUpdated,
      total_items: events.length,
      max_items: maxItems,
      truncated: events.length > boundedEvents.length,
    },
    items,
  };

  return doc;
}

/**
 * Serialize a bounded, versioned JSON Feed 1.1 document as a JSON string.
 */
export function buildJsonFeed(
  events: readonly DecodedEvent[],
  options: JsonFeedOptions,
): string {
  return JSON.stringify(buildJsonFeedDocument(events, options), null, 2);
}
