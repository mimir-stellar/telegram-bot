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
import type http from "node:http";
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
  /** Optional sanitized HTTPS Mimir web-app deep link when configured. */
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
  /** Optional Mimir web-app base URL (`MIMIR_APP_URL`). */
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

  const explorerUrl = eventExplorerUrl(config, event);
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

// ---------------------------------------------------------------------------
// Deterministic ETag / Last-Modified & conditional HTTP responder (RFC 9110)
// ---------------------------------------------------------------------------

export interface FeedConditionalMetadata {
  /** Strong quoted entity-tag (`"sha256-<hex>"`) derived deterministically from events + options. */
  etag: string;
  /** RFC 9110 IMF-fixdate (`toUTCString()`) at 1-second HTTP-date precision. */
  lastModified: string;
  /** Epoch milliseconds corresponding to `lastModified` (whole-second precision). */
  lastModifiedMs: number;
  /** ISO 8601 representation of `lastModifiedMs` for deterministic `<updated>` rendering. */
  lastModifiedIso: string;
}

function feedBigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Compute deterministic `ETag` and `Last-Modified` metadata from retained
 * events and feed options without serializing XML.
 */
export function computeFeedConditionalMetadata(
  events: readonly DecodedEvent[],
  options: AtomFeedOptions,
): FeedConditionalMetadata {
  let lastModifiedMs = 0;
  if (options.updatedAt !== undefined) {
    const parsed = Date.parse(options.updatedAt);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      lastModifiedMs = Math.floor(parsed / 1000) * 1000;
    }
  } else if (events.length > 0) {
    let maxAt = 0;
    for (const event of events) {
      if (typeof event.at === "number" && Number.isFinite(event.at) && event.at > maxAt) {
        maxAt = event.at;
      }
    }
    if (maxAt > 0) {
      lastModifiedMs = Math.floor(maxAt) * 1000;
    }
  }

  const lastModifiedDate = new Date(lastModifiedMs);
  const lastModified = lastModifiedDate.toUTCString();
  const lastModifiedIso = lastModifiedDate.toISOString();

  const resolvedAppUrl =
    options.mimirAppUrl ??
    (options.config as { mimirAppUrl?: string | null }).mimirAppUrl ??
    null;

  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      v: 1,
      title: options.title,
      subtitle: options.subtitle ?? null,
      selfUrl: options.selfUrl,
      updatedAt: options.updatedAt ?? lastModifiedIso,
      locale: options.config.locale ?? "en",
      networkPassphrase: options.config.networkPassphrase,
      explorerBaseUrl: options.config.explorerBaseUrl,
      mimirAppUrl: resolvedAppUrl,
      count: events.length,
    }),
  );
  hash.update("\n");

  for (const event of events) {
    hash.update(
      JSON.stringify(
        [
          event.source,
          event.contractId,
          event.version,
          event.ledger,
          event.txHash,
          event.eventId,
          event.at ?? 0,
          event.transactionIndex ?? null,
          event.operationIndex ?? null,
          event.payload,
        ],
        feedBigIntReplacer,
      ),
    );
    hash.update("\n");
  }

  const etag = `"sha256-${hash.digest("hex")}"`;
  return {
    etag,
    lastModified,
    lastModifiedMs,
    lastModifiedIso,
  };
}

function normalizeOpaqueTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  const withoutWeak = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  if (withoutWeak.length >= 2 && withoutWeak.startsWith('"') && withoutWeak.endsWith('"')) {
    return withoutWeak;
  }
  return null;
}

function headerString(
  headers: http.IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v.join(", ");
      return v;
    }
  }
  return undefined;
}

/**
 * Evaluate `If-None-Match` and `If-Modified-Since` preconditions per RFC 9110
 * §13.1.2 / §13.1.3 / §13.2.2 (`If-None-Match` takes precedence over `If-Modified-Since`).
 *
 * Returns `true` when the client's cached representation is still fresh (`304 Not Modified`).
 */
