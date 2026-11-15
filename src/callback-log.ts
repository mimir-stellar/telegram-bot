/**
 * Bounded, update-safe logging helpers for Telegram callback queries.
 *
 * Callback handlers and `bot.catch` run on untrusted `Update` payloads and may
 * catch library wrapper errors (such as grammy's `BotError` or `GrammyError`)
 * that attach the full `ctx.update`, `callback_query.message`, chat metadata,
 * or raw API request payloads. Passing such objects through generic JSON or
 * message formatters risks serializing entire Telegram updates into logs.
 *
 * Every helper here inspects only scalar fields in O(1) time with defensive
 * property reads and emits only stable IDs (`update_id`, `callback_id`), a
 * closed action token, and a redacted error category.
 */

import { REDACTED, redactText, registeredSecrets } from "./redact.js";

/** Maximum length accepted for a logged Telegram `callback_query.id`. */
export const MAX_CALLBACK_ID_LOG_CHARS = 64;

/** Hard upper bound on any formatted callback log line. */
export const MAX_CALLBACK_LOG_LINE_CHARS = 200;

/** Closed set of redacted error categories emitted by callback error logs. */
export type CallbackErrorCategory =
  | "rate_limited"
  | "unauthorized"
  | "message_not_found"
  | "query_expired"
  | "bad_request"
  | "upstream_5xx"
  | "timeout"
  | "network"
  | "validation"
  | "internal";

export interface CallbackLogIds {
  updateId: string;
  callbackId: string;
}

const SAFE_CALLBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ACTION_RE = /^[a-z][a-z0-9_:-]{0,31}$/;
const SEED_STRKEY_RE = /^S[A-Z2-7]{55}$/;
const TELEGRAM_TOKEN_SHAPE_RE = /\d{5,}:[A-Za-z0-9_-]{20,}/;

const MAX_INSPECT_STRING_CHARS = 256;
const MAX_ERROR_UNWRAP_DEPTH = 2;

function readProp(target: unknown, key: string): unknown {
  if (target === null || target === undefined || typeof target !== "object") {
    return undefined;
  }
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Extract scalar `update_id` safely without invoking `toString()` on objects
 * or traversing nested update properties.
 */
export function extractSafeUpdateId(ctx: unknown): string {
  const update = readProp(ctx, "update");
  const raw = readProp(update, "update_id");
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return String(raw);
  }
  return "unknown";
}

/**
 * Extract and sanitize `callback_query.id` without reading message/chat/user
 * fields or echoing secret-shaped or malformed values.
 */
export function extractSafeCallbackId(
  ctx: unknown,
  secrets: readonly string[] = [],
): string {
  const cq = readProp(ctx, "callbackQuery") ?? readProp(readProp(ctx, "update"), "callback_query");
  const raw = readProp(cq, "id");
  if (raw === undefined || raw === null) {
    return "none";
  }
  if (typeof raw !== "string") {
    return "invalid";
  }
  if (raw.length === 0) {
    return "none";
  }
  if (raw.length > MAX_CALLBACK_ID_LOG_CHARS) {
    return "oversized";
  }

  const probe = raw.slice(0, MAX_CALLBACK_ID_LOG_CHARS);
  if (TELEGRAM_TOKEN_SHAPE_RE.test(probe) || SEED_STRKEY_RE.test(probe)) {
    return REDACTED;
  }
  for (const secret of [...secrets, ...registeredSecrets()]) {
    if (secret && secret.length >= 4 && probe.includes(secret)) {
      return REDACTED;
    }
  }
  if (!SAFE_CALLBACK_ID_RE.test(probe)) {
    return "invalid";
  }
  return probe;
}

/** Extract both stable IDs (`update_id` and `callback_id`) in O(1) time. */
export function extractCallbackLogIds(
  ctx: unknown,
  secrets: readonly string[] = [],
): CallbackLogIds {
  return {
    updateId: extractSafeUpdateId(ctx),
    callbackId: extractSafeCallbackId(ctx, secrets),
  };
}

/** True when a grammy-like context represents a `callback_query` update. */
export function isCallbackUpdateContext(ctx: unknown): boolean {
  if (readProp(ctx, "callbackQuery") !== undefined) {
    return true;
  }
  const update = readProp(ctx, "update");
  return readProp(update, "callback_query") !== undefined;
}

function sanitizeActionLabel(action: string | undefined): string {
  if (typeof action !== "string" || action.length === 0) {
    return "unknown";
  }
  const normalized = action.trim().toLowerCase();
  return SAFE_ACTION_RE.test(normalized) ? normalized : "unknown";
}

function sanitizeCategoryLabel(category: string | undefined): string {
  if (typeof category !== "string" || category.length === 0) {
    return "internal";
  }
  const normalized = category.trim().toLowerCase();
  return SAFE_ACTION_RE.test(normalized) ? normalized : "internal";
}

