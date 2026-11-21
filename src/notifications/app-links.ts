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
 *
 * ── Privacy contract (#924) ────────────────────────────────────────────────
 * Every emitted URL passes through {@link sanitizeShareLink}. That helper
 * keeps a public allowlist of query keys (`id`, `market`, `claim`, `side`,
 * `tab`, `view`, `lang`) and drops an explicit private-key denylist
 * (`token`, `invite`, `ref`, `access`, `key`, `secret`, `sig`, `signature`,
 * `auth`, `password`, `code`). The fragment is dropped whenever a private
 * key was present. A URL with no private keys is returned byte-identical.
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

/**
 * Query keys that identify a *public* market/claim/squad and are safe to
 * preserve verbatim.
 */
const PUBLIC_QUERY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "market",
  "claim",
  "side",
]);

/**
 * Query keys that must never appear in a general notification. These are the
 * standard shapes an invite/access/share-link uses to carry a secret, plus
 * the generic credential keys already known to `redact.ts`.
 */
const PRIVATE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "invite",
  "ref",
  "access",
  "key",
  "secret",
  "sig",
  "signature",
  "auth",
  "password",
  "code",
]);

/**
 * Neutral query keys that may pass through unchanged: they do not identify a
 * user and are useful for deep-link routing.
 */
const NEUTRAL_QUERY_KEYS: ReadonlySet<string> = new Set([
  "tab",
  "view",
  "lang",
]);

/**
 * Return a sanitized copy of `url` with private query keys and (when one was
 * present) the fragment removed, or `null` when the input is not a usable
 * absolute http(s) URL.
 *
 * - Public and neutral query keys are preserved verbatim, in original order.
 * - Any other query key is preserved as-is (unknown ≠ private).
 * - Private query keys are dropped from every occurrence.
 * - The fragment is dropped when the URL carried a private key; otherwise it
 *   is preserved verbatim.
 * - A URL with no private keys is returned byte-identical to its input.
 * - Embedded userinfo (user/password) is always removed.
 */
export function sanitizeShareLink(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }

  const entries: [string, string][] = [];
  let sawPrivate = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (PRIVATE_QUERY_KEYS.has(key)) {
      sawPrivate = true;
      continue;
    }
    if (PUBLIC_QUERY_KEYS.has(key) || NEUTRAL_QUERY_KEYS.has(key)) {
      entries.push([key, value]);
    } else {
      entries.push([key, value]);
    }
  }

  if (sawPrivate) {
    parsed.hash = "";
  }

  const next = new URLSearchParams();
  for (const [k, v] of entries) next.append(k, v);
  parsed.search = next.toString();

  const serialized = parsed.toString();
  return serialized === url ? url : serialized;
}

/**
 * The Mimir web-app URL for an event, or null when there is nothing to open.
 *
 * Trailing slashes on the base are collapsed so `https://app.example/` and
 * `https://app.example` produce the same link, and the id goes through
 * `encodeURIComponent` so an unexpected payload value cannot inject a query,
 * fragment or extra path segment. Base URLs that are not `https:`, lack a
 * host, or contain userinfo (`username` / `password`) are rejected. The final
 * URL is passed through {@link sanitizeShareLink} so private query keys cannot
 * leak into a notification.
 */
export function appUrlFor(
  event: DecodedEvent,
  baseUrl: string | null | undefined,
): string | null {
  if (!baseUrl) return null;
  const target = appTargetFor(event);
  if (target === null) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  if (base.username !== "" || base.password !== "") return null;
  if (!base.hostname) return null;

  base.search = "";
  base.hash = "";
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/${target.route}/${encodeURIComponent(target.id)}`;
  return sanitizeShareLink(base.toString());
}
