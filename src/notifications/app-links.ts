/**
 * Deep links from a notification to the Mimir web app.
 *
 * The explorer button answers "what happened on-chain"; this button answers
 * "where do I act on it". A claim event links to the claim page, a squad
 * market event to the market page, and anything without a page — fees,
 * withdrawals, admin records, undecodable payloads — returns null so it earns
 * no button rather than a link to the wrong place.
 *
 * `baseUrl` is `MIMIR_APP_URL`, validated as an https origin when the config
 * is loaded. It is checked again here so a hand-built config object cannot
 * point the button at a non-https or unparseable origin.
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** Route under the app for each event family. */
type AppRoute = "claims" | "squads";

/** The page an event points at: a route plus its encoded-ready id. */
export interface AppTarget {
  route: AppRoute;
  id: string;
}

/**
 * Longest id accepted from a payload before the event is treated as having no
 * page. Ids are contract integers; the cap only keeps a hand-crafted string
 * payload from growing an unbounded URL.
 */
const MAX_ID_LENGTH = 64;

/** Normalise a payload id into a path segment, or null when unusable. */
function segmentId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
  }
  return null;
}

/**
 * The app page for an event, or null when the event has none.
 *
 * Grouped `case` labels keep the mapping next to the payload names the
 * notification templates use, so a new claim-shaped event is added in two
 * places at once instead of drifting apart.
 */
export function appTargetFor(event: DecodedEvent): AppTarget | null {
  const payload = event?.payload;
  if (!payload) return null;

  let id: string | null = null;
  switch (payload.name) {
    // mimir-market: events that carry the claim's id.
    case "claim_created":
    case "claim_challenged":
    case "claim_resolved":
    case "claim_cancelled":
    case "market_settled":
    case "challenger_paid":
      id = segmentId(payload.claimId);
      return id === null ? null : { route: "claims", id };

    // mimir-squad: events that carry the market's id.
    case "market_created":
    case "deposited":
    case "withdrawn":
    case "resolved":
    case "claimed":
      id = segmentId(payload.marketId);
      return id === null ? null : { route: "squads", id };

    // Contract-level money movements, admin records and unknown payloads have
    // no page of their own.
    default:
      return null;
  }
}

export type UnsafeHttpsUrlReason =
  | "empty"
  | "control_chars"
  | "non_https_scheme"
  | "userinfo_present"
  | "invalid_host"
  | "invalid_url";

export type SafeHttpsUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: UnsafeHttpsUrlReason };

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isValidParsedHostname(hostname: string, rawHostBeforePort: string): boolean {
  if (!hostname || hostname.length > 253) return false;

  // Reject single-integer IPv4 encodings such as https://2130706433
  if (/^\d+$/.test(rawHostBeforePort)) return false;

  // IPv6 literal validated by WHATWG URL parser
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.length > 2;
  }

  // Dotted-quad IPv4 literal
  if (IPV4_RE.test(hostname)) {
    return hostname.split(".").every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  if (hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("%")) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.some((label) => !DNS_LABEL_RE.test(label))) {
    return false;
  }

  // Multi-label DNS names cannot end in an all-numeric TLD
  const lastLabel = labels[labels.length - 1] ?? "";
  if (labels.length > 1 && /^\d+$/.test(lastLabel)) {
    return false;
  }

  return true;
}

/**
 * Validate scheme (`https:`), absence of userinfo/credentials (including empty
 * `@` authorities such as `https://@example.com`), and host syntax before a
 * base URL is used to construct app or feed links.
 */
export function validateSafeHttpsBaseUrl(
  rawUrl: string | null | undefined,
): SafeHttpsUrlValidation {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { ok: false, reason: "empty" };
  }

  // Reject C0/DEL control bytes anywhere in the raw string
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(rawUrl)) {
    return { ok: false, reason: "control_chars" };
  }

  if (!/^https:\/\//i.test(rawUrl)) {
    let probe: URL | null = null;
    try {
      probe = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    return {
      ok: false,
      reason: probe.protocol === "https:" ? "invalid_host" : "non_https_scheme",
    };
  }

  // Reject scheme-relative / triple-slash or backslash authority confusion (https:///x, https://\x)
  const afterScheme = rawUrl.slice("https://".length);
  if (afterScheme.length === 0 || afterScheme.startsWith("/") || afterScheme.startsWith("\\")) {
    return { ok: false, reason: "invalid_host" };
  }

  const authorityEnd = afterScheme.search(/[/\\?#]/);
  const rawAuthority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);

  // If the delimiter that ended authority was a backslash before `/`, `?`, `#`, reject it
  if (authorityEnd !== -1 && afterScheme[authorityEnd] === "\\") {
    return { ok: false, reason: "invalid_host" };
  }

  // Reject any userinfo separator (`@`), including empty credentials `https://@host`
  if (rawAuthority.includes("@")) {
    return { ok: false, reason: "userinfo_present" };
  }

  if (rawAuthority.length === 0 || /\s/.test(rawAuthority)) {
    return { ok: false, reason: "invalid_host" };
  }

  let rawHostBeforePort = rawAuthority;
  if (rawAuthority.startsWith("[")) {
    const closeBracket = rawAuthority.indexOf("]");
    if (closeBracket === -1) return { ok: false, reason: "invalid_host" };
    rawHostBeforePort = rawAuthority.slice(0, closeBracket + 1);
  } else {
    const colonIdx = rawAuthority.indexOf(":");
    if (colonIdx !== -1) {
      rawHostBeforePort = rawAuthority.slice(0, colonIdx);
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "non_https_scheme" };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "userinfo_present" };
  }

  if (!isValidParsedHostname(parsed.hostname, rawHostBeforePort)) {
    return { ok: false, reason: "invalid_host" };
  }

  return { ok: true, url: parsed };
}

/**
 * The Mimir web-app URL for an event, or null when there is nothing to open.
 *
 * Validates scheme, userinfo, and host on `baseUrl` so credential-bearing or
 * malformed base URLs never generate links. Trailing slashes on the base are
 * collapsed so `https://app.example/` and `https://app.example` produce the
 * same link, and the id goes through `encodeURIComponent` so an unexpected
 * payload value cannot inject a query, fragment or extra path segment.
 */
export function appUrlFor(
  event: DecodedEvent,
  baseUrl: string | null | undefined,
): string | null {
  if (!baseUrl) return null;
  const target = appTargetFor(event);
  if (target === null) return null;

  const validated = validateSafeHttpsBaseUrl(baseUrl);
  if (!validated.ok) return null;

  const base = validated.url;
  base.search = "";
  base.hash = "";
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/${target.route}/${encodeURIComponent(target.id)}`;
  return base.toString();
}