export function isFeedNotModified(
  headers: http.IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>,
  metadata: FeedConditionalMetadata,
): boolean {
  const rawInm = headerString(headers, "if-none-match");
  if (rawInm !== undefined && rawInm.trim().length > 0) {
    const targetOpaque = normalizeOpaqueTag(metadata.etag);
    // Match `*` or comma-separated entity-tags (weak comparison per RFC 9110 §13.1.2)
    if (rawInm.trim() === "*") return true;
    const candidates = rawInm.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
    for (const candidate of candidates) {
      const opaque = normalizeOpaqueTag(candidate);
      if (opaque === "*" || (opaque !== null && opaque === targetOpaque)) {
        return true;
      }
    }
    // RFC 9110 §13.2.2: ignore If-Modified-Since when If-None-Match is present
    return false;
  }

  const rawIms = headerString(headers, "if-modified-since");
  if (rawIms !== undefined && rawIms.trim().length > 0) {
    const parsedIms = Date.parse(rawIms.trim());
    if (!Number.isNaN(parsedIms)) {
      return parsedIms >= metadata.lastModifiedMs;
    }
  }

  return false;
}

export interface ConditionalFeedResponderOptions {
  /** Reader returning the current retained decoded events. */
  getEvents: () => readonly DecodedEvent[];
  /** Reader returning the `AtomFeedOptions` for a given request. */
  getOptions: (req?: http.IncomingMessage) => AtomFeedOptions;
  /** Optional custom renderer (defaults to {@link buildAtomFeed}; handy for build-count tests). */
  renderFeed?: (events: readonly DecodedEvent[], options: AtomFeedOptions) => string;
}

export interface FeedHttpResult {
  statusCode: 200 | 304 | 405;
  headers: Record<string, string>;
  body: string;
  rebuilt: boolean;
}

export interface ConditionalFeedResponder {
  evaluate(
    method: string,
    headers: http.IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>,
    req?: http.IncomingMessage,
  ): FeedHttpResult;
  handle(req: http.IncomingMessage, res: http.ServerResponse): void;
  buildCount(): number;
}

/**
 * Create a stateful HTTP responder for the Atom event feed that computes
 * deterministic `ETag` and `Last-Modified` metadata up front, answers matching
 * conditional requests with `304 Not Modified` without rebuilding XML, and
 * reuses the cached XML across unconditional requests while events are unchanged.
 */
export function createConditionalFeedResponder(
  config: ConditionalFeedResponderOptions,
): ConditionalFeedResponder {
  const render = config.renderFeed ?? buildAtomFeed;
  let cached: { etag: string; xml: string } | null = null;
  let builds = 0;

  function evaluate(
    method: string,
    headers: http.IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>,
    req?: http.IncomingMessage,
  ): FeedHttpResult {
    const upperMethod = method.toUpperCase();
    if (upperMethod !== "GET" && upperMethod !== "HEAD") {
      const errBody = `${JSON.stringify({ ok: false, error: "method_not_allowed" })}\n`;
      return {
        statusCode: 405,
        headers: {
          allow: "GET, HEAD",
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(Buffer.byteLength(errBody)),
        },
        body: errBody,
        rebuilt: false,
      };
    }

    const events = config.getEvents();
    const options = config.getOptions(req);
    const meta = computeFeedConditionalMetadata(events, options);

    if (isFeedNotModified(headers, meta)) {
      return {
        statusCode: 304,
        headers: {
          etag: meta.etag,
          "last-modified": meta.lastModified,
          "cache-control": "private, no-cache",
        },
        body: "",
        rebuilt: false,
      };
    }

    let xml: string;
    let rebuilt = false;
    if (cached !== null && cached.etag === meta.etag) {
      xml = cached.xml;
    } else {
      xml = render(events, {
        ...options,
        updatedAt: options.updatedAt ?? meta.lastModifiedIso,
      });
      cached = { etag: meta.etag, xml };
      builds += 1;
      rebuilt = true;
    }

    const byteLength = Buffer.byteLength(xml, "utf8");
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/atom+xml; charset=utf-8",
        etag: meta.etag,
        "last-modified": meta.lastModified,
        "cache-control": "private, no-cache",
        "content-length": String(byteLength),
      },
      body: upperMethod === "HEAD" ? "" : xml,
      rebuilt,
    };
  }

  return {
    evaluate,
    handle(req: http.IncomingMessage, res: http.ServerResponse): void {
      const result = evaluate(req.method ?? "GET", req.headers, req);
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    },
    buildCount(): number {
      return builds;
    },
  };
}
