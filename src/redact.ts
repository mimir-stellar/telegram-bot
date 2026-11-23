/**
 * Shared redaction for operator-facing error text: logs, `/status`, and
 * `GET /health`.
 *
 * `audit.ts` already redacts the operator audit trail with a proven rule set
 * (`DEFAULT_REDACTION_RULES`) and clamps every detail. Error text that leaves
 * the process the other way — the lines an operator reads in `docker logs`, the
 * `lastError` in the status snapshot, the `poller.lastError` in the health JSON
 * — had a weaker story: only caller-supplied secrets and the Telegram bot token
 * shape were scrubbed. A seed strkey pasted into the wrong variable, or an RPC
 * endpoint carrying credentials in its userinfo, would have been printed
 * verbatim.
 *
 * This module closes that gap with the same shapes the audit trail uses, minus
 * the one rule that must not apply here: the audit trail replaces any ≥40-char
 * opaque token, which is right for a trail that is meant to be pasted into an
 * issue, but wrong for error text, where a transaction hash or a resume cursor
 * is the most useful part of the message. Everything else — URL userinfo,
 * secret-shaped path segments, repeated or array-style credential query
 * parameters, URL fragments, bearer tokens, and `token=…`/`authorization: …`
 * pairs — is scrubbed, and the result is length bounded so a hostile endpoint
 * cannot write an unbounded blob into a log line or a health response.
 */

/** Placeholder, matching the wording the status/health surfaces already use. */
export const REDACTED = "[REDACTED]";

/**
 * Terminal escape and control sequence patterns:
 *  - OSC (`ESC ] ... BEL/ST` or 8-bit `0x9d ...`), including unterminated OSC
 *  - DCS/SOS/PM/APC control strings (`ESC P/X/^/_ ... ST` or 8-bit equivalents)
 *  - CSI / ANSI sequences (`ESC [ ... final` or 8-bit `0x9b ...`)
 *  - 2-byte / nF ESC sequences (`ESC ... final`, e.g. `ESC c` terminal reset)
 *  - Remaining C0/C1 control characters except `\t` (0x09) and `\n` (0x0a)
 *
 * Ordinary Unicode (accented Latin, CJK, Arabic, Hebrew, emoji, punctuation)
 * sits at U+00A0 and above and is preserved verbatim.
 */
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  [
    // OSC (Operating System Command): ESC ] ... (BEL | ST | end)
    "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c]*(?:\\x07|\\x1b\\\\|\\x9c|$)",
    // DCS, SOS, PM, APC control strings: ESC P/X/^/_ ... (ST | end)
    "(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c]*(?:\\x1b\\\\|\\x9c|$)",
    // CSI (Control Sequence Introducer): ESC [ params intermediates final?
    "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?",
    // Other ESC sequences (e.g. ESC c, ESC ( B)
    "\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]",
    // Remaining C0/C1 controls except tab (\x09) and newline (\x0a)
    "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]",
  ].join("|"),
  "g",
);

/**
 * Strip ANSI/CSI, OSC, and other terminal control sequences from untrusted text
 * while preserving ordinary Unicode content, tabs, and newlines.
 */
export function stripTerminalEscapes(input: string): string {
  if (!input) return "";
  return input.replace(TERMINAL_ESCAPE_PATTERN, "");
}

/**
 * Default cap for redacted error text. Matches `safeErrorMessage`'s historical
 * bound so this module is a drop-in for the callers that already rely on it.
 */
export const DEFAULT_MAX_LEN = 240;

/**
 * Values registered at runtime (config secrets) in addition to the shape rules.
 *
 * Boot registers the bot token and the chat id here so a new call site cannot
 * leak them by forgetting to pass a `secrets` argument: the registration is
 * process-wide, and `format.ts` consults it on every call.
 */
const registered = new Set<string>();

/**
 * Register a value that must never appear in operator-facing text. Values
 * shorter than 4 characters are ignored: they would match inside ordinary words
 * and redact the whole message into noise.
 */
export function registerSecret(value: string): void {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length >= 4) registered.add(trimmed);
}

/** Register several secrets at once (boot config). */
export function registerSecrets(values: Iterable<string>): void {
  for (const value of values) registerSecret(value);
}

