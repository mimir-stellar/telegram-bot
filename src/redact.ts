/**
 * Shared redaction for logs, health JSON, and status text.
 *
 * Telegram API errors often embed the bot token in a request URL
 * (`https://api.telegram.org/bot<token>/…`). Stellar secret keys (`S…` strkeys)
 * must never appear either — this notifier is read-only and must not hold them,
 * but accidental paste into env or error text still needs scrubbing.
 *
 * Belt-and-braces: shape-based patterns catch leaks even when a value was never
 * registered; {@link registerSecret} covers known config values (token, chat id).
 */

/** Values registered at runtime (config secrets) in addition to shape rules. */
const extraSecrets = new Set<string>();

/** Default cap for any single logged / reported string after redaction. */
export const DEFAULT_MAX_LEN = 512;

/** Register a value that must never appear in output. */
export function registerSecret(value: string): void {
  const v = value?.trim();
  if (v && v.length >= 4) extraSecrets.add(v);
}

export function registerSecrets(values: Iterable<string>): void {
  for (const v of values) registerSecret(v);
}

/** Test helper — clears registered secrets between cases. */
export function clearSecrets(): void {
  extraSecrets.clear();
}

/**
 * Shape-based scrubbers. False positives only mangle an error string; false
 * negatives leak credentials.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens: digits:secret (also inside api.telegram.org/bot… URLs).
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "***BOT_TOKEN***"],
  [/(\/bot)\d{6,12}:[A-Za-z0-9_-]{20,}/gi, "$1***BOT_TOKEN***"],
  // Stellar secret-key strkeys (S + 55 base32). Never expected in this process.
  [/\bS[A-Z2-7]{55}\b/g, "***STELLAR_SECRET***"],
  // Long payment-proof / signature style blobs (hex or url-safe base64).
  [/\b(?:0x)?[a-fA-F0-9]{64,}\b/g, "***PROOF***"],
  [/\b[A-Za-z0-9_-]{80,}\b/g, "***PROOF***"],
  // Credentials embedded in URLs.
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1***:***@"],
  // Bearer / Authorization header echoes.
  [/\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, "Bearer ***REDACTED***"],
  [
    /\b(api[_-]?key|authorization|token)\b\s*[:=]\s*[A-Za-z0-9._+/=-]{8,}/gi,
    "$1 ***REDACTED***",
  ],
];

/** Truncate after redaction so remote payloads cannot blow up logs/health. */
export function boundText(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Replace known secrets and credential-shaped substrings, then bound length.
 */
export function redactText(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (!input) return "";
  let out = input;
  // Longest first so a token that is a substring of another still matches cleanly.
  const registered = [...extraSecrets].sort((a, b) => b.length - a.length);
  for (const secret of registered) {
    if (!secret) continue;
    if (out.includes(secret)) out = out.split(secret).join("***REDACTED***");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return boundText(out, maxLen);
}

/** Safe string for an unknown thrown value. */
export function redactError(err: unknown, maxLen: number = DEFAULT_MAX_LEN): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return redactText(`${name}${err.message}`, maxLen);
  }
  if (typeof err === "string") return redactText(err, maxLen);
  if (err === null || err === undefined) return redactText(String(err), maxLen);
  try {
    const encoded = JSON.stringify(err);
    if (typeof encoded === "string") return redactText(encoded, maxLen);
  } catch {
    // fall through
  }
  return redactText(String(err), maxLen);
}
