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
 * Explicit RFC 3339 timestamp used when an event or feed has no known ledger
 * close time, avoiding assigning process startup / wall-clock time to
 * historical or timeless entries.
 */
export const UNKNOWN_EVENT_TIMESTAMP = new Date(0).toISOString();

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
 *
 * Pipeline:
 *   1. Strip XML-illegal control characters.
 *   2. XML-escape the result (entities expand here, e.g. `&` → `&amp;`).
 *   3. Clip the *escaped* string to `max` Unicode code points, never splitting
 *      inside a `&…;` entity reference or a surrogate pair, then append `…`
 *      when the string was truncated.
 *
 * Clipping after escaping means the final output is always ≤ `max` code
 * points and no entity reference is left with a dangling `&` or missing `;`.
 */
export function xmlText(text: string, max: number): string {
  if (max < 1) return "";
  const escaped = escapeXml(stripXmlIllegal(text));
  return clipEscapedXml(escaped, max);
}

/**
 * Clip an already-XML-escaped string to at most `max` Unicode code points.
 *
 * Rules:
 * - Never splits inside a `&…;` entity reference (scans to the `;` before
 *   deciding a cut is safe).
 * - Never splits a surrogate pair.
 * - Appends `…` (U+2026, one code point, valid XML) when any characters were
 *   dropped.  The ellipsis itself counts toward `max`, so the last safe cut is
 *   at `max − 1` code points of content.
 * - If `max` is 1, the output is `…` (or the whole string when it already fits).
 *
 * @param escaped An already-XML-escaped string (no unescaped `<`, `>`, `&`, etc.)
 * @param max     Maximum code points in the returned string, including any `…`.
 */
export function clipEscapedXml(escaped: string, max: number): string {
  if (max < 1) return "";

  // Count code points (not UTF-16 code units).  Array.from iterates by code
  // point, handling surrogate pairs correctly.
  const codePoints = Array.from(escaped);
  if (codePoints.length <= max) return escaped;

  // We need to append "…" (1 code point), so the content budget is max - 1.
  const budget = max - 1;
  if (budget <= 0) return "…";

  // Walk the code-point array and find the last safe cut index where we are
  // not mid-entity-reference.
  let codePointCount = 0;
  let charIndex = 0; // UTF-16 code unit index into `escaped`
  let lastSafeCut = 0; // UTF-16 index of last confirmed safe cut

  while (codePointCount < budget && charIndex < escaped.length) {
    if (escaped[charIndex] === "&") {
      // Scan ahead to find the closing `;`.  If not found, treat the whole
      // tail as unsafe and stop here.
      const semi = escaped.indexOf(";", charIndex);
      if (semi === -1) break; // malformed — no cut inside a runaway entity

      // The entity reference occupies (semi - charIndex + 1) UTF-16 units
      // but counts as (semi - charIndex + 1) code points in this escaped
      // string (all entity chars are BMP).  Check that the whole entity fits
      // in the remaining budget.
      const entityLen = semi - charIndex + 1; // e.g. "&amp;" = 5
      if (codePointCount + entityLen > budget) break;

      codePointCount += entityLen;
      charIndex = semi + 1;
    } else {
      // Normal code point: may be a surrogate pair (2 UTF-16 units, 1 cp).
      const cp = escaped.codePointAt(charIndex)!;
      const units = cp > 0xffff ? 2 : 1;
      codePointCount++;
      charIndex += units;
    }
    lastSafeCut = charIndex;
  }

  return escaped.slice(0, lastSafeCut) + "…";
}

/**
 * Return `url` as-is if it is a valid `https:` URL string with a non-empty host
 * and no userinfo (`username` / `password`), otherwise return `null`.
 * Only `https:` is allowed and credential-bearing URLs are rejected so Atom
 * `href` / `uri` values never leak or embed credentials.
 */
export function safeHttpsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (!parsed.hostname) return null;
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
   * Defaults to the `at` field of the most-recent event, or
   * {@link UNKNOWN_EVENT_TIMESTAMP} (`1970-01-01T00:00:00.000Z`) when no
   * event has a valid ledger timestamp or the events array is empty.
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
 * The content is the plain-text rendering. The cap ({@link FEED_CONTENT_MAX_CHARS})
 * is applied during serialisation via {@link xmlText}, which counts code points
 * in the already-escaped string so the truncation marker never lands inside an
 * entity reference.
 * The link is the explorer URL when one exists.
 * The updated timestamp comes from `event.at` (ledger close time).
 */
export function buildAtomEntry(event: DecodedEvent, config: StellarConfig): AtomEntry {
  const eventName =
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name;

  const title = `mimir-${event.source}: ${eventName}`;

  // Use ledger close time if available and finite (> Unix epoch start),
  // otherwise represent unknown event time explicitly.
  const updated =
    typeof event.at === "number" && Number.isFinite(event.at) && event.at > 0
      ? new Date(event.at * 1000).toISOString()
      : UNKNOWN_EVENT_TIMESTAMP;

  const rawContent = formatPlainTextEvent(config, event);
  const content = rawContent !== null ? rawContent : null;

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
 *   provided, or {@link UNKNOWN_EVENT_TIMESTAMP} (`1970-01-01T00:00:00.000Z`)
 *   when no event has a valid ledger timestamp or the event array is empty.
 * - Each event becomes one `<entry>`.  Events with no plain-text rendering still
 *   get an entry (with an empty `<content/>`), so feed readers always see the
 *   full event count.
 * - All dynamic content is XML-escaped; XML-illegal control characters are
 *   stripped before escaping.  Length limits are enforced by Unicode code-point
 *   count *after* XML escaping so entity references (`&amp;`, `&lt;`, …) are
 *   never split and the final output is always within the stated cap.
 */
export function buildAtomFeed(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): string {
  const { title, selfUrl, config, subtitle } = options;

  // Feed <updated>: caller override -> latest valid event.at -> explicit unknown timestamp.
  let feedUpdated: string;
  if (options.updatedAt) {
    feedUpdated = options.updatedAt;
  } else {
    const maxAt = events.reduce(
      (best, e) => (typeof e.at === "number" && Number.isFinite(e.at) && e.at > best ? e.at : best),
      0,
    );
    feedUpdated = maxAt > 0 ? new Date(maxAt * 1000).toISOString() : UNKNOWN_EVENT_TIMESTAMP;
  }

  const validSelfUrl = safeHttpsUrl(selfUrl);
  if (validSelfUrl === null) {
    throw new TypeError("Atom feed selfUrl must be a valid HTTPS URL without credentials");
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title type="text">${xmlText(title, FEED_TITLE_MAX_CHARS)}</title>`,
  ];

  if (subtitle) {
    lines.push(`  <subtitle type="text">${xmlText(subtitle, FEED_TITLE_MAX_CHARS)}</subtitle>`);
  }

  lines.push(
    `  <id>${escapeXml(validSelfUrl)}</id>`,
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
