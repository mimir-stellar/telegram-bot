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
import type { ContractSource, DecodedEvent } from "./decode.js";
import type { StellarConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Constants & escaping
// ---------------------------------------------------------------------------

/** JSON Feed 1.1 specification version URI. */
export const JSON_FEED_VERSION = "https://jsonfeed.org/version/1.1";

/** Versioned Mimir extension schema identifier for JSON Feed exports. */
export const MIMIR_JSON_FEED_SCHEMA_VERSION = "mimir-json-feed-v1";

/** Default maximum number of items emitted in a single feed export. */
export const FEED_DEFAULT_MAX_ITEMS = 100;

/** Hard upper bound on items emitted in a single feed export. */
export const FEED_HARD_MAX_ITEMS = 500;

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

function clipCleanText(text: string, max: number): string {
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
  return escapeXml(clipCleanText(text, max));
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
// Canonical feed record & Atom / JSON Feed shapes
// ---------------------------------------------------------------------------

export interface CanonicalFeedRecord {
  id: string;
  title: string;
  updated: string;
  published: string | null;
  content: string | null;
  explorerUrl: string | null;
  appUrl: string | null;
  source: ContractSource;
  contractId: string;
  ledger: number;
  eventName: string;
}

export interface AtomEntry {
  /** RFC 4287 §4.1.2: unique, permanent IRI for the entry. */
  id: string;
  /** RFC 4287 §4.2.14: human-readable title. */
  title: string;
  /** RFC 4287 §4.2.15: last-modified timestamp in RFC 3339. */
  updated: string;
  /** RFC 4287 §4.1.3.1: plain-text content, or null when not notifiable. */
  content: string | null;
  /** RFC 4287 §4.2.7: alternate link (explorer URL), or null when absent. */
  link: string | null;
  /** Optional sanitized HTTPS Mimir web-app deep link when configured. */
  appLink?: string | null;
}

export interface JsonFeedItemMimirMeta {
  source: ContractSource;
  contractId: string;
  ledger: number;
  eventName: string;
  notifiable: boolean;
}

export interface JsonFeedItem {
  id: string;
  title: string;
  content_text: string;
  date_modified: string;
  date_published?: string;
  url?: string;
  external_url?: string;
  tags: string[];
  _mimir: JsonFeedItemMimirMeta;
}

export interface JsonFeedMimirMeta {
  schemaVersion: typeof MIMIR_JSON_FEED_SCHEMA_VERSION;
  updatedAt: string;
  entryCount: number;
  totalEvents: number;
  truncated: boolean;
}

export interface JsonFeedDocument {
  version: typeof JSON_FEED_VERSION;
  title: string;
  description?: string;
  feed_url?: string;
  home_page_url?: string;
  _mimir: JsonFeedMimirMeta;
  items: JsonFeedItem[];
}

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
  /** Optional Mimir web-app origin (`MIMIR_APP_URL`) for deep links. */
  mimirAppUrl?: string | null;
  /**
   * Maximum number of entries emitted in the feed (`0..500`, default `100`).
   * Applies identically to both Atom and JSON Feed exports.
   */
  maxItems?: number;
}

function resolveBoundedEvents(
  events: readonly DecodedEvent[],
  maxItems?: number,
): { slice: readonly DecodedEvent[]; truncated: boolean } {
  if (maxItems === undefined) {
    const cap = FEED_DEFAULT_MAX_ITEMS;
    if (events.length <= cap) {
      return { slice: events, truncated: false };
    }
    return { slice: events.slice(0, cap), truncated: true };
  }

  if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > FEED_HARD_MAX_ITEMS) {
    throw new RangeError(
      `maxItems must be an integer between 0 and ${FEED_HARD_MAX_ITEMS}, got ${String(maxItems)}`,
    );
  }

  if (events.length <= maxItems) {
    return { slice: events, truncated: false };
  }
  return { slice: events.slice(0, maxItems), truncated: true };
}

/**
 * Map a single decoded chain event into the shared canonical feed record used
 * by both Atom 1.0 and JSON Feed 1.1 builders.
 */
