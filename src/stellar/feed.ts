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

import { createHash } from "node:crypto";
import { formatPlainTextEvent, eventExplorerUrl } from "../notifications/format.js";
import type { DecodedEvent } from "./decode.js";
import type { StellarConfig } from "../config.js";

/** XML namespace for Mimir Atom feed extension metadata. */
export const MIMIR_FEED_XMLNS = "https://mimir.stellar/ns/feed/1.0";

/** Deterministic RFC 3339 fallback `<updated>` timestamp when no event timestamp exists. */
export const FEED_EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";

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
}

// ---------------------------------------------------------------------------
// Feed document
// ---------------------------------------------------------------------------

export type FeedUpdateState = "empty" | "unchanged" | "updated";

export interface FeedTimestampMetadata {
  /** Lifecycle classification for this rendered snapshot. */
  state: FeedUpdateState;
  /** Number of entries rendered into the feed. */
  entryCount: number;
  /** Deterministic SHA-256 digest of the canonical event sequence in this feed. */
  revision: string;
  /** Whether the feed's event revision matches `previousRevision`. */
  unchanged: boolean;
  /** Latest positive `event.at` timestamp in ISO 8601, or `null` when absent/empty. */
  lastEventUpdatedAt: string | null;
  /** Effective Atom `<updated>` value (never derived from wall-clock render time). */
  feedUpdatedAt: string;
  /** Explicit feed snapshot generation timestamp when supplied, else `null`. */
  generatedAt: string | null;
}

export interface AtomFeedBuildResult {
  xml: string;
  metadata: FeedTimestampMetadata;
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
   * Defaults to the `at` field of the most-recent event, or
   * {@link FEED_EMPTY_UPDATED_AT} when no event timestamp is available.
   */
  updatedAt?: string;
  /**
   * Timestamp when this feed document was generated (ISO 8601 / RFC 3339).
   * Kept strictly separate from `<updated>` so re-rendering an empty or
   * unchanged feed never advances `<updated>`. Omitted in deterministic
   * snapshot fixtures unless explicitly provided.
   */
  generatedAt?: string;
  /**
   * Optional `revision` from the previous feed render. When the current event
   * revision matches a non-empty feed's `previousRevision`, the feed is marked
   * `unchanged`.
   */
  previousRevision?: string;
  /**
   * Optional `<updated>` from the previous feed render, preserved when an
   * empty or timeless feed remains unchanged.
   */
  previousUpdatedAt?: string;
  /** Optional subtitle / description for the feed. */
  subtitle?: string;
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

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new RangeError(`Invalid ISO 8601 timestamp for ${fieldName}: "${value}"`);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Unparseable ISO 8601 timestamp for ${fieldName}: "${value}"`);
  }
  return trimmed;
}

/**
 * Compute a deterministic SHA-256 revision digest over the feed's ordered event identities.
 */
export function computeFeedRevision(events: readonly DecodedEvent[]): string {
  const hash = createHash("sha256");
  hash.update(`count:${events.length}\n`);
  for (const event of events) {
    hash.update(
      [
        event.source,
        event.contractId,
        String(event.ledger),
        event.txHash,
        event.eventId,
        String(event.at ?? 0),
        event.payload.name,
      ].join("|"),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Resolve feed generation metadata separately from the last event update time.
 *
 * Never consults `Date.now()`: empty and unchanged feeds keep deterministic
 * `<updated>` timestamps instead of advancing on every render.
 */
export function resolveFeedTimestamps(
  events: readonly DecodedEvent[],
  options: Pick<
    AtomFeedOptions,
    "updatedAt" | "generatedAt" | "previousRevision" | "previousUpdatedAt"
  > = {},
): FeedTimestampMetadata {
  const updatedOverride =
    options.updatedAt !== undefined
      ? normalizeIsoTimestamp(options.updatedAt, "updatedAt")
      : undefined;
  const generatedAt =
    options.generatedAt !== undefined
      ? normalizeIsoTimestamp(options.generatedAt, "generatedAt")
      : null;
  const previousUpdatedAt =
    options.previousUpdatedAt !== undefined
      ? normalizeIsoTimestamp(options.previousUpdatedAt, "previousUpdatedAt")
      : undefined;

  const revision = computeFeedRevision(events);
  let maxAt = 0;
  for (const event of events) {
    if (typeof event.at === "number" && Number.isFinite(event.at) && event.at > maxAt) {
      maxAt = event.at;
    }
  }

  const lastEventUpdatedAt = maxAt > 0 ? new Date(maxAt * 1000).toISOString() : null;
  const matchesPrevious =
    options.previousRevision !== undefined && options.previousRevision === revision;

  let state: FeedUpdateState;
  if (events.length === 0) {
    state = "empty";
  } else if (matchesPrevious) {
    state = "unchanged";
  } else {
    state = "updated";
  }

  let feedUpdatedAt: string;
  if (updatedOverride !== undefined) {
    feedUpdatedAt = updatedOverride;
  } else if (lastEventUpdatedAt !== null) {
    feedUpdatedAt = lastEventUpdatedAt;
  } else if (matchesPrevious && previousUpdatedAt !== undefined) {
    feedUpdatedAt = previousUpdatedAt;
  } else {
    feedUpdatedAt = FEED_EMPTY_UPDATED_AT;
  }

  return {
    state,
    entryCount: events.length,
    revision,
    unchanged: matchesPrevious,
    lastEventUpdatedAt,
    feedUpdatedAt,
    generatedAt,
  };
}

/**
 * Build both the Atom 1.0 XML string and its separated timestamp/state metadata.
 */
export function buildAtomFeedResult(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): AtomFeedBuildResult {
  const { title, selfUrl, config, subtitle } = options;
  const metadata = resolveFeedTimestamps(events, options);
  const validSelfUrl = safeHttpsUrl(selfUrl) ?? "";

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:mimir="${MIMIR_FEED_XMLNS}">`,
    `  <title type="text">${xmlText(title, FEED_TITLE_MAX_CHARS)}</title>`,
  ];

  if (subtitle) {
    lines.push(`  <subtitle type="text">${xmlText(subtitle, FEED_TITLE_MAX_CHARS)}</subtitle>`);
  }

  lines.push(
    `  <id>${escapeXml(validSelfUrl || selfUrl)}</id>`,
    `  <updated>${escapeXml(metadata.feedUpdatedAt)}</updated>`,
    `  <mimir:state>${metadata.state}</mimir:state>`,
  );

  if (metadata.lastEventUpdatedAt !== null) {
    lines.push(
      `  <mimir:lastEventUpdatedAt>${escapeXml(metadata.lastEventUpdatedAt)}</mimir:lastEventUpdatedAt>`,
    );
  }

  if (metadata.generatedAt !== null) {
    lines.push(`  <mimir:generatedAt>${escapeXml(metadata.generatedAt)}</mimir:generatedAt>`);
  }

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
  return {
    xml: lines.join("\n"),
    metadata,
  };
}

/**
 * Build a complete Atom 1.0 feed document string from an array of decoded events.
 *
 * - `<feed id>` is the `selfUrl`.
 * - `<updated>` is the most recent `event.at` timestamp, or `updatedAt` when
 *   provided, or {@link FEED_EMPTY_UPDATED_AT} when no event timestamp exists.
 * - Feed generation time (`generatedAt`) is emitted separately in `<mimir:generatedAt>`
 *   when provided, keeping snapshot fixtures deterministic and preventing empty
 *   or unchanged feeds from advancing `<updated>` on re-render.
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
  return buildAtomFeedResult(events, options).xml;
}
