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
import { appUrlFor } from "../notifications/app-links.js";
import type { ContractSource, DecodedEvent } from "./decode.js";
import type { StellarConfig } from "../config.js";

/** Soroban contract StrKey pattern (`C` + 55 base32 chars = 56 chars). */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;

/** Error raised when a feed filter contains malformed source, contract ID, or event names. */
export class FeedFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedFilterError";
  }
}

export interface FeedFilter {
  /** Filter by logical contract role (`"market"`, `"squad"`, or `"all"`). */
  source?: ContractSource | "all" | string;
  /** Filter by exact Stellar contract StrKey (`C...`, case-insensitive input). */
  contractId?: string | null;
  /** Optional allowlist of event names (`claim_created`, `resolved`, etc.). */
  eventNames?: readonly string[];
}

export interface NormalizedFeedFilter {
  readonly source: ContractSource | "all";
  readonly contractId: string | null;
  readonly eventNames: readonly string[];
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
  /** Optional Mimir web-app deep link when `mimirAppUrl` is configured. */
  appLink?: string | null;
}

// ---------------------------------------------------------------------------
// Feed document & per-contract filtering
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
  /** Optional per-contract / per-source / per-event-name feed filter. */
  filter?: FeedFilter;
  /** Optional Mimir web-app base URL (`MIMIR_APP_URL`) for deep links. */
  mimirAppUrl?: string | null;
}

/**
 * Validate and canonicalize a {@link FeedFilter} so equivalent filter inputs
 * always normalize to an identical representation.
 */
export function normalizeFeedFilter(filter?: FeedFilter | null): NormalizedFeedFilter {
  if (!filter) {
    return { source: "all", contractId: null, eventNames: [] };
  }

  let source: ContractSource | "all" = "all";
  if (filter.source !== undefined && filter.source !== null && filter.source.trim() !== "") {
    const cleanedSource = filter.source.trim().toLowerCase();
    if (cleanedSource !== "all" && cleanedSource !== "market" && cleanedSource !== "squad") {
      throw new FeedFilterError(
        `Invalid feed filter source "${filter.source}" (expected "market", "squad", or "all")`,
      );
    }
    source = cleanedSource;
  }

  let contractId: string | null = null;
  if (filter.contractId !== undefined && filter.contractId !== null && filter.contractId.trim() !== "") {
    const upper = filter.contractId.trim().toUpperCase();
    if (!CONTRACT_ID_RE.test(upper)) {
      throw new FeedFilterError(
        `Invalid feed filter contractId "${filter.contractId}" (expected 56-char Soroban C... address)`,
      );
    }
    contractId = upper;
  }

  const nameSet = new Set<string>();
  if (filter.eventNames !== undefined) {
    if (!Array.isArray(filter.eventNames)) {
      throw new FeedFilterError("Invalid feed filter eventNames (expected an array of event names)");
    }
    for (const rawName of filter.eventNames) {
      if (typeof rawName !== "string") {
        throw new FeedFilterError("Invalid feed filter event name (expected string)");
      }
      const normalized = rawName.trim().toLowerCase();
      if (!normalized) continue;
      if (!EVENT_NAME_RE.test(normalized)) {
        throw new FeedFilterError(
          `Invalid feed filter event name "${rawName}" (expected lowercase snake_case identifier)`,
        );
      }
      nameSet.add(normalized);
    }
  }

  const eventNames = [...nameSet].sort();
  return { source, contractId, eventNames };
}

/**
 * Parse URL query parameters (`?contract=...&source=...&event=...`) into a
 * validated {@link NormalizedFeedFilter}. Rejects unknown query keys so typos
 * cannot silently broaden a filtered feed into an unfiltered response.
 */
export function parseFeedFilterParams(
  params: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
): NormalizedFeedFilter {
  const search =
    params instanceof URLSearchParams
      ? params
      : (() => {
          const built = new URLSearchParams();
          for (const [k, v] of Object.entries(params)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) built.append(k, String(item));
            } else {
              built.append(k, String(v));
            }
          }
          return built;
        })();

  const allowedKeys = new Set(["contract", "contractId", "source", "event"]);
  for (const key of search.keys()) {
    if (!allowedKeys.has(key)) {
      throw new FeedFilterError(`Unsupported feed filter query parameter "${key}"`);
    }
  }

  const contracts = [
    ...search.getAll("contract"),
    ...search.getAll("contractId"),
  ]
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (contracts.length > 1) {
    const distinct = new Set(contracts.map((c) => c.toUpperCase()));
    if (distinct.size > 1) {
      throw new FeedFilterError("Conflicting contract filter parameters supplied");
    }
  }

  const sources = search
    .getAll("source")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (sources.length > 1) {
    const distinct = new Set(sources.map((s) => s.toLowerCase()));
    if (distinct.size > 1) {
      throw new FeedFilterError("Conflicting source filter parameters supplied");
    }
  }

  const eventNames: string[] = [];
  for (const raw of search.getAll("event")) {
    for (const part of raw.split(",")) {
      if (part.trim().length > 0) eventNames.push(part);
    }
  }

  return normalizeFeedFilter({
    source: sources[0],
    contractId: contracts[0] ?? null,
    eventNames,
  });
}

