/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds it appends a matching `done` line. When a send fails with a
 * Telegram API, timeout, or network error, `recordFailure` persists a redacted,
 * length-bounded remote error description alongside a stable error code for
 * operator triage.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done`) pairs are dropped, leaving only unresolved
 * intents (with their latest sanitized failure triage metadata when present).
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MAX_LEN, redactText } from "../redact.js";
import { isTimeoutError, safeErrorMessage } from "./format.js";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;
export const MAX_JOURNAL_ERROR_DESCRIPTION_CHARS = DEFAULT_MAX_LEN;

export type TelegramJournalErrorCode =
  | "TG_RATE_LIMITED"
  | "TG_UNAUTHORIZED"
  | "TG_FORBIDDEN"
  | "TG_NOT_FOUND"
  | "TG_ENTITY_PARSE_ERROR"
  | "TG_BAD_REQUEST"
  | "TG_CONFLICT"
  | "TG_SERVER_ERROR"
  | "TG_HTTP_ERROR"
  | "SEND_TIMEOUT"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

export interface SanitizedJournalError {
  errorCode: TelegramJournalErrorCode;
  telegramErrorCode?: number;
  description: string;
  retryAfterSeconds?: number;
}

function extractTelegramStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as {
    error_code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  for (const candidate of [rec.error_code, rec.status, rec.statusCode]) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  if (typeof rec.message === "string") {
    const match = /\((\d{3}):\s/.exec(rec.message);
    if (match) {
      const parsed = Number.parseInt(match[1]!, 10);
      if (parsed >= 100 && parsed <= 599) return parsed;
    }
  }
  return undefined;
}

function extractRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as {
    parameters?: { retry_after?: unknown } | undefined;
    description?: unknown;
    message?: unknown;
  };
  const paramRetry = rec.parameters?.retry_after;
  if (typeof paramRetry === "number" && Number.isFinite(paramRetry) && paramRetry > 0) {
    return Math.min(3600, Math.ceil(paramRetry));
  }
  const raw = [rec.description, rec.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  const match = /retry after (\d+)/i.exec(raw);
  if (match) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (parsed > 0) return Math.min(3600, parsed);
  }
  return undefined;
}

function isNetworkFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: unknown; code?: unknown; message?: unknown };
  if (rec.name === "HttpError") return true;
  if (
    typeof rec.code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(
      rec.code,
    )
  ) {
    return true;
  }
  if (
    typeof rec.message === "string" &&
    /network request for .* failed|fetch failed|socket hang up/i.test(rec.message)
  ) {
    return true;
  }
  return false;
}

function classifyErrorCode(
  err: unknown,
  telegramStatus: number | undefined,
  rawText: string,
): TelegramJournalErrorCode {
  if (isTimeoutError(err)) return "SEND_TIMEOUT";
  if (telegramStatus !== undefined) {
    if (telegramStatus === 429) return "TG_RATE_LIMITED";
    if (telegramStatus === 401) return "TG_UNAUTHORIZED";
    if (telegramStatus === 403) return "TG_FORBIDDEN";
    if (telegramStatus === 404) return "TG_NOT_FOUND";
    if (telegramStatus === 409) return "TG_CONFLICT";
    if (telegramStatus === 400) {
      if (/can't parse entities|can't find end of the entity/i.test(rawText)) {
        return "TG_ENTITY_PARSE_ERROR";
      }
      return "TG_BAD_REQUEST";
    }
    if (telegramStatus >= 500 && telegramStatus <= 599) return "TG_SERVER_ERROR";
    return "TG_HTTP_ERROR";
  }
  if (isNetworkFailure(err)) return "NETWORK_ERROR";
  return "UNKNOWN_ERROR";
}

function clampJournalText(text: string, maxLen: number): string {
  const cap = Math.max(1, Math.min(MAX_JOURNAL_ERROR_DESCRIPTION_CHARS, Math.floor(maxLen)));
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - 1))}…`;
}

/**
 * Sanitize an untrusted Telegram/network error before persisting to the send
 * journal: applies the repository's credential redaction rules, strips control
 * characters and newlines, enforces length bounds, and extracts a stable error
 * code for operator triage.
 */