/** Registered secrets, longest first, so a substring never wins over its host. */
export function registeredSecrets(): string[] {
  return [...registered].sort((a, b) => b.length - a.length);
}

/** Test helper — clears the registry between cases. */
export function clearSecrets(): void {
  registered.clear();
}

/**
 * Privacy review mode for shareable event archives. Detects private chat
 * identifiers and secret-shaped values in a text payload and produces a
 * deterministic findings report. Pure: no network, no I/O.
 */
export interface PrivacyFinding {
  kind: "telegram_chat_id" | "secret";
  rule: string;
  offset: number;
  length: number;
  preview: string;
}

export interface PrivacyReport {
  ok: boolean;
  count: number;
  findings: PrivacyFinding[];
}

const PRIVACY_RULES: readonly { kind: PrivacyFinding["kind"]; rule: string; pattern: RegExp }[] = [
  // Private chat ids: negative group/supergroup ids and large positive user ids.
  { kind: "telegram_chat_id", rule: "chat_id_negative", pattern: /(?<![\w-])-100\d{7,}\b/g },
  { kind: "telegram_chat_id", rule: "chat_id_positive", pattern: /(?<![\w.-])\d{9,12}(?![\w.-])/g },
  { kind: "secret", rule: "telegram_bot_token", pattern: /\b\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { kind: "secret", rule: "stellar_seed", pattern: /\bS[A-Z2-7]{55}\b/g },
  { kind: "secret", rule: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi },
  { kind: "secret", rule: "url_userinfo", pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/gi },
];

function previewOf(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

/**
 * Scan text for private chat identifiers and secret-shaped values. Findings are
 * sorted by offset then rule so the report is deterministic. Matches are
 * previewed, never echoed in full.
 */
export function privacyReview(input: string): PrivacyReport {
  const findings: PrivacyFinding[] = [];
  if (input) {
    for (const { kind, rule, pattern } of PRIVACY_RULES) {
      for (const match of input.matchAll(pattern)) {
        const value = match[0];
        findings.push({
          kind,
          rule,
          offset: match.index ?? 0,
          length: value.length,
          preview: previewOf(value),
        });
      }
    }
  }
  findings.sort((a, b) =>
    a.offset - b.offset || a.rule.localeCompare(b.rule) || a.length - b.length
  );
  return { ok: findings.length === 0, count: findings.length, findings };
}

/**
 * One redaction rule: a pattern and its replacement. A function replacement
 * decides per match, which is how public chain identifiers survive.
 */
export interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

interface FnRedactionRule {
  pattern: RegExp;
  replacement: (match: string) => string;
}

/** Credentials in a URL's userinfo: `https://user:pass@rpc.example` or `https://token@rpc.example`. */
const URL_USERINFO: RedactionRule = {
  pattern: /(\b(?:https?|wss?):\/\/)[^/?#\s@]*@/gi,
  replacement: `$1${REDACTED}@`,
};

const CREDENTIAL_KEY_TOKENS = new Set([
  "token",
  "tokens",
  "key",
  "keys",
  "apikey",
  "apikeys",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "pass",
  "pwd",
  "auth",
  "authorization",
  "bearer",
  "jwt",
  "credential",
  "credentials",
  "sig",
  "signature",
  "seed",
  "privatekey",
  "session",
  "sessionid",
  "cookie",
  "hmac",
]);

const SAFE_COMPOSITE_KEYS = new Set([
  "public_key",
  "publickey",
  "public-key",
  "sort_key",
  "sortkey",
  "sort-key",
  "partition_key",
  "idempotency_key",
]);

const TELEGRAM_BOT_TOKEN_EXACT_OR_EMBEDDED =
  /(?:^|(?<![A-Za-z0-9_-]))(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const STELLAR_SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/g;
const PUBLIC_TX_HASH_EXACT = /^[0-9a-fA-F]{64}$/;
const PUBLIC_STELLAR_STRKEY_EXACT = /^[GCM][A-Z2-7]{55,68}$/;
const NUMERIC_OR_CURSOR_EXACT = /^\d+(?:-\d+)?$/;
const JWT_SHAPE_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const PREFIXED_API_KEY_RE =
  /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|whsec_[A-Za-z0-9_-]{12,})\b/g;
const INLINE_URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

function safeDecodeURIComponent(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitIdentifierWords(rawKey: string): string[] {
  const decoded = safeDecodeURIComponent(rawKey).trim();
  if (!decoded) return [];
  if (SAFE_COMPOSITE_KEYS.has(decoded.toLowerCase())) return [];
  const expanded = decoded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return expanded
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

function isCredentialParamKey(rawKey: string): boolean {
  const words = splitIdentifierWords(rawKey);
  if (words.length === 0) return false;
  for (const word of words) {
    if (CREDENTIAL_KEY_TOKENS.has(word)) return true;
  }
  return CREDENTIAL_KEY_TOKENS.has(words.join(""));
}

function isSafeDiagnosticToken(value: string, placeholder: string): boolean {
  if (!value || value === placeholder || value.includes(placeholder)) return true;
  if (PUBLIC_TX_HASH_EXACT.test(value)) return true;
  if (PUBLIC_STELLAR_STRKEY_EXACT.test(value)) return true;
  if (NUMERIC_OR_CURSOR_EXACT.test(value)) return true;
  return false;
}

function isOpaqueSecretToken(rawValue: string, placeholder: string): boolean {
  const decoded = safeDecodeURIComponent(rawValue);
  if (isSafeDiagnosticToken(decoded, placeholder)) return false;
  if (decoded.length < 20 || /\s/.test(decoded)) return false;
  if (!/^[A-Za-z0-9._~+/=-]{20,}$/.test(decoded)) return false;
  if (/^(?:whsec|sec|tok|key|pat|ak)_[A-Za-z0-9._~+/=-]+$/i.test(decoded)) return true;
  const hasLetter = /[A-Za-z]/.test(decoded);
  const hasDigit = /\d/.test(decoded);
  if (hasLetter && hasDigit) return true;
  const hasUpper = /[A-Z]/.test(decoded);
  const hasLower = /[a-z]/.test(decoded);
  const hasBase64Punct = /[+/=~]/.test(decoded);
  return hasUpper && hasLower && hasBase64Punct;
}

function scrubKnownSecretsInSpan(
  input: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (!secret) continue;
    if (out.includes(secret)) out = out.split(secret).join(placeholder);
    if (secret.length >= 4) {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret && out.includes(encoded)) {
        out = out.split(encoded).join(placeholder);
      }
    }
  }
  return out;
}

function scrubSecretShapesInValue(
  rawValue: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!rawValue || rawValue === placeholder) return rawValue;

  let out = scrubKnownSecretsInSpan(rawValue, knownSecrets, placeholder);
  const decoded = safeDecodeURIComponent(out);

  if (/^(?:https?|wss?):\/\//i.test(decoded)) {
    const redactedNested = redactSingleUrl(decoded, knownSecrets, placeholder);
    return decoded === out ? redactedNested : redactedNested === decoded ? out : placeholder;
  }

  if (decoded !== out) {
    const scrubbedDecoded = scrubSecretShapesInValue(decoded, knownSecrets, placeholder);
    if (scrubbedDecoded !== decoded) return placeholder;
  }

  if (isSafeDiagnosticToken(out, placeholder)) return out;

  const beforeShapes = out;
  out = out
    .replace(TELEGRAM_BOT_TOKEN_EXACT_OR_EMBEDDED, placeholder)
    .replace(STELLAR_SECRET_SEED_RE, placeholder)
    .replace(JWT_SHAPE_RE, placeholder)
    .replace(PREFIXED_API_KEY_RE, placeholder)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${placeholder}`);

  if (out !== beforeShapes) return out;
  if (isOpaqueSecretToken(out, placeholder)) return placeholder;
  return out;
}

function redactParamEntry(
  entry: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!entry) return "";
  const eqIdx = entry.indexOf("=");
  if (eqIdx !== -1) {
    const rawKey = entry.slice(0, eqIdx);
    const rawVal = entry.slice(eqIdx + 1);
    if (isCredentialParamKey(rawKey)) return `${rawKey}=${placeholder}`;
    return `${rawKey}=${scrubSecretShapesInValue(rawVal, knownSecrets, placeholder)}`;
  }

  const encodedEq = /^([^%]+)(%3[dD])(.*)$/.exec(entry);
  if (encodedEq) {
    const [, rawKey = "", sep = "%3D", rawVal = ""] = encodedEq;
    if (isCredentialParamKey(rawKey)) return `${rawKey}${sep}${placeholder}`;
    return `${rawKey}${sep}${scrubSecretShapesInValue(rawVal, knownSecrets, placeholder)}`;
  }

  return scrubSecretShapesInValue(entry, knownSecrets, placeholder);
}

function redactQueryComponent(
  rawQuery: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!rawQuery) return "";
  return rawQuery
    .split(/([&;])/)
    .map((part, idx) => (idx % 2 === 1 ? part : redactParamEntry(part, knownSecrets, placeholder)))
    .join("");
}

function redactPathSegment(
  segment: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!segment) return "";
  if (segment.includes(";")) {
    const parts = segment.split(";");
    const head = redactPathSegment(parts[0] ?? "", knownSecrets, placeholder);
    const tail = parts.slice(1).map((param) => redactParamEntry(param, knownSecrets, placeholder));
    return [head, ...tail].join(";");
  }
  if (segment.includes("=")) return redactParamEntry(segment, knownSecrets, placeholder);
  return scrubSecretShapesInValue(segment, knownSecrets, placeholder);
}

function redactPathComponent(
  rawPath: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!rawPath) return "";
  return rawPath
    .split("/")
    .map((seg, idx) => (idx === 0 ? seg : redactPathSegment(seg, knownSecrets, placeholder)))
    .join("/");
}

function redactAuthorityComponent(
  rawAuthority: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!rawAuthority) return "";
  const atIdx = rawAuthority.lastIndexOf("@");
  const rawHostPort = atIdx === -1 ? rawAuthority : rawAuthority.slice(atIdx + 1);
  const scrubbedHostPort = scrubKnownSecretsInSpan(rawHostPort, knownSecrets, placeholder)
    .replace(TELEGRAM_BOT_TOKEN_EXACT_OR_EMBEDDED, placeholder)
    .replace(STELLAR_SECRET_SEED_RE, placeholder)
    .replace(JWT_SHAPE_RE, placeholder)
    .replace(PREFIXED_API_KEY_RE, placeholder);
  return atIdx === -1 ? scrubbedHostPort : `${placeholder}@${scrubbedHostPort}`;
}

function redactFragmentComponent(rawFragment: string, placeholder: string): string {
  if (!rawFragment) return "";
  return placeholder;
}

function redactSingleUrl(
  rawUrl: string,
  knownSecrets: readonly string[],
  placeholder: string,
): string {
  if (!rawUrl) return "";
  const preScrubbed = scrubKnownSecretsInSpan(rawUrl, knownSecrets, placeholder);
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/s.exec(preScrubbed);

  if (!schemeMatch) {
    const hashIdx = preScrubbed.indexOf("#");
    const beforeHash = hashIdx === -1 ? preScrubbed : preScrubbed.slice(0, hashIdx);
    const hasHash = hashIdx !== -1;
    const rawFragment = hasHash ? preScrubbed.slice(hashIdx + 1) : "";

    const queryIdx = beforeHash.indexOf("?");
    const rawPath = queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx);
    const hasQuery = queryIdx !== -1;
    const rawQuery = hasQuery ? beforeHash.slice(queryIdx + 1) : "";

    const safePath = rawPath.startsWith("/")
      ? redactPathComponent(rawPath, knownSecrets, placeholder)
      : scrubSecretShapesInValue(rawPath, knownSecrets, placeholder);
    const safeQuery = hasQuery ? `?${redactQueryComponent(rawQuery, knownSecrets, placeholder)}` : "";
    const safeFrag = hasHash ? `#${redactFragmentComponent(rawFragment, placeholder)}` : "";
    return `${safePath}${safeQuery}${safeFrag}`;
  }

  const [, schemePrefix = "", rest = ""] = schemeMatch;
  const hashIdx = rest.indexOf("#");
  const beforeHash = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const hasHash = hashIdx !== -1;
  const rawFragment = hasHash ? rest.slice(hashIdx + 1) : "";

  const queryIdx = beforeHash.indexOf("?");
  const authorityAndPath = queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx);
  const hasQuery = queryIdx !== -1;
  const rawQuery = hasQuery ? beforeHash.slice(queryIdx + 1) : "";

  const slashIdx = authorityAndPath.indexOf("/");
  const rawAuthority = slashIdx === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIdx);
  const rawPath = slashIdx === -1 ? "" : authorityAndPath.slice(slashIdx);

  const safeAuthority = redactAuthorityComponent(rawAuthority, knownSecrets, placeholder);
  const safePath = redactPathComponent(rawPath, knownSecrets, placeholder);
  const safeQuery = hasQuery ? `?${redactQueryComponent(rawQuery, knownSecrets, placeholder)}` : "";
  const safeFrag = hasHash ? `#${redactFragmentComponent(rawFragment, placeholder)}` : "";

  return `${schemePrefix}${safeAuthority}${safePath}${safeQuery}${safeFrag}`;
}

