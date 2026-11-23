/**
 * One link policy for every notification renderer.
 *
 * MarkdownV2, Telegram HTML and plain text each splice URLs into their output
 * in a different way, but they must agree on which URLs are allowed to become
 * a clickable link. Without a shared gate a renderer that skips the check (the
 * malformed-payload fallbacks did) could emit `javascript:`, `data:`, `tg:` or
 * an empty target — Telegram either rejects the whole message or renders a
 * link the reader cannot trust.
 *
 * Policy (documented in `docs/notification-links.md`):
 * - The only safe scheme is `https:`. Explorer links
 *   (`STELLAR_EXPLORER_BASE_URL`) and Mimir app links (`MIMIR_APP_URL`) both
 *   resolve to `https:` origins in every supported deployment.
 * - The URL must parse, have a host, carry no userinfo, contain no whitespace
 *   or control characters, and stay under {@link MAX_LINK_LENGTH}.
 * - Anything else is rendered as inert text: the label is kept so the reader
 *   still sees that a transaction exists, but nothing is clickable and the
 *   rejected URL itself is never echoed.
 */

/** URL schemes a notification may link to. */
export const SAFE_LINK_PROTOCOLS: readonly string[] = Object.freeze(["https:"]);

/** Longest URL a notification will link; longer values are treated as unsafe. */
export const MAX_LINK_LENGTH = 2048;

/** Whitespace, C0/C1 controls and bidi/zero-width format characters. */
const UNSAFE_URL_CHARS = /[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * Return `url` unchanged when it is safe to render as a link, otherwise null.
 *
 * The original string is returned (not `URL#href`) so links that were already
 * safe render byte-for-byte as before.
 */
export function safeLinkUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  if (url.length === 0 || url.length > MAX_LINK_LENGTH) return null;
  if (UNSAFE_URL_CHARS.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SAFE_LINK_PROTOCOLS.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  return url;
}

/** True when {@link safeLinkUrl} would accept `url`. */
export function isSafeLinkUrl(url: unknown): boolean {
  return safeLinkUrl(url) !== null;
}

/**
 * Escape a URL for the `(...)` part of a MarkdownV2 inline link. Telegram
 * requires `)` and `\` to be backslash-escaped there; safe explorer and app
 * URLs normally contain neither, so their output is unchanged.
 */
export function escapeMdLinkUrl(url: string): string {
  return url.replace(/[)\\]/g, (ch) => `\\${ch}`);
}