function unwrapError(err: unknown): unknown {
  let current = err;
  for (let i = 0; i < MAX_ERROR_UNWRAP_DEPTH; i += 1) {
    if (current === null || current === undefined || typeof current !== "object" || current instanceof Error) {
      // Even on `BotError extends Error`, grammy attaches `.error` as the underlying cause.
      const nestedOnError = current instanceof Error ? readProp(current, "error") : undefined;
      if (nestedOnError !== undefined && nestedOnError !== null && nestedOnError !== current) {
        current = nestedOnError;
        continue;
      }
      break;
    }
    const nested = readProp(current, "error");
    if (nested !== undefined && nested !== null && nested !== current) {
      current = nested;
      continue;
    }
    break;
  }
  return current;
}

function extractBoundedScalarString(target: unknown, key: string): string {
  const val = readProp(target, key);
  return typeof val === "string" ? val.slice(0, MAX_INSPECT_STRING_CHARS) : "";
}

function extractHttpStatusCode(target: unknown): number | null {
  for (const key of ["error_code", "status", "statusCode"]) {
    const val = readProp(target, key);
    if (typeof val === "number" && Number.isInteger(val) && val >= 100 && val <= 599) {
      return val;
    }
  }
  return null;
}

/**
 * Classify an arbitrary thrown value into a closed `CallbackErrorCategory`
 * without serializing objects or exposing raw error message text.
 */
export function classifyCallbackError(err: unknown): CallbackErrorCategory {
  if (err === null || err === undefined) {
    return "internal";
  }

  const target = unwrapError(err);
  const statusCode = extractHttpStatusCode(target) ?? extractHttpStatusCode(err);
  const code = (
    extractBoundedScalarString(target, "code") || extractBoundedScalarString(err, "code")
  ).toUpperCase();
  const name = extractBoundedScalarString(target, "name") || extractBoundedScalarString(err, "name");
  const summary = (
    extractBoundedScalarString(target, "description") ||
    extractBoundedScalarString(target, "message") ||
    (typeof target === "string" ? target.slice(0, MAX_INSPECT_STRING_CHARS) : "")
  );

  if (statusCode === 429 || /\b429\b|too many requests|retry after/i.test(summary)) {
    return "rate_limited";
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\b(?:401|403)\b|unauthorized|forbidden/i.test(summary)
  ) {
    return "unauthorized";
  }
  if (
    /message to edit not found|message can't be edited|message_id_invalid|message to delete not found/i.test(
      summary,
    )
  ) {
    return "message_not_found";
  }
  if (/query is too old|query id is invalid|response timeout expired/i.test(summary)) {
    return "query_expired";
  }
  if ((statusCode !== null && statusCode >= 400 && statusCode < 500) || /\bbad request\b/i.test(summary)) {
    return "bad_request";
  }
  if (statusCode !== null && statusCode >= 500 && statusCode < 600) {
    return "upstream_5xx";
  }
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    /timed?\s*out|timeout/i.test(summary)
  ) {
    return "timeout";
  }
  if (
    name === "HttpError" ||
    /^(?:ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/.test(code) ||
    /network request|fetch failed|socket hang up|econnrefused|econnreset|enotfound/i.test(summary)
  ) {
    return "network";
  }
  return "internal";
}

function finalizeLogLine(line: string, secrets: readonly string[]): string {
  const singleLine = line.replace(/[\x00-\x1f\x7f-\x9f\r\n\u2028\u2029]+/g, " ").trim();
  return redactText(singleLine, { secrets, maxLen: MAX_CALLBACK_LOG_LINE_CHARS });
}

/**
 * Format a single-line, bounded callback error log containing only stable IDs,
 * a closed action identifier, and a redacted error category.
 */
export function formatCallbackErrorLog(
  ctx: unknown,
  err: unknown,
  options: {
    action?: string;
    category?: CallbackErrorCategory;
    secrets?: readonly string[];
  } = {},
): string {
  const secrets = options.secrets ?? [];
  const ids = extractCallbackLogIds(ctx, secrets);
  const action = sanitizeActionLabel(options.action);
  const category = options.category ?? classifyCallbackError(err);
  return finalizeLogLine(
    `[bot] callback error: update_id=${ids.updateId} callback_id=${ids.callbackId} action=${action} category=${category}`,
    secrets,
  );
}

/**
 * Format a single-line, bounded callback rejection/warning log containing only
 * stable IDs, a closed action identifier, and a closed rejection reason.
 */
export function formatCallbackRejectionLog(
  ctx: unknown,
  options: {
    action?: string;
    reason?: string;
    secrets?: readonly string[];
  } = {},
): string {
  const secrets = options.secrets ?? [];
  const ids = extractCallbackLogIds(ctx, secrets);
  const action = sanitizeActionLabel(options.action);
  const category = sanitizeCategoryLabel(options.reason);
  return finalizeLogLine(
    `[bot] callback rejected: update_id=${ids.updateId} callback_id=${ids.callbackId} action=${action} category=${category}`,
    secrets,
  );
}