function countChar(text: string, target: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === target) count += 1;
  }
  return count;
}

function splitTrailingUrlPunctuation(candidate: string): { url: string; trailing: string } {
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1]!;
    if (ch === "." || ch === "," || ch === ";" || ch === ":" || ch === "!" || ch === "?") {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const prefix = candidate.slice(0, end - 1);
      if (countChar(prefix, "(") <= countChar(prefix, ")")) {
        end -= 1;
        continue;
      }
    }
    if (ch === "]") {
      const prefix = candidate.slice(0, end - 1);
      if (countChar(prefix, "[") <= countChar(prefix, "]")) {
        end -= 1;
        continue;
      }
    }
    if (ch === "}") {
      const prefix = candidate.slice(0, end - 1);
      if (countChar(prefix, "{") <= countChar(prefix, "}")) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return { url: candidate.slice(0, end), trailing: candidate.slice(end) };
}

export interface RedactUrlOptions {
  /** Extra secrets known only to this call site. */
  secrets?: readonly string[];
  /** Replacement token; defaults to `REDACTED` (`"[REDACTED]"`). */
  placeholder?: string;
  /** Whether to consult process-wide `registeredSecrets()`; defaults to `true`. */
  includeRegisteredSecrets?: boolean;
}

function collectKnownSecrets(options: RedactUrlOptions): string[] {
  const base = options.includeRegisteredSecrets === false ? [] : registeredSecrets();
  return [...base, ...(options.secrets ?? [])]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length);
}