function effectiveEventName(event: DecodedEvent): string {
  return (
    event.payload.name === "unknown"
      ? (event.payload.eventName ?? "unknown")
      : event.payload.name
  )
    .trim()
    .toLowerCase();
}

/**
 * Return only events matching `filter` without mutating the input array.
 */
export function filterFeedEvents(
  events: readonly DecodedEvent[],
  filter?: FeedFilter | NormalizedFeedFilter | null,
): DecodedEvent[] {
  const norm = normalizeFeedFilter(filter);
  if (norm.source === "all" && norm.contractId === null && norm.eventNames.length === 0) {
    return [...events];
  }

  const allowedNames = norm.eventNames.length > 0 ? new Set(norm.eventNames) : null;
  return events.filter((event) => {
    if (norm.source !== "all" && event.source !== norm.source) {
      return false;
    }
    if (norm.contractId !== null && event.contractId.trim().toUpperCase() !== norm.contractId) {
      return false;
    }
    if (allowedNames !== null && !allowedNames.has(effectiveEventName(event))) {
      return false;
    }
    return true;
  });
}

function isDefaultFilter(filter: NormalizedFeedFilter): boolean {
  return filter.source === "all" && filter.contractId === null && filter.eventNames.length === 0;
}

function canonicalFilteredSelfUrl(selfUrl: string, filter: NormalizedFeedFilter): string {
  if (isDefaultFilter(filter)) return selfUrl;
  const safe = safeHttpsUrl(selfUrl);
  if (safe === null) return selfUrl;

  const parsed = new URL(safe);
  parsed.searchParams.delete("contract");
  parsed.searchParams.delete("contractId");
  parsed.searchParams.delete("source");
  parsed.searchParams.delete("event");

  if (filter.contractId !== null) {
    parsed.searchParams.set("contract", filter.contractId);
  }
  if (filter.source !== "all") {
    parsed.searchParams.set("source", filter.source);
  }
  if (filter.eventNames.length > 0) {
    parsed.searchParams.set("event", filter.eventNames.join(","));
  }
  return parsed.toString();
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
  const normalizedFilter = normalizeFeedFilter(options.filter);
  const filteredEvents = filterFeedEvents(events, normalizedFilter);
  const effectiveSelfUrl = canonicalFilteredSelfUrl(selfUrl, normalizedFilter);

  // Feed <updated>: caller override → latest event.at → epoch (when filtered empty) or now.
  let feedUpdated: string;
  if (options.updatedAt) {
    feedUpdated = options.updatedAt;
  } else if (filteredEvents.length > 0) {
    const maxAt = filteredEvents.reduce((best, e) => Math.max(best, e.at ?? 0), 0);
    feedUpdated = new Date(maxAt > 0 ? maxAt * 1000 : Date.now()).toISOString();
  } else {
    feedUpdated = new Date().toISOString();
  }

  const validSelfUrl = safeHttpsUrl(effectiveSelfUrl) ?? "";

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title type="text">${xmlText(title, FEED_TITLE_MAX_CHARS)}</title>`,
  ];

  if (subtitle) {
    lines.push(`  <subtitle type="text">${xmlText(subtitle, FEED_TITLE_MAX_CHARS)}</subtitle>`);
  }

  lines.push(
    `  <id>${escapeXml(validSelfUrl || effectiveSelfUrl)}</id>`,
    `  <updated>${escapeXml(feedUpdated)}</updated>`,
  );

  if (validSelfUrl) {
    lines.push(
      `  <link rel="self" type="application/atom+xml" href="${escapeXml(validSelfUrl)}"/>`,
    );
  }

  for (const event of filteredEvents) {
    const entry = buildAtomEntry(event, config, options.mimirAppUrl);
    lines.push(renderEntry(entry));
  }

  lines.push("</feed>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stable cache identities & bounded per-filter feed cache
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic cache identity for a feed configuration and its
 * normalized per-contract filter.
 *
 * Uses JSON-tuple serialization inside SHA-256 so field boundaries cannot be
 * spoofed and equivalent filters (regardless of casing, whitespace, or
 * event-name order) always resolve to the exact same key, while distinct
 * contracts or sources never collide.
 */
export function buildFeedCacheKey(options: AtomFeedOptions): string {
  const norm = normalizeFeedFilter(options.filter);
  const resolvedAppUrl =
    options.mimirAppUrl ??
    (options.config as { mimirAppUrl?: string | null }).mimirAppUrl ??
    null;

  const canonicalPayload = JSON.stringify({
    v: 1,
    filter: {
      source: norm.source,
      contractId: norm.contractId,
      eventNames: norm.eventNames,
    },
    feed: {
      title: options.title,
      subtitle: options.subtitle ?? null,
      selfUrl: canonicalFilteredSelfUrl(options.selfUrl, norm),
      updatedAt: options.updatedAt ?? null,
      locale: options.config.locale ?? "en",
      networkPassphrase: options.config.networkPassphrase,
      explorerBaseUrl: options.config.explorerBaseUrl,
      mimirAppUrl: resolvedAppUrl,
    },
  });

  const digest = createHash("sha256").update(canonicalPayload).digest("hex").slice(0, 32);
  const scope = [
    `src=${norm.source}`,
    `cid=${norm.contractId ?? "*"}`,
    `ev=${norm.eventNames.length > 0 ? norm.eventNames.join(",") : "*"}`,
  ].join(";");
  return `mimir-feed:v1:${scope}:${digest}`;
}

function computeEventsRevision(events: readonly DecodedEvent[]): string {
  const hash = createHash("sha256");
  hash.update(`n=${events.length}\n`);
  for (const event of events) {
    hash.update(
      JSON.stringify([
        event.source,
        event.contractId,
        event.ledger,
        event.txHash,
        event.eventId,
        event.at ?? 0,
        event.payload.name,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export interface FeedCacheLookupResult {
  xml: string;
  cacheKey: string;
  revision: string;
  filter: NormalizedFeedFilter;
  entryCount: number;
  fromCache: boolean;
}

export interface FeedCache {
  getAtomFeed(events: readonly DecodedEvent[], options: AtomFeedOptions): FeedCacheLookupResult;
  size(): number;
  clear(): void;
}

export interface FeedCacheOptions {
  /** Maximum distinct filter cache entries retained (LRU eviction, default 32). */
  maxEntries?: number;
}

/**
 * Create a bounded LRU feed cache isolated by {@link buildFeedCacheKey}.
 *
 * Each normalized filter caches its own rendered Atom XML alongside the
 * filtered event revision, preventing one contract's feed response from ever
 * leaking into another contract's or unfiltered subscriber's response.
 */
export function createFeedCache(cacheOptions: FeedCacheOptions = {}): FeedCache {
  const maxEntries = Math.max(1, Math.trunc(cacheOptions.maxEntries ?? 32));
  const store = new Map<
    string,
    { revision: string; xml: string; entryCount: number; filter: NormalizedFeedFilter }
  >();

  return {
    getAtomFeed(
      events: readonly DecodedEvent[],
      options: AtomFeedOptions,
    ): FeedCacheLookupResult {
      const normalizedFilter = normalizeFeedFilter(options.filter);
      const cacheKey = buildFeedCacheKey({ ...options, filter: normalizedFilter });
      const matchingEvents = filterFeedEvents(events, normalizedFilter);
      const revision = computeEventsRevision(matchingEvents);

      const cached = store.get(cacheKey);
      if (cached && cached.revision === revision) {
        // Refresh LRU order
        store.delete(cacheKey);
        store.set(cacheKey, cached);
        return {
          xml: cached.xml,
          cacheKey,
          revision,
          filter: cached.filter,
          entryCount: cached.entryCount,
          fromCache: true,
        };
      }

      const deterministicUpdatedAt =
        options.updatedAt ??
        (matchingEvents.length > 0
          ? (() => {
              const maxAt = matchingEvents.reduce((best, e) => Math.max(best, e.at ?? 0), 0);
              return new Date(maxAt > 0 ? maxAt * 1000 : 0).toISOString();
            })()
          : new Date(0).toISOString());

      const xml = buildAtomFeed(matchingEvents, {
        ...options,
        filter: normalizedFilter,
        updatedAt: deterministicUpdatedAt,
      });

      if (store.has(cacheKey)) {
        store.delete(cacheKey);
      } else if (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }

      const entry = {
        revision,
        xml,
        entryCount: matchingEvents.length,
        filter: normalizedFilter,
      };
      store.set(cacheKey, entry);

      return {
        xml,
        cacheKey,
        revision,
        filter: normalizedFilter,
        entryCount: matchingEvents.length,
        fromCache: false,
      };
    },

    size(): number {
      return store.size;
    },

    clear(): void {
      store.clear();
    },
  };
}
