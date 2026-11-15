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
import {
  appUrlFor,
  validateSafeHttpsBaseUrl,
  type UnsafeHttpsUrlReason,
} from "../notifications/app-links.js";
import type { DecodedEvent } from "./decode.js";
import type { StellarConfig } from "../config.js";

/**
 * Raised before feed rendering when a configured feed base URL (`selfUrl`,
 * `explorerBaseUrl`, or `mimirAppUrl`) uses a non-HTTPS scheme, embeds
 * userinfo/credentials, or has an invalid host.
 *
 * Raw URL credentials are never echoed into the error message.
 */
export class FeedBaseUrlError extends Error {
  readonly field: string;
  readonly reason: UnsafeHttpsUrlReason;

  constructor(field: string, reason: UnsafeHttpsUrlReason) {
    super(`Rejected unsafe feed base URL in "${field}": ${reason}`);
    this.name = "FeedBaseUrlError";
    this.field = field;
    this.reason = reason;
  }
}

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
 * Return `url` as-is if it is a valid `https:` URL string with no userinfo and
 * a valid host, otherwise return `null`.
 */
export function safeHttpsUrl(url: string): string | null {
  const validated = validateSafeHttpsBaseUrl(url);
  if (!validated.ok) return null;
  return url;
}

/**
 * Validate feed base URLs (`selfUrl`, optional `config.explorerBaseUrl`, and
 * optional `mimirAppUrl`) before rendering so credential-bearing or malformed
 * origins fail closed prior to generating `<id>` or `<link>` elements.
 */
export function validateFeedBaseUrls(options: AtomFeedOptions): void {
  const selfCheck = validateSafeHttpsBaseUrl(options.selfUrl);
  if (!selfCheck.ok) {
    throw new FeedBaseUrlError("selfUrl", selfCheck.reason);
  }

  const explorerBase = options.config?.explorerBaseUrl;
  if (typeof explorerBase === "string" && explorerBase.length > 0) {
    const explorerCheck = validateSafeHttpsBaseUrl(explorerBase);
    if (!explorerCheck.ok) {
      throw new FeedBaseUrlError("config.explorerBaseUrl", explorerCheck.reason);
    }
  }

  const appBase =
    options.mimirAppUrl ??
    (options.config as { mimirAppUrl?: string | null } | undefined)?.mimirAppUrl;
  if (typeof appBase === "string" && appBase.length > 0) {
    const appCheck = validateSafeHttpsBaseUrl(appBase);
    if (!appCheck.ok) {
      throw new FeedBaseUrlError("mimirAppUrl", appCheck.reason);
    }
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
  /** Optional validated HTTPS Mimir web-app deep link, or null when absent/rejected. */
  appLink?: string | null;
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
  /** Optional Mimir web-app origin (`MIMIR_APP_URL`) validated before rendering. */
  mimirAppUrl?: string | null;
}

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

  const hasUnsafeExplorerBase =
    typeof config.explorerBaseUrl === "string" &&
    config.explorerBaseUrl.length > 0 &&
    !validateSafeHttpsBaseUrl(config.explorerBaseUrl).ok;
  const explorerUrl = hasUnsafeExplorerBase ? null : eventExplorerUrl(config, event);
  const link = explorerUrl ? safeHttpsUrl(explorerUrl) : null;

  const resolvedAppBase =
    mimirAppUrl ?? (config as { mimirAppUrl?: string | null }).mimirAppUrl ?? null;
  const rawAppUrl = appUrlFor(event, resolvedAppBase);
  const appLink = rawAppUrl ? safeHttpsUrl(rawAppUrl) : null;

  const entry: AtomEntry = {
    id: `tag:mimir,event:${event.eventId}`,
    title,
    updated,
    content,
    link,
  };
  if (appLink !== null) {
    entry.appLink = appLink;
  }
  return entry;
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
  validateFeedBaseUrls(options);

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

  const validSelfUrl = safeHttpsUrl(selfUrl);
  if (validSelfUrl === null) {
    throw new FeedBaseUrlError("selfUrl", "invalid_url");
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
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(validSelfUrl)}"/>`,
  );

  for (const event of events) {
    const entry = buildAtomEntry(event, config, options.mimirAppUrl);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}