/**
 * Scrub credentials, secret-shaped path segments, repeated query parameters,
 * and URL fragments across every inline `http(s)://` / `ws(s)://` URL in `text`.
 */
export function redactInlineUrls(text: string, options: RedactUrlOptions = {}): string {
  if (!text) return "";
  const placeholder = options.placeholder ?? REDACTED;
  const known = collectKnownSecrets(options);
  return text.replace(INLINE_URL_RE, (matched) => {
    const { url, trailing } = splitTrailingUrlPunctuation(matched);
    return `${redactSingleUrl(url, known, placeholder)}${trailing}`;
  });
}

/**
 * Credential pairs in a standalone query/fragment snippet without a scheme.
 */
const URL_QUERY_CREDENTIAL: FnRedactionRule = {
  pattern: /([?&#;])([^=&#;\s]+)=([^&#;\s]*)/g,
  replacement: (match: string) => {
    const delim = match[0] ?? "?";
    const rest = match.slice(1);
    const eqIdx = rest.indexOf("=");
    if (eqIdx === -1) return match;
    const rawKey = rest.slice(0, eqIdx);
    const rawVal = rest.slice(eqIdx + 1);
    if (isCredentialParamKey(rawKey)) return `${delim}${rawKey}=${REDACTED}`;
    return `${delim}${rawKey}=${scrubSecretShapesInValue(rawVal, [], REDACTED)}`;
  },
};

/**
 * Shape-based rules, in order. Every replacement is `[REDACTED]` (or names the
 * thing it hid) so one convention covers the log, `/status`, and `/health`.
 *
 * Order matters: inline URLs are redacted component-by-component first, then
 * standalone bot tokens, seed strkeys, Bearer headers, and key/value dumps.
 */
export const ERROR_REDACTION_RULES: readonly (RedactionRule | FnRedactionRule)[] = [
  // Telegram bot tokens: `bot123456:AA…` (in a URL) and the bare `123456:AA…`.
  // The lookarounds are main's, and they are not interchangeable with `\b`: a
  // token that ends in URL punctuation (`…-`, `…_`) must be redacted whole, and
  // `\b` would back-track off the trailing `-` because it is not a word
  // character. `tests/bot.test.mjs` pins exactly that case.
  { pattern: /\bbot\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, replacement: REDACTED },
  {
    pattern: /(?<![A-Za-z0-9_-])\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: REDACTED,
  },
  // The 56-char ed25519 seed strkey, the same shape `audit.ts` scrubs. Public
  // `G…` account and `C…` contract ids are chain identifiers the bot prints on
  // purpose, so they are deliberately not matched.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: REDACTED },
  { pattern: JWT_SHAPE_RE, replacement: REDACTED },
  { pattern: PREFIXED_API_KEY_RE, replacement: REDACTED },
  URL_USERINFO,
  URL_QUERY_CREDENTIAL,
  // Bearer / Authorization echoes.
  { pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // `TOKEN=…`, `Authorization: …`, `TELEGRAM_BOT_TOKEN=…` style key/value dumps.
  // The name may carry a prefix, which is exactly how the env names arrive in a
  // config error. The value must be at least 8 opaque characters, so the
  // actionable `token: unset` stays readable, and stops at URL delimiters
  // (`&`, `#`, `;`) so redacted query strings never swallow safe neighbours.
  {
    pattern:
      /(?<![?&#;/])\b([A-Za-z0-9_]*(?:token|secret|password|authorization)[A-Za-z0-9_]*)\s*[:=]\s*(?!\[REDACTED\])[^\s&#;]{8,}/gi,
    replacement: `$1=${REDACTED}`,
  },
];

/**
 * Hide credentials and secret-shaped tokens across every component of a URL
 * (userinfo, path segments, repeated query parameters, and `#fragment`s) while
 * preserving safe host and path diagnostics.
 */
export function redactUrl(url: string, options: RedactUrlOptions = {}): string {
  if (!url) return "";
  const placeholder = options.placeholder ?? REDACTED;
  return redactSingleUrl(url, collectKnownSecrets(options), placeholder);
}

/**
 * Clamp after redaction so no single message can dominate a log or a response.
 * Private: `status.ts` already owns the exported `boundText` for snapshots, and
 * two public helpers with one name would be a trap at the import site.
 */
function clamp(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 1))}…`;
}

export interface RedactOptions {
  /** Extra secrets known only to this call site (config values, fixture ids). */
  secrets?: readonly string[];
  /** Hard cap on the returned length. */
  maxLen?: number;
}

/**
 * Replace registered/known secrets and credential-shaped substrings.
 *
 * Registered and caller-supplied secrets go first, because a secret can be any
 * shape at all; the patterns then catch the cases where no value was ever
 * registered (a hand-pasted token in a test, a seed key in an upstream error).
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  if (!input) return "";
  let out = input;

  const known = collectKnownSecrets(options.secrets ? { secrets: options.secrets } : {});
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  out = redactInlineUrls(out, {
    secrets: known,
    placeholder: REDACTED,
    includeRegisteredSecrets: false,
  });

  for (const rule of ERROR_REDACTION_RULES) {
    out = typeof rule.replacement === "string"
      ? out.replace(rule.pattern, rule.replacement)
      : out.replace(rule.pattern, rule.replacement);
  }

  return clamp(out, options.maxLen);
}

/** Redacted, bounded text for anything thrown at us. */
export function redactError(err: unknown, options: RedactOptions = {}): string {
  let raw: string;
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    raw = `${name}${err.message}`;
  } else if (typeof err === "string") {
    raw = err;
  } else if (err === null || err === undefined) {
    raw = String(err);
  } else if (typeof err === "symbol") {
    raw = "[unsupported:symbol]";
  } else if (typeof err === "function") {
    raw = "[unsupported:function]";
  } else {
    try {
      const seen = new WeakSet<object>();
      const json = JSON.stringify(err, (_key, val) => {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "symbol") return "[unsupported:symbol]";
        if (typeof val === "function") return "[unsupported:function]";
        if (val !== null && typeof val === "object") {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
      raw = typeof json === "string" ? json : String(err);
    } catch {
      raw = String(err);
    }
  }
  return redactText(raw, options);
}
