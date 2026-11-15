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
import { eventKey, type DedupableEvent } from "../dedup.js";
import { NETWORK_PASSPHRASES, type StellarConfig } from "../config.js";
import { appUrlFor } from "../notifications/app-links.js";
import { formatPlainTextEvent, eventExplorerUrl } from "../notifications/format.js";
import type { DecodedEvent } from "./decode.js";

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
// Stable chain-derived entry identifiers (independent of presentation text)
// ---------------------------------------------------------------------------

function sanitizeTagSegment(raw: string): string {
  // Keep standard URI unreserved + colon characters intact; percent-encode anything else.
  return raw.replace(/[^A-Za-z0-9._~:-]/g, (ch) => encodeURIComponent(ch));
}

function positionSegment(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return value.trim();
  }
  return "na";
}

/**
 * Derive a canonical, presentation-independent network token from Stellar config.
 * Named networks map to `testnet`, `mainnet`, or `futurenet`; custom passphrases
 * map to `custom-<sha256_12>` so distinct private networks never collide.
 */
export function canonicalFeedNetworkId(config: StellarConfig): string {
  const passphrase = (config.networkPassphrase ?? "").trim();
  if (passphrase === NETWORK_PASSPHRASES.testnet) return "testnet";
  if (passphrase === NETWORK_PASSPHRASES.mainnet) return "mainnet";
  if (passphrase === NETWORK_PASSPHRASES.futurenet) return "futurenet";
  if (passphrase.length > 0) {
    const digest = createHash("sha256").update(passphrase, "utf8").digest("hex").slice(0, 12);
    return `custom-${digest}`;
  }
  if (
    config.network === "testnet" ||
    config.network === "mainnet" ||
    config.network === "futurenet"
  ) {
    return config.network;
  }
  return "unknown";
}

/**
 * Derive a canonical contract token from the decoded event (falling back to the
 * configured contract for `event.source` when absent).
 */
export function canonicalFeedContractId(event: DecodedEvent, config: StellarConfig): string {
  const direct = (event.contractId ?? "").trim();
  if (direct.length > 0) {
    const normalized = /^[GC][A-Z2-7]{55}$/i.test(direct) ? direct.toUpperCase() : direct;
    return sanitizeTagSegment(normalized);
  }
  const fallback =
    event.source === "market"
      ? (config.marketContractId ?? "").trim()
      : event.source === "squad"
        ? (config.squadContractId ?? "").trim()
        : "";
  if (fallback.length > 0) {
    const normalized = /^[GC][A-Z2-7]{55}$/i.test(fallback) ? fallback.toUpperCase() : fallback;
    return sanitizeTagSegment(normalized);
  }
  return sanitizeTagSegment((event.source || "unknown").trim());
}

/**
 * Derive the chain-level event identity without consulting any presentation
 * fields (`payload` text, locale, explorer URL, app URL, or wording templates).
 */
export function canonicalChainEventIdentity(
  event: DecodedEvent & Partial<Pick<DedupableEvent, "id" | "topic">>,
): string {
  const trimmedEventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
  const trimmedRawId = typeof event.id === "string" ? event.id.trim() : undefined;

  const key = eventKey({
    id: trimmedRawId,
    eventId: trimmedEventId,
    ledger: event.ledger,
    txHash: event.txHash,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    topic: event.topic,
  });
  if (key !== null) {
    return sanitizeTagSegment(key);
  }

  const ledgerSeg = positionSegment(event.ledger);
  const txSeg =
    typeof event.txHash === "string" && event.txHash.trim().length > 0
      ? sanitizeTagSegment(event.txHash.trim().toLowerCase())
      : "none";
  const txIdxSeg = positionSegment(event.transactionIndex);
  const opIdxSeg = positionSegment(event.operationIndex);
  return `coord:${ledgerSeg}:${txSeg}:${txIdxSeg}:${opIdxSeg}`;
}

/**
 * Build a permanent Atom `<id>` tag URI anchored exclusively to:
 *   1. Stellar network identity (`testnet` / `mainnet` / `futurenet` / `custom-<hash>`)
 *   2. Emitting contract identity (`contractId`)
 *   3. Chain event identity (`eventId` / `eventKey` / chain coordinates)
 *
 * Presentation changes (locale, wording templates, titles, explorer/app URLs,
 * or decoded payload copy) never alter the returned `<id>`.
 */
export function buildAtomEntryId(event: DecodedEvent, config: StellarConfig): string {
  const networkId = canonicalFeedNetworkId(config);
  const contractId = canonicalFeedContractId(event, config);
  const chainEventId = canonicalChainEventIdentity(event);
  return `tag:mimir,event:${networkId}:${contractId}:${chainEventId}`;
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
  /** Optional sanitized HTTPS Mimir web-app deep link when configured. */
  appLink?: string | null;
}

export interface AtomEntryRenderOptions {
  /** Optional Mimir web-app base URL (`MIMIR_APP_URL`) for `rel="related"` deep links. */
  mimirAppUrl?: string | null;
  /** Optional custom title wording template (does not affect `entry.id`). */
  formatTitle?: (event: DecodedEvent, config: StellarConfig) => string;
  /** Optional custom plain-text body wording template (does not affect `entry.id`). */
  formatContent?: (config: StellarConfig, event: DecodedEvent) => string | null;
}

// ---------------------------------------------------------------------------
// Feed document
// ---------------------------------------------------------------------------

export interface AtomFeedOptions extends AtomEntryRenderOptions {
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
 * The entry id is a stable tag URI derived strictly from network, contract, and
 * chain event identity (`tag:mimir,event:<network>:<contract>:<chainEventId>`),
 * independent of wording templates or presentation text.
 */
export function buildAtomEntry(
  event: DecodedEvent,
  config: StellarConfig,
  renderOptions?: AtomEntryRenderOptions,
): AtomEntry {
  const eventName =
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name;

  const title = renderOptions?.formatTitle
    ? renderOptions.formatTitle(event, config)
    : `mimir-${event.source}: ${eventName}`;

  // Use ledger close time if available and looks reasonable (> Unix epoch start),
  // otherwise fall back to a synthetic epoch-based value.
  const updatedDate =
    typeof event.at === "number" && event.at > 0
      ? new Date(event.at * 1000)
      : new Date(0);
  const updated = updatedDate.toISOString();

  const contentRenderer = renderOptions?.formatContent ?? formatPlainTextEvent;
  const rawContent = contentRenderer(config, event);
  const content =
    rawContent !== null
      ? Array.from(rawContent).slice(0, FEED_CONTENT_MAX_CHARS).join("")
      : null;

  const explorerUrl = eventExplorerUrl(config, event);
  const link = explorerUrl ? safeHttpsUrl(explorerUrl) : null;

  const resolvedAppBase =
    renderOptions?.mimirAppUrl ??
    (config as { mimirAppUrl?: string | null }).mimirAppUrl ??
    null;
  const rawAppUrl = appUrlFor(event, resolvedAppBase);
  const appLink = rawAppUrl ? safeHttpsUrl(rawAppUrl) : null;

  const entry: AtomEntry = {
    id: buildAtomEntryId(event, config),
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

  const appLinkEl = entry.appLink
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
    const entry = buildAtomEntry(event, config, options);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}