export function sanitizeTelegramJournalError(
  err: unknown,
  options: { secrets?: readonly string[]; maxLen?: number } = {},
): SanitizedJournalError {
  const secrets = options.secrets ?? [];
  const maxLen = options.maxLen ?? MAX_JOURNAL_ERROR_DESCRIPTION_CHARS;
  const telegramErrorCode = extractTelegramStatusCode(err);

  let rawCandidate = "";
  if (err && typeof err === "object") {
    const rec = err as { description?: unknown; message?: unknown };
    if (typeof rec.description === "string" && rec.description.trim() !== "") {
      rawCandidate = rec.description;
    } else if (typeof rec.message === "string" && rec.message.trim() !== "") {
      rawCandidate = rec.message;
    }
  } else if (typeof err === "string") {
    rawCandidate = err;
  }

  const normalized = rawCandidate
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let sanitizedDescription: string;
  if (normalized !== "") {
    const redacted = redactText(normalized, { secrets, maxLen }).trim();
    sanitizedDescription = clampJournalText(
      redacted || (isTimeoutError(err) ? "send timed out" : "unknown error"),
      maxLen,
    );
  } else {
    const fallback = safeErrorMessage(err, secrets)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    sanitizedDescription = clampJournalText(fallback || "unknown error", maxLen);
  }

  const errorCode = classifyErrorCode(err, telegramErrorCode, rawCandidate || sanitizedDescription);
  const retryAfterSeconds =
    errorCode === "TG_RATE_LIMITED" ? extractRetryAfterSeconds(err) : undefined;

  return {
    errorCode,
    ...(telegramErrorCode !== undefined ? { telegramErrorCode } : {}),
    description: sanitizedDescription,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

export interface JournalEntry {
  kind: "intent" | "done" | "failed";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  /** Stable operator triage category when `kind === "failed"` or compacted onto an unresolved intent. */
  errorCode?: TelegramJournalErrorCode;
  /** Numeric HTTP / Bot API status code when present (e.g. `429`, `403`, `400`). */
  telegramErrorCode?: number;
  /** Redacted, length-bounded remote error description. */
  errorDescription?: string;
  /** Bounded retry-after hint in seconds on `429` failures. */
  retryAfterSeconds?: number;
  at: number;
}

export interface SendJournalOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  secrets?: readonly string[];
  maxErrorDescriptionChars?: number;
}

export interface SendJournalStats {
  entries: number;
  bytes: number;
}

export interface SendJournal {
  recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    textHash?: string;
    at: number;
  }): Promise<void>;
  recordDone(id: string): Promise<void>;
  recordFailure(entry: {
    id: string;
    error: unknown;
    source?: string;
    ledger?: number;
    eventName?: string;
    at?: number;
    secrets?: readonly string[];
  }): Promise<SanitizedJournalError>;
  /** Intents with no matching done: notifications that may have been sent or failed. */
  loadPending(): Promise<JournalEntry[]>;
  /** Unsettled sanitized failure records retained for operator triage. */
  loadFailures(): Promise<JournalEntry[]>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

