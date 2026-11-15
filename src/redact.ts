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
 * is the most useful part of the message. Everything else — the Telegram token,
 * secret strkeys, URL userinfo and credential-bearing query strings, and
 * `token=…`/`authorization: …` pairs — is scrubbed, and the result is length
 * bounded so a hostile endpoint cannot write an unbounded blob into a log line
 * or a health response.
 */

/** Placeholder, matching the wording the status/health surfaces already use. */
export const REDACTED = "[REDACTED]";

/**
 * Default cap for redacted error text. Matches `safeErrorMessage`'s historical
 * bound so this module is a drop-in for the callers that already rely on it.
 */
export const DEFAULT_MAX_LEN = 240;

/** Default maximum `.cause` hops traversed after the root error. */
export const MAX_ERROR_CAUSE_DEPTH = 4;

/** Hard ceiling on `maxCauseDepth` overrides so traversal stays strictly bounded. */
export const HARD_MAX_ERROR_CAUSE_DEPTH = 16;

/** Maximum child errors summarized from an `AggregateError.errors` array. */
export const MAX_AGGREGATE_ERRORS = 3;

/** Marker emitted when an error `.cause` chain contains a cycle. */
export const CIRCULAR_CAUSE_MARKER = "[circular cause]";

/** Marker emitted when an error `.cause` chain exceeds the depth budget. */
export const CAUSE_DEPTH_LIMIT_MARKER = "[cause depth limit]";

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

/** Credentials in a URL's userinfo: `https://user:pass@rpc.example`. */
const URL_USERINFO: RedactionRule = {
  pattern: /(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
  replacement: `$1${REDACTED}@`,
};

/** Credentials in a query string, which error text routinely echoes whole. */
const URL_QUERY_CREDENTIAL: RedactionRule = {
  pattern: /([?&](?:token|api[_-]?key|key|secret|password|auth)=)[^&\s]+/gi,
  replacement: `$1${REDACTED}`,
};

/**
 * Shape-based rules, in order. Every replacement is `[REDACTED]` (or names the
 * thing it hid) so one convention covers the log, `/status`, and `/health`.
 *
 * Order matters: the bot token is removed before the URL rules, because a token
 * inside `api.telegram.org/bot<token>/…` would otherwise be replaced twice and
 * lose the fact that a token was involved at all.
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
  URL_USERINFO,
  URL_QUERY_CREDENTIAL,
  // Bearer / Authorization echoes.
  { pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // `TOKEN=…`, `Authorization: …`, `TELEGRAM_BOT_TOKEN=…` style key/value dumps.
  // The name may carry a prefix, which is exactly how the env names arrive in a
  // config error. The value must be at least 8 opaque characters, so the
  // actionable `token: unset` stays readable.
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:token|secret|password|authorization)[A-Za-z0-9_]*)\s*[:=]\s*\S{8,}/gi,
    replacement: `$1=${REDACTED}`,
  },
];

/**
 * Hide credentials in a URL while keeping the endpoint readable: an operator
 * needs to see *which* RPC refused them, not the password that was refused.
 * Only the URL rules apply, so a URL in a boot line is never replaced wholesale.
 */
export function redactUrl(url: string): string {
  return url.replace(URL_USERINFO.pattern, URL_USERINFO.replacement)
    .replace(URL_QUERY_CREDENTIAL.pattern, URL_QUERY_CREDENTIAL.replacement);
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
  /** Maximum `.cause` hops traversed after the root error (default `4`, max `16`). */
  maxCauseDepth?: number;
}

export interface RedactedErrorSummary {
  name: string;
  message: string;
  code?: string | number;
  cause?: RedactedErrorSummary | string;
  errors?: (RedactedErrorSummary | string)[];
  summary: string;
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

  const known = [...registeredSecrets(), ...(options.secrets ?? [])]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }

  for (const rule of ERROR_REDACTION_RULES) {
    out = typeof rule.replacement === "string"
      ? out.replace(rule.pattern, rule.replacement)
      : out.replace(rule.pattern, rule.replacement);
  }

  return clamp(out, options.maxLen);
}

