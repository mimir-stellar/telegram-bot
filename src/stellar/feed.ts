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
// XML escaping & post-escape Unicode code-point bounding
// ---------------------------------------------------------------------------

/** Maximum Unicode code-point length of an XML-escaped feed-entry content/summary block. */
export const FEED_CONTENT_MAX_CHARS = 2_000;

/** Maximum Unicode code-point length of an XML-escaped title or subtitle string. */
export const FEED_TITLE_MAX_CHARS = 500;

const XML_ENTITY_AT_OFFSET = /^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

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

interface AtomicXmlToken {
  raw: string;
  codePoints: number;
}

function tokenizeEscapedXml(escaped: string): { tokens: AtomicXmlToken[]; totalCodePoints: number } {
  const tokens: AtomicXmlToken[] = [];
  let totalCodePoints = 0;
  let i = 0;

  while (i < escaped.length) {
    if (escaped.charCodeAt(i) === 0x26 /* '&' */) {
      const match = XML_ENTITY_AT_OFFSET.exec(escaped.slice(i));
      if (match) {
        const entity = match[0];
        const cpLen = entity.length; // ASCII entity syntax: 1 UTF-16 unit == 1 code point
        tokens.push({ raw: entity, codePoints: cpLen });
        totalCodePoints += cpLen;
        i += entity.length;
        continue;
      }
    }

    const cp = escaped.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const ch = escaped.slice(i, i + unitLen);
    tokens.push({ raw: ch, codePoints: 1 });
    totalCodePoints += 1;
    i += unitLen;
  }

  return { tokens, totalCodePoints };
}

/**
 * Bound an already XML-escaped string to at most `maxCodePoints` Unicode code points.
 *
 * - Never splits a UTF-16 surrogate pair (iterates full Unicode code points).
 * - Never splits an XML entity escape sequence (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#...;`).
 * - Preserves a readable `"…"` truncation marker within the `maxCodePoints` budget.
 */
export function boundEscapedXml(escaped: string, maxCodePoints: number): string {
  const limit = Number.isFinite(maxCodePoints) ? Math.floor(maxCodePoints) : 0;
  if (limit <= 0 || escaped.length === 0) {
    return "";
  }

  const { tokens, totalCodePoints } = tokenizeEscapedXml(escaped);
  if (totalCodePoints <= limit) {
    return escaped;
  }

  if (limit === 1) {
    return "…";
  }

  const budget = limit - 1; // Reserve 1 code point for "…"
  let used = 0;
  const kept: string[] = [];

  for (const token of tokens) {
    // Do not duplicate a trailing ellipsis if the input was already clipped
    if (used + token.codePoints > budget) {
      break;
    }
    kept.push(token.raw);
    used += token.codePoints;
  }

  if (kept.length > 0 && kept[kept.length - 1] === "…") {
    return kept.join("");
  }
  return `${kept.join("")}…`;
}

/**
 * Strip XML-illegal control characters, XML-escape the string, and bound the
 * escaped result to at most `max` Unicode code points without splitting
 * surrogate pairs or XML entity sequences.
 */
export function xmlText(text: string, max: number): string {
  const cleaned = stripXmlIllegal(text);
  const escaped = escapeXml(cleaned);
  return boundEscapedXml(escaped, max);
}

function clipPlainCodePoints(text: string, max: number): string {
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return "";
  const cleaned = stripXmlIllegal(text);
  const chars = Array.from(cleaned);
  if (chars.length <= limit) return cleaned;
  if (limit === 1) return "…";
  return `${chars.slice(0, limit - 1).join("")}…`;
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
  /** RFC 4287 §4.2.13: optional short plain-text summary/description. */
  summary?: string | null;
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
   * Optional override for maximum post-escaping Unicode code points per entry
   * description (`<content>` / `<summary>`). Defaults to {@link FEED_CONTENT_MAX_CHARS}.
   */
  maxContentChars?: number;
}

/**
 * Build one `<entry>` element from a decoded event.
 *
 * The entry id is a stable tag URI derived from the event id so it is both
 * unique and dereferenceable: `tag:mimir,event:<eventId>`.
 * The title is the event name (payload.name).
 * The content is the plain-text rendering, bounded to `maxContentChars`.
 * The link is the explorer URL when one exists.
 * The updated timestamp comes from `event.at` (ledger close time).
 */
export function buildAtomEntry(
  event: DecodedEvent,
  config: StellarConfig,
  maxContentChars: number = FEED_CONTENT_MAX_CHARS,
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
  const content = rawContent !== null ? clipPlainCodePoints(rawContent, maxContentChars) : null;

  const explorerUrl = eventExplorerUrl(config, event);
  const link = explorerUrl ? safeHttpsUrl(explorerUrl) : null;

  return {
    id: `tag:mimir,event:${event.eventId}`,
    title,
    updated,
    content,
    link,
  };
}

// ---------------------------------------------------------------------------
// Feed serialisation
// ---------------------------------------------------------------------------

export function renderAtomEntry(
  entry: AtomEntry,
  maxContentChars: number = FEED_CONTENT_MAX_CHARS,
): string {
  const titleEl = `    <title type="text">${xmlText(entry.title, FEED_TITLE_MAX_CHARS)}</title>`;
  const idEl = `    <id>${escapeXml(entry.id)}</id>`;
  const updatedEl = `    <updated>${escapeXml(entry.updated)}</updated>`;

  const linkEl =
    entry.link !== null
      ? `    <link rel="alternate" type="text/html" href="${escapeXml(entry.link)}"/>`
      : "";

  const summaryEl =
    entry.summary !== undefined && entry.summary !== null
      ? `    <summary type="text">${xmlText(entry.summary, maxContentChars)}</summary>`
      : "";

  const contentEl =
    entry.content !== null
      ? `    <content type="text">${xmlText(entry.content, maxContentChars)}</content>`
      : `    <content type="text"/>`;

  return [
    "  <entry>",
    titleEl,
    idEl,
    updatedEl,
    linkEl,
    summaryEl,
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
 * - All dynamic content is XML-escaped and bounded by Unicode code points *after*
 *   escaping without splitting surrogate pairs or XML entity sequences.
 */
export function buildAtomFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle } = options;
  const maxContentChars = options.maxContentChars ?? FEED_CONTENT_MAX_CHARS;

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
    const entry = buildAtomEntry(event, config, maxContentChars);
    lines.push(renderAtomEntry(entry, maxContentChars));
  }

  lines.push("</feed>");
  return lines.join("\n");
}
