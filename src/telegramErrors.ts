/**
 * Classify Telegram / grammy API failures into bounded, log-safe categories.
 *
 * The poller treats every send failure as lossy (cursor still advances). This
 * module does not change that policy — it makes the *reason* actionable in
 * logs and `/status` without leaking bot tokens or unbounded remote payloads.
 */

import { GrammyError, HttpError } from "grammy";

/** Bounded set of operator-facing categories. */
export type TelegramErrorKind =
  | "rate_limit"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "bad_request"
  | "network"
  | "unknown";

export interface ClassifiedTelegramError {
  kind: TelegramErrorKind;
  /** Safe to retry later without rotating tokens or changing chat membership. */
  retryable: boolean;
  /** Seconds Telegram asked us to wait (`retry_after`), when present. */
  retryAfterSeconds: number | null;
  /** Telegram `error_code` when this was a Bot API response error. */
  errorCode: number | null;
  /** grammy method name (`sendMessage`, …) when known. */
  method: string | null;
  /** One-line summary safe for logs and `/status` — no tokens, no payloads. */
  safeMessage: string;
}

/** Cap description / message bodies so a hostile API cannot fill the log. */
const MAX_DETAIL = 180;

/** Cap a single rate-limit wait so a bad `retry_after` cannot stall the cycle. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

const TOKEN_PATTERNS: RegExp[] = [
  // BotFather tokens, including the common `bot<token>` URL / log form.
  /(?:\/?bot)?\d{6,}:[A-Za-z0-9_-]{20,}/gi,
];

/** Strip bot tokens and truncate so logs stay actionable and bounded. */
export function redactSecrets(text: string, max = MAX_DETAIL): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, "[REDACTED_BOT_TOKEN]");
  }
  // Collapse whitespace so multi-line stack/HTML blobs stay one log line.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length <= max) return out;
  return `${out.slice(0, max - 1)}…`;
}

function kindFromCode(code: number, description: string): TelegramErrorKind {
  const lower = description.toLowerCase();
  if (code === 429 || lower.includes("too many requests") || lower.includes("retry after")) {
    return "rate_limit";
  }
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 404) return "not_found";
  if (code === 409) return "conflict";
  if (code === 400) return "bad_request";
  return "unknown";
}

function retryableFor(kind: TelegramErrorKind): boolean {
  switch (kind) {
    case "rate_limit":
    case "network":
    case "conflict":
      return true;
    case "unauthorized":
    case "forbidden":
    case "not_found":
    case "bad_request":
    case "unknown":
      return false;
  }
}

function readRetryAfter(err: GrammyError): number | null {
  const raw = err.parameters?.retry_after;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.ceil(raw), MAX_RATE_LIMIT_WAIT_SECONDS);
  }
  // Fall back to parsing "retry after N" from the description.
  const match = /retry after (\d+)/i.exec(err.description);
  if (match?.[1]) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n), MAX_RATE_LIMIT_WAIT_SECONDS);
  }
  return null;
}

/**
 * Map any thrown value from a Telegram / grammy call into a classified record.
 * Duck-types Grammy-shaped objects so unit tests need not construct real
 * grammy instances.
 */
export function classifyTelegramError(err: unknown): ClassifiedTelegramError {
  if (err instanceof GrammyError || isGrammyShaped(err)) {
    const errorCode = err.error_code;
    const description = typeof err.description === "string" ? err.description : "";
    const method = typeof err.method === "string" ? err.method : null;
    const kind = kindFromCode(errorCode, description);
    const retryAfterSeconds = kind === "rate_limit" ? readRetryAfterFromUnknown(err) : null;
    const detail = redactSecrets(description || err.message || "telegram api error");
    const safeMessage = [
      `telegram ${kind}`,
      errorCode != null ? `code=${errorCode}` : null,
      method ? `method=${method}` : null,
      retryAfterSeconds != null ? `retry_after=${retryAfterSeconds}s` : null,
      detail,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      kind,
      retryable: retryableFor(kind),
      retryAfterSeconds,
      errorCode,
      method,
      safeMessage,
    };
  }

  if (err instanceof HttpError || isHttpShaped(err)) {
    const cause = "error" in err ? err.error : undefined;
    const nested =
      cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : "";
    const detail = redactSecrets(
      [err.message, nested].filter(Boolean).join(": ") || "telegram http error",
    );
    return {
      kind: "network",
      retryable: true,
      retryAfterSeconds: null,
      errorCode: null,
      method: null,
      safeMessage: `telegram network · ${detail}`,
    };
  }

  if (err instanceof Error) {
    const detail = redactSecrets(err.message || err.name);
    // Heuristic: timeouts / fetch failures without a Grammy wrapper.
    const lower = detail.toLowerCase();
    const networkish =
      lower.includes("fetch") ||
      lower.includes("network") ||
      lower.includes("econn") ||
      lower.includes("etimedout") ||
      lower.includes("socket");
    const kind: TelegramErrorKind = networkish ? "network" : "unknown";
    return {
      kind,
      retryable: retryableFor(kind),
      retryAfterSeconds: null,
      errorCode: null,
      method: null,
      safeMessage: `telegram ${kind} · ${detail}`,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    retryAfterSeconds: null,
    errorCode: null,
    method: null,
    safeMessage: `telegram unknown · ${redactSecrets(String(err))}`,
  };
}

interface GrammyShaped {
  error_code: number;
  description?: string;
  message?: string;
  method?: string;
  parameters?: { retry_after?: number };
}

function isGrammyShaped(err: unknown): err is GrammyShaped {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as GrammyShaped).error_code === "number"
  );
}

function isHttpShaped(err: unknown): err is Error & { error?: unknown } {
  return err instanceof Error && err.name === "HttpError";
}

function readRetryAfterFromUnknown(err: GrammyShaped | GrammyError): number | null {
  if (err instanceof GrammyError) return readRetryAfter(err);
  const raw = err.parameters?.retry_after;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.ceil(raw), MAX_RATE_LIMIT_WAIT_SECONDS);
  }
  const description = typeof err.description === "string" ? err.description : "";
  const match = /retry after (\d+)/i.exec(description);
  if (match?.[1]) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n), MAX_RATE_LIMIT_WAIT_SECONDS);
  }
  return null;
}