const CAUSE_SEPARATOR = "; cause: ";
const UNREADABLE_CAUSE_MARKER = "[unreadable cause]";
const UNREADABLE_ERROR_MARKER = "[unreadable error]";

function normalizeMaxCauseDepth(depth: number | undefined): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) {
    return MAX_ERROR_CAUSE_DEPTH;
  }
  return Math.min(HARD_MAX_ERROR_CAUSE_DEPTH, Math.max(0, Math.floor(depth)));
}

function safeReadProp(
  target: object,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (target as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function redactHopText(
  raw: string,
  secrets: readonly string[] | undefined,
  maxHopLen: number,
): string {
  // Bound raw input before regex passes so multi-megabyte remote payloads cannot
  // stall redaction, while keeping plenty of headroom before clamping.
  const preBounded = raw.length > 8_192 ? `${raw.slice(0, 8_191)}…` : raw;
  const singleLine = preBounded.replace(/[\r\n]+/g, " ");
  return redactText(singleLine, { secrets, maxLen: maxHopLen });
}

function formatErrorObjectLabel(
  obj: object,
  secrets: readonly string[] | undefined,
  maxHopLen: number,
  seen: Set<object>,
  remainingDepth: number,
): {
  name: string;
  message: string;
  code?: string | number;
  errors?: (RedactedErrorSummary | string)[];
  label: string;
} {
  const isErrInstance = obj instanceof Error;
  const nameProp = safeReadProp(obj, "name");
  const rawName =
    nameProp.ok && typeof nameProp.value === "string" && nameProp.value.trim().length > 0
      ? nameProp.value.trim()
      : isErrInstance
        ? "Error"
        : "Object";
  const safeName = redactHopText(rawName, secrets, 64) || "Error";

  const codeProp = safeReadProp(obj, "code");
  const safeCode =
    codeProp.ok && (typeof codeProp.value === "number" || typeof codeProp.value === "string")
      ? typeof codeProp.value === "number"
        ? codeProp.value
        : redactHopText(codeProp.value, secrets, 64)
      : undefined;

  const msgProp = safeReadProp(obj, "message");
  let safeMessage: string;
  if (!msgProp.ok) {
    safeMessage = UNREADABLE_ERROR_MARKER;
  } else if (typeof msgProp.value === "string") {
    safeMessage = redactHopText(msgProp.value, secrets, maxHopLen);
  } else if (isErrInstance) {
    safeMessage = "";
  } else {
    try {
      const json = JSON.stringify(obj);
      safeMessage =
        typeof json === "string"
          ? redactHopText(json, secrets, maxHopLen)
          : UNREADABLE_ERROR_MARKER;
    } catch {
      safeMessage = safeCode !== undefined ? `code ${String(safeCode)}` : "[object]";
    }
  }

  let summarizedErrors: (RedactedErrorSummary | string)[] | undefined;
  let aggregateSuffix = "";
  const errorsProp = safeReadProp(obj, "errors");
  if (errorsProp.ok && Array.isArray(errorsProp.value) && errorsProp.value.length > 0) {
    const items = errorsProp.value;
    const limit = Math.min(MAX_AGGREGATE_ERRORS, items.length);
    const childLabels: string[] = [];
    summarizedErrors = [];

    for (let i = 0; i < limit; i += 1) {
      let item: unknown;
      try {
        item = items[i];
      } catch {
        summarizedErrors.push(UNREADABLE_ERROR_MARKER);
        childLabels.push(UNREADABLE_ERROR_MARKER);
        continue;
      }
      if (item !== null && typeof item === "object") {
        if (seen.has(item)) {
          summarizedErrors.push(CIRCULAR_CAUSE_MARKER);
          childLabels.push(CIRCULAR_CAUSE_MARKER);
        } else if (remainingDepth <= 0) {
          summarizedErrors.push(CAUSE_DEPTH_LIMIT_MARKER);
          childLabels.push(CAUSE_DEPTH_LIMIT_MARKER);
        } else {
          const branchSeen = new Set(seen);
          const childSummary = buildErrorChainInternal(
            item,
            { secrets, maxLen: Math.max(48, Math.floor(maxHopLen / 2)), maxCauseDepth: remainingDepth - 1 },
            branchSeen,
          );
          summarizedErrors.push(childSummary);
          childLabels.push(childSummary.summary);
        }
      } else {
        const text = redactHopText(String(item), secrets, 80);
        summarizedErrors.push(text);
        childLabels.push(text);
      }
    }

    if (items.length > MAX_AGGREGATE_ERRORS) {
      const extraMarker = `+${items.length - MAX_AGGREGATE_ERRORS} more`;
      summarizedErrors.push(extraMarker);
      childLabels.push(extraMarker);
    }
    aggregateSuffix = ` [errors: ${childLabels.join(", ")}]`;
  }

  const namePrefix = isErrInstance
    ? safeName && safeName !== "Error"
      ? `${safeName}: `
      : ""
    : safeCode !== undefined && msgProp.ok && typeof msgProp.value === "string"
      ? `${String(safeCode)}: `
      : "";

  const baseBody = safeMessage || (safeCode !== undefined ? String(safeCode) : "");
  const combinedLabel = clamp(`${namePrefix}${baseBody}${aggregateSuffix}`, maxHopLen);

  return {
    name: safeName,
    message: safeMessage,
    ...(safeCode !== undefined ? { code: safeCode } : {}),
    ...(summarizedErrors !== undefined ? { errors: summarizedErrors } : {}),
    label: combinedLabel,
  };
}

/**
 * Fit multiple cause-chain segments into `maxLen` using water-filling budgets so
 * an oversized outer message never slices off the terminal root cause or cycle marker.
 */
function joinCauseSegments(segments: readonly string[], maxLen: number): string {
  if (segments.length === 0) return "";
  if (segments.length === 1) return clamp(segments[0]!, maxLen);

  const full = segments.join(CAUSE_SEPARATOR);
  if (full.length <= maxLen) return full;

  const sepTotal = (segments.length - 1) * CAUSE_SEPARATOR.length;
  const available = maxLen - sepTotal;
  if (available < segments.length * 4) {
    return clamp(full, maxLen);
  }

  const budgets = new Array<number>(segments.length).fill(0);
  const active = segments.map((_, idx) => idx);
  let pool = available;

  while (active.length > 0) {
    const share = Math.floor(pool / active.length);
    let locked = false;
    for (let i = active.length - 1; i >= 0; i -= 1) {
      const segIdx = active[i]!;
      const len = segments[segIdx]!.length;
      if (len <= share) {
        budgets[segIdx] = len;
        pool -= len;
        active.splice(i, 1);
        locked = true;
      }
    }
    if (!locked) {
      const baseShare = Math.floor(pool / active.length);
      let remainder = pool - baseShare * active.length;
      for (const segIdx of active) {
        budgets[segIdx] = baseShare + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
      }
      break;
    }
  }

  const fitted = segments.map((seg, idx) => clamp(seg, Math.max(1, budgets[idx]!)));
  return clamp(fitted.join(CAUSE_SEPARATOR), maxLen);
}

interface ChainNodeDraft {
  name: string;
  message: string;
  code?: string | number;
  errors?: (RedactedErrorSummary | string)[];
  label: string;
}

function buildErrorChainInternal(
  err: unknown,
  options: RedactOptions,
  seen: Set<object>,
): RedactedErrorSummary {
  const maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
  const maxCauseDepth = normalizeMaxCauseDepth(options.maxCauseDepth);
  const hopCap = Math.max(maxLen, DEFAULT_MAX_LEN);

  if (err === null || typeof err !== "object") {
    const text = redactHopText(String(err), options.secrets, maxLen);
    return {
      name: typeof err,
      message: text,
      summary: text,
    };
  }

  // Plain object without Error prototype and without a `.cause` chain keeps
  // `JSON.stringify` formatting so RPC `{ code, message }` payloads stay compatible.
  const rootCauseProp = safeReadProp(err, "cause");
  if (!(err instanceof Error) && rootCauseProp.ok && rootCauseProp.value === undefined) {
    let raw: string;
    try {
      const json = JSON.stringify(err);
      raw = typeof json === "string" ? json : String(err);
    } catch {
      raw = "[circular object]";
    }
    const redacted = redactHopText(raw, options.secrets, maxLen);
    return {
      name: "Object",
      message: redacted,
      summary: redacted,
    };
  }

  const drafts: ChainNodeDraft[] = [];
  const segments: string[] = [];
  let terminalCause: string | undefined;

  let current: unknown = err;
  let depth = 0;

  while (current !== null && typeof current === "object") {
    if (seen.has(current)) {
      terminalCause = CIRCULAR_CAUSE_MARKER;
      segments.push(CIRCULAR_CAUSE_MARKER);
      break;
    }
    if (depth > maxCauseDepth) {
      terminalCause = CAUSE_DEPTH_LIMIT_MARKER;
      segments.push(CAUSE_DEPTH_LIMIT_MARKER);
      break;
    }

    seen.add(current);
    const nodeDraft = formatErrorObjectLabel(
      current,
      options.secrets,
      hopCap,
      seen,
      maxCauseDepth - depth,
    );
    drafts.push(nodeDraft);
    segments.push(nodeDraft.label);

    const causeProp = safeReadProp(current, "cause");
    if (!causeProp.ok) {
      terminalCause = UNREADABLE_CAUSE_MARKER;
      segments.push(UNREADABLE_CAUSE_MARKER);
      break;
    }
    const nextCause = causeProp.value;
    if (nextCause === undefined) {
      break;
    }
    if (nextCause === null || typeof nextCause !== "object") {
      const primText = redactHopText(String(nextCause), options.secrets, hopCap);
      terminalCause = primText;
      segments.push(primText);
      break;
    }

    current = nextCause;
    depth += 1;
  }

  const combinedSummary = joinCauseSegments(segments, maxLen);

  // Assemble nested structured chain from tail back to root without recursion.
  let tail: RedactedErrorSummary | string | undefined = terminalCause;
  for (let i = drafts.length - 1; i >= 0; i -= 1) {
    const d = drafts[i]!;
    const summaryForNode = i === 0 ? combinedSummary : clamp(d.label, maxLen);
    tail = {
      name: d.name,
      message: clamp(d.message, maxLen),
      ...(d.code !== undefined ? { code: d.code } : {}),
      ...(d.errors !== undefined ? { errors: d.errors } : {}),
      ...(tail !== undefined ? { cause: tail } : {}),
      summary: summaryForNode,
    };
  }

  return (
    (tail as RedactedErrorSummary | undefined) ?? {
      name: "Error",
      message: combinedSummary,
      summary: combinedSummary,
    }
  );
}

/**
 * Traverse an unknown error and its `.cause` / `AggregateError.errors` chain
 * iteratively with cycle detection and a hard depth bound, returning a fixed-size
 * structured summary with all secrets scrubbed.
 */
export function redactErrorChain(
  err: unknown,
  options: RedactOptions = {},
): RedactedErrorSummary {
  return buildErrorChainInternal(err, options, new Set<object>());
}

/** Redacted, bounded text for anything thrown at us, including cyclic or deep causes. */
export function redactError(err: unknown, options: RedactOptions = {}): string {
  if (typeof err === "string") {
    return redactText(err, options);
  }
  if (err === null || err === undefined) {
    return redactText(String(err), options);
  }
  return redactErrorChain(err, options).summary;
}
