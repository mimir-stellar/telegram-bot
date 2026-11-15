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

/** JSON Feed 1.1 specification URL. */
export const JSON_FEED_VERSION = "https://jsonfeed.org/version/1.1";

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
// Feed entry
// ---------------------------------------------------------------------------

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
  /** Optional safe HTTPS deep link into the Mimir web app when configured. */
  appLink?: string | null;
}

export interface JsonFeedItem {
  id: string;
  title: string;
  content_text: string;
  date_modified: string;
  url?: string;
  external_url?: string;
}

export interface JsonFeedDocument {
  version: typeof JSON_FEED_VERSION;
  title: string;
  description?: string;
  feed_url?: string;
  home_page_url?: string;
  items: JsonFeedItem[];
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
  /** Optional Mimir web-app base URL for deep links (`MIMIR_APP_URL`). */
  mimirAppUrl?: string | null;
}

/**
 * Build one `<entry>` element from a decoded event.
 *
 * The entry id is a stable tag URI derived from the event id so it is both
 * unique and dereferenceable: `tag:mimir,event:<eventId>`.
 * The title is the event name (payload.name).
 * The content is the plain-text rendering, bounded to {@link FEED_CONTENT_MAX_CHARS}.
 * The link is the explorer URL when one exists.
 * The updated timestamp comes from `event.at` (ledger close time).
 */
export function buildAtomEntry(
  event: DecodedEvent,
  config: StellarConfig,
  mimirAppUrl?: string | null,
): AtomEntry {
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

  const resolvedAppBase =
    mimirAppUrl ?? (config as { mimirAppUrl?: string | null }).mimirAppUrl ?? null;
  const rawAppUrl = appUrlFor(event, resolvedAppBase);
  const appLink = rawAppUrl ? safeHttpsUrl(rawAppUrl) : null;

  const result: AtomEntry = {
    id: `tag:mimir,event:${event.eventId}`,
    title,
    updated,
    content,
    link,
  };
  if (appLink !== null) {
    result.appLink = appLink;
  }
  return result;
}

/**
 * Build one JSON Feed 1.1 item from a decoded event.
 */
export function buildJsonFeedEntry(
  event: DecodedEvent,
  config: StellarConfig,
  mimirAppUrl?: string | null,
): JsonFeedItem {
  const entry = buildAtomEntry(event, config, mimirAppUrl);
  const cleanedTitle = stripXmlIllegal(entry.title);
  const titleChars = Array.from(cleanedTitle);
  const clippedTitle =
    titleChars.length <= FEED_TITLE_MAX_CHARS
      ? cleanedTitle
      : `${titleChars.slice(0, FEED_TITLE_MAX_CHARS - 1).join("")}…`;

  const cleanedContent = entry.content !== null ? stripXmlIllegal(entry.content) : "";
  const contentChars = Array.from(cleanedContent);
  const clippedContent =
    contentChars.length <= FEED_CONTENT_MAX_CHARS
      ? cleanedContent
      : `${contentChars.slice(0, FEED_CONTENT_MAX_CHARS - 1).join("")}…`;

  const item: JsonFeedItem = {
    id: entry.id,
    title: clippedTitle,
    content_text: clippedContent,
    date_modified: entry.updated,
  };
  if (entry.link !== null) {
    item.url = entry.link;
  }
  if (entry.appLink) {
    item.external_url = entry.appLink;
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
    const entry = buildAtomEntry(event, config, options.mimirAppUrl);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}

/**
 * Build a complete JSON Feed 1.1 document string from an array of decoded events.
 */
export function buildJsonFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle, mimirAppUrl } = options;
  const cleanedTitle = stripXmlIllegal(title);
  const titleChars = Array.from(cleanedTitle);
  const clippedTitle =
    titleChars.length <= FEED_TITLE_MAX_CHARS
      ? cleanedTitle
      : `${titleChars.slice(0, FEED_TITLE_MAX_CHARS - 1).join("")}…`;

  const doc: JsonFeedDocument = {
    version: JSON_FEED_VERSION,
    title: clippedTitle,
    items: events.map((event) => buildJsonFeedEntry(event, config, mimirAppUrl)),
  };

  if (subtitle) {
    const cleanedSub = stripXmlIllegal(subtitle);
    const subChars = Array.from(cleanedSub);
    doc.description =
      subChars.length <= FEED_TITLE_MAX_CHARS
        ? cleanedSub
        : `${subChars.slice(0, FEED_TITLE_MAX_CHARS - 1).join("")}…`;
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

  return `${JSON.stringify(doc, null, 2)}\n`;
}