export function buildCanonicalFeedRecord(
  event: DecodedEvent,
  config: StellarConfig,
  mimirAppUrl?: string | null,
): CanonicalFeedRecord {
  const eventName =
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name;

  const title = clipCleanText(`mimir-${event.source}: ${eventName}`, FEED_TITLE_MAX_CHARS);

  const hasKnownTime = typeof event.at === "number" && Number.isFinite(event.at) && event.at > 0;
  const published = hasKnownTime ? new Date(event.at * 1000).toISOString() : null;
  const updated = published ?? new Date(0).toISOString();

  const rawContent = formatPlainTextEvent(config, event);
  const content =
    rawContent !== null ? clipCleanText(rawContent, FEED_CONTENT_MAX_CHARS) : null;

  const rawExplorer = eventExplorerUrl(config, event);
  const explorerUrl = rawExplorer ? safeHttpsUrl(rawExplorer) : null;

  const resolvedAppBase =
    mimirAppUrl ?? (config as { mimirAppUrl?: string | null }).mimirAppUrl ?? null;
  const rawAppUrl = appUrlFor(event, resolvedAppBase);
  const appUrl = rawAppUrl ? safeHttpsUrl(rawAppUrl) : null;

  return {
    id: `tag:mimir,event:${event.eventId}`,
    title,
    updated,
    published,
    content,
    explorerUrl,
    appUrl,
    source: event.source,
    contractId: event.contractId,
    ledger: event.ledger,
    eventName: stripXmlIllegal(eventName),
  };
}

export function buildAtomEntry(
  event: DecodedEvent,
  config: StellarConfig,
  mimirAppUrl?: string | null,
): AtomEntry {
  const record = buildCanonicalFeedRecord(event, config, mimirAppUrl);
  const entry: AtomEntry = {
    id: record.id,
    title: record.title,
    updated: record.updated,
    content: record.content,
    link: record.explorerUrl,
  };
  if (record.appUrl !== null) {
    entry.appLink = record.appUrl;
  }
  return entry;
}

/**
 * Map a decoded event into a bounded JSON Feed 1.1 item via {@link buildCanonicalFeedRecord}.
 */
export function buildJsonFeedEntry(
  event: DecodedEvent,
  config: StellarConfig,
  mimirAppUrl?: string | null,
): JsonFeedItem {
  const record = buildCanonicalFeedRecord(event, config, mimirAppUrl);
  const item: JsonFeedItem = {
    id: record.id,
    title: record.title,
    content_text: record.content ?? "",
    date_modified: record.updated,
    tags: [record.source, record.eventName],
    _mimir: {
      source: record.source,
      contractId: record.contractId,
      ledger: record.ledger,
      eventName: record.eventName,
      notifiable: record.content !== null,
    },
  };
  if (record.published !== null) {
    item.date_published = record.published;
  }
  if (record.explorerUrl !== null) {
    item.url = record.explorerUrl;
  }
  if (record.appUrl !== null) {
    item.external_url = record.appUrl;
  }
  return item;
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

  const appLinkEl =
    entry.appLink
      ? `    <link rel="related" type="text/html" href="${escapeXml(entry.appLink)}"/>`
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
    appLinkEl,
    contentEl,
    "  </entry>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function resolveFeedUpdatedTimestamp(
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

export function buildAtomFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle } = options;
  const { slice: boundedEvents } = resolveBoundedEvents(events, options.maxItems);
  const feedUpdated = resolveFeedUpdatedTimestamp(boundedEvents, options.updatedAt);
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

  for (const event of boundedEvents) {
    const entry = buildAtomEntry(event, config, options.mimirAppUrl);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}

/**
 * Build a bounded, versioned JSON Feed 1.1 object from the same canonical event
 * records as {@link buildAtomFeed}, preserving ordering and sanitized links.
 */
export function buildJsonFeedObject(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): JsonFeedDocument {
  const { title, selfUrl, config, subtitle, mimirAppUrl } = options;
  const { slice: boundedEvents, truncated } = resolveBoundedEvents(events, options.maxItems);
  const updatedAt = resolveFeedUpdatedTimestamp(boundedEvents, options.updatedAt);

  const doc: JsonFeedDocument = {
    version: JSON_FEED_VERSION,
    title: clipCleanText(title, FEED_TITLE_MAX_CHARS),
    _mimir: {
      schemaVersion: MIMIR_JSON_FEED_SCHEMA_VERSION,
      updatedAt,
      entryCount: boundedEvents.length,
      totalEvents: events.length,
      truncated,
    },
    items: boundedEvents.map((event) => buildJsonFeedEntry(event, config, mimirAppUrl)),
  };

  if (subtitle) {
    doc.description = clipCleanText(subtitle, FEED_TITLE_MAX_CHARS);
  }

  const validSelfUrl = safeHttpsUrl(selfUrl);
  if (validSelfUrl !== null) {
    doc.feed_url = validSelfUrl;
  }

  const resolvedAppBase =
    mimirAppUrl ?? (config as { mimirAppUrl?: string | null }).mimirAppUrl ?? null;
  const validHomeUrl = resolvedAppBase ? safeHttpsUrl(resolvedAppBase) : null;
  if (validHomeUrl !== null) {
    doc.home_page_url = validHomeUrl;
  }

  return doc;
}

/**
 * Serialize a bounded, versioned JSON Feed 1.1 document string.
 */
export function buildJsonFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  return `${JSON.stringify(buildJsonFeedObject(events, options), null, 2)}\n`;
}