function isDoneError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function createSendJournal(options: SendJournalOptions): SendJournal {
  const filePath = options.filePath;
  const dir = path.dirname(filePath);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_SEND_JOURNAL_MAX_ENTRIES);
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_SEND_JOURNAL_MAX_BYTES);
  const now = options.now ?? Date.now;
  const defaultSecrets = options.secrets ?? [];
  const maxErrorLen = options.maxErrorDescriptionChars ?? MAX_JOURNAL_ERROR_DESCRIPTION_CHARS;

  function sanitizeEntryForWrite(entry: JournalEntry): JournalEntry {
    if (typeof entry.errorDescription !== "string") {
      return entry;
    }
    const cleaned = clampJournalText(
      redactText(
        entry.errorDescription
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        { secrets: defaultSecrets, maxLen: maxErrorLen },
      ),
      maxErrorLen,
    );
    return {
      ...entry,
      errorDescription: cleaned || "unknown error",
    };
  }

  function line(entry: JournalEntry): string {
    return JSON.stringify(sanitizeEntryForWrite(entry));
  }

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Append one JSONL line and fsync so it survives a crash. */
  async function append(entry: JournalEntry): Promise<void> {
    await ensureDir();
    const handle = await open(filePath, "a");
    try {
      await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readLines(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return [];
      throw err;
    }
    const out: JournalEntry[] = [];
    for (const ln of raw.split("\n")) {
      const trimmed = ln.trim();
      if (trimmed === "") continue;
      try {
        out.push(sanitizeEntryForWrite(JSON.parse(trimmed) as JournalEntry));
      } catch {
        // A torn or corrupt line is skipped rather than failing the journal.
      }
    }
    return out;
  }

  /** Atomically rewrite the journal with the given entries and fsync. */
  async function persist(entries: JournalEntry[]): Promise<void> {
    await ensureDir();
    const tmp = `${filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      for (const entry of entries) await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmp, filePath);
    // Best-effort directory fsync so the rename itself is durable.
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the file fsync is
      // the durable part that matters for crash recovery.
    }
  }

  async function maybeCompact(): Promise<void> {
    const current = await journalStats();
    if (current.entries > maxEntries || current.bytes > maxBytes) {
      await compact();
    }
  }

  async function recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    textHash?: string;
    at: number;
  }): Promise<void> {
    await append({ kind: "intent", ...entry });
  }

  async function recordFailure(entry: {
    id: string;
    error: unknown;
    source?: string;
    ledger?: number;
    eventName?: string;
    at?: number;
    secrets?: readonly string[];
  }): Promise<SanitizedJournalError> {
    const mergedSecrets = [...defaultSecrets, ...(entry.secrets ?? [])];
    const sanitized = sanitizeTelegramJournalError(entry.error, {
      secrets: mergedSecrets,
      maxLen: maxErrorLen,
    });
    await append({
      kind: "failed",
      id: entry.id,
      source: entry.source ?? "",
      ledger: entry.ledger ?? 0,
      eventName: entry.eventName ?? "",
      errorCode: sanitized.errorCode,
      ...(sanitized.telegramErrorCode !== undefined
        ? { telegramErrorCode: sanitized.telegramErrorCode }
        : {}),
      errorDescription: sanitized.description,
      ...(sanitized.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: sanitized.retryAfterSeconds }
        : {}),
      at: entry.at ?? now(),
    });
    await maybeCompact();
    return sanitized;
  }

  async function recordDone(id: string): Promise<void> {
    await append({ kind: "done", id, source: "", ledger: 0, eventName: "", at: now() });
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    await maybeCompact();
  }

  function resolveState(entries: readonly JournalEntry[]): {
    pending: JournalEntry[];
    failures: JournalEntry[];
  } {
    const done = new Set<string>();
    const latestFailureById = new Map<string, JournalEntry>();
    for (const entry of entries) {
      if (entry.kind === "done") {
        done.add(entry.id);
      } else if (entry.kind === "failed" || entry.errorCode !== undefined) {
        latestFailureById.set(entry.id, entry);
      }
    }

    const seenIntentIds = new Set<string>();
    const pending: JournalEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== "intent" || done.has(entry.id)) continue;
      seenIntentIds.add(entry.id);
      const failure = latestFailureById.get(entry.id);
      if (failure) {
        pending.push({
          ...entry,
          ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
          ...(failure.telegramErrorCode !== undefined
            ? { telegramErrorCode: failure.telegramErrorCode }
            : {}),
          ...(failure.errorDescription !== undefined
            ? { errorDescription: failure.errorDescription }
            : {}),
          ...(failure.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: failure.retryAfterSeconds }
            : {}),
        });
      } else {
        pending.push(entry);
      }
    }

    const failures: JournalEntry[] = [];
    for (const [id, failure] of latestFailureById.entries()) {
      if (done.has(id)) continue;
      if (seenIntentIds.has(id)) {
        const enriched = pending.find((p) => p.id === id);
        if (enriched) failures.push(enriched);
      } else {
        failures.push(failure);
      }
    }

    return { pending, failures };
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    return resolveState(entries).pending;
  }

  async function loadFailures(): Promise<JournalEntry[]> {
    const entries = await readLines();
    return resolveState(entries).failures;
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    const { pending, failures } = resolveState(entries);
    const pendingIds = new Set(pending.map((p) => p.id));
    const standaloneFailures = failures.filter((f) => !pendingIds.has(f.id));
    await persist([...pending, ...standaloneFailures]);
  }

  async function journalStats(): Promise<SendJournalStats> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return { entries: 0, bytes: 0 };
      throw err;
    }
    let entries = 0;
    for (const ln of raw.split("\n")) {
      if (ln.trim() !== "") entries += 1;
    }
    return { entries, bytes: Buffer.byteLength(raw, "utf8") };
  }

  async function stats(): Promise<SendJournalStats> {
    return journalStats();
  }

  return {
    recordIntent,
    recordDone,
    recordFailure,
    loadPending,
    loadFailures,
    compact,
    stats,
  };
}
