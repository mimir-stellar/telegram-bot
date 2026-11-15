/**
 * Local dead-letter queue for Telegram sends that exhausted in-cycle retries.
 *
 * Before this, a send that failed every retry was dropped and counted: the
 * cursor advanced (correct — the chain is the source of truth, and a broken
 * token must not wedge the poller) but the notification was gone, and the only
 * trace was one `notificationsFailed` tick and an audit line. The queue parks
 * those messages on disk instead, so a rate limit or a short Telegram outage
 * costs a delay rather than the message.
 *
 * Bounded on every axis, because none of the inputs are trusted:
 *
 *  - Depth: `maxEntries`; the oldest entry is dropped when the queue is full, so
 *    a permanently broken token cannot grow the file without limit.
 *  - Attempts: an entry that fails `maxAttempts` replays is a poison entry and
 *    is dropped, so a message Telegram will never accept cannot be retried
 *    forever.
 *  - Size: the message body and the recorded error are both truncated.
 *  - Content: the stored error goes through `safeErrorMessage`, so a token or a
 *    seed strkey in an upstream error cannot be persisted to the file (the same
 *    rule that governs every other operator-facing string).
 *
 * The queue holds only already-formatted MarkdownV2 text plus short operational
 * metadata. It never holds signing keys or bot tokens.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeErrorMessage } from "./notifications/format.js";

export interface DeadLetterEntry {
  /** Stable id within the queue (source + ledger + event + short text hash). */
  id: string;
  enqueuedAt: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Already-formatted MarkdownV2 message body, truncated to {@link TEXT_TRUNCATE}. */
  text: string;
  attempts: number;
  lastError: string | null;
}

export interface DeadLetterFile {
  version: 1;
  updatedAt: string;
  entries: DeadLetterEntry[];
}

export interface DeadLetterStats {
  depth: number;
  enqueued: number;
  replayed: number;
  dropped: number;
}

export interface DeadLetterQueueOptions {
  /**
   * Where the queue lives. `null` disables persistence and loading: the queue
   * then works in memory only, which is how a caller that predates the setting
   * (a hand-built config in a test, a tool) keeps its old behaviour with no
   * file access at all.
   */
  filePath: string | null;
  maxEntries: number;
  maxAttempts: number;
  /**
   * Config secrets to scrub from a recorded error, passed straight to
   * `safeErrorMessage`. The poller hands over its bot token: a Telegram failure
   * routinely embeds the token in the request URL, and main's shape rule
   * deliberately does not match a token that follows the literal `bot` prefix in
   * a URL, so the value itself is what makes that case safe.
   */
  secrets?: readonly string[];
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Suppress informational console output (used by machine-readable CLI modes). */
  quiet?: boolean;
}

export const INCIDENT_BUNDLE_SCHEMA_VERSION = 1 as const;

export const DEAD_LETTER_REASON_CODES = [
  "RATE_LIMITED",
  "TIMEOUT",
  "AUTH_OR_PERMISSION",
  "BAD_REQUEST",
  "UPSTREAM_UNAVAILABLE",
  "NETWORK_ERROR",
  "UNKNOWN",
] as const;

export type DeadLetterReasonCode = (typeof DEAD_LETTER_REASON_CODES)[number];

export interface DeadLetterIncidentItem {
  id: string;
  enqueuedAt: string;
  source: string;
  ledger: number;
  eventName: string;
  attempts: number;
  reasonCode: DeadLetterReasonCode;
  redactedError: string | null;
}

export interface DeadLetterIncidentBundle {
  schemaVersion: typeof INCIDENT_BUNDLE_SCHEMA_VERSION;
  generatedAt: string;
  queue: {
    schemaVersion: 1;
    fileUpdatedAt: string | null;
    depth: number;
    maxEntries: number;
    maxAttempts: number;
    oldestEnqueuedAt: string | null;
    newestEnqueuedAt: string | null;
    bySource: Record<string, number>;
    byReasonCode: Record<DeadLetterReasonCode, number>;
  };
  entries: DeadLetterIncidentItem[];
}

export interface IncidentBundleOptions {
  entries: readonly DeadLetterEntry[];
  fileUpdatedAt?: string | null;
  maxEntries?: number;
  maxAttempts?: number;
  secrets?: readonly string[];
  privateDestinations?: readonly string[];
  now?: () => number;
}

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;

const ERROR_TRUNCATE = 200;
/** Telegram's own message ceiling (4,096) minus room for the queue's own text. */
const TEXT_TRUNCATE = 4_000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Short non-crypto fingerprint so duplicate failures collapse into one entry. */
function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Identity of a parked message: the same event failing twice is one entry. */
export function makeEntryId(
  source: string,
  ledger: number,
  eventName: string,
  text: string,
): string {
  return `${source}:${ledger}:${eventName}:${shortHash(text)}`;
}

const PUBLIC_SOURCES = new Set(["market", "squad", "default", "unknown"]);

/** Map a recorded failure string to a stable operator triage reason code. */
export function classifyDeadLetterReasonCode(
  lastError: string | null | undefined,
): DeadLetterReasonCode {
  if (!lastError || lastError.trim() === "") return "UNKNOWN";
  const lower = lastError.toLowerCase();

  if (
    /\b429\b/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("retry after")
  ) {
    return "RATE_LIMITED";
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("aborted") ||
    lower.includes("deadline")
  ) {
    return "TIMEOUT";
  }
  if (
    /\b(401|403)\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("bot was blocked") ||
    lower.includes("chat not found") ||
    lower.includes("not enough rights")
  ) {
    return "AUTH_OR_PERMISSION";
  }
  if (
    /\b400\b/.test(lower) ||
    lower.includes("bad request") ||
    lower.includes("can't parse entities") ||
    lower.includes("message is too long")
  ) {
    return "BAD_REQUEST";
  }
  if (
    /\b(500|502|503|504)\b/.test(lower) ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout")
  ) {
    return "UPSTREAM_UNAVAILABLE";
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("network")
  ) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

function scrubIncidentText(
  input: string,
  secrets: readonly string[],
  privateDestinations: readonly string[],
): string {
  let out = safeErrorMessage(input, secrets);
  out = out.replace(/https?:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[REDACTED]");
  out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");

  for (const dest of privateDestinations) {
    const trimmed = dest.trim();
    if (trimmed.length >= 2 && out.includes(trimmed)) {
      out = out.split(trimmed).join("[OMITTED_DESTINATION]");
    }
  }

  out = out.replace(
    /\b(chat(?:_id|Id)?(?:\s*[:=]|\s+))(-?\d{4,}|@[A-Za-z0-9_]{3,})/gi,
    (_full, prefix: string) => `${prefix}[OMITTED_DESTINATION]`,
  );
  out = out.replace(/(?<![A-Za-z0-9_-])-\d{6,}\b/g, "[OMITTED_DESTINATION]");
  out = out.replace(/@[A-Za-z0-9_]{4,}\b/g, "[OMITTED_DESTINATION]");

  return truncate(out, 160);
}

function sanitizeIncidentSource(source: string): string {
  const normalized = source.trim();
  return PUBLIC_SOURCES.has(normalized) ? normalized : "custom_route";
}

function sanitizeIncidentEntryId(
  entry: DeadLetterEntry,
  secrets: readonly string[],
  privateDestinations: readonly string[],
): string {
  const safeSource = sanitizeIncidentSource(entry.source);
  const parts = entry.id.split(":");
  if (parts.length >= 4) {
    const rest = parts.slice(1).join(":");
    return scrubIncidentText(`${safeSource}:${rest}`, secrets, privateDestinations);
  }
  return scrubIncidentText(entry.id, secrets, privateDestinations);
}

/**
 * Build a shareable, redacted incident bundle with queue metadata and stable
 * reason codes while omitting message bodies, bot credentials, and private
 * destination identifiers.
 */
export function buildDeadLetterIncidentBundle(
  options: IncidentBundleOptions,
): DeadLetterIncidentBundle {
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? [];
  const privateDestinations = [...(options.privateDestinations ?? [])];

  for (const entry of options.entries) {
    const maybeChatId = (entry as DeadLetterEntry & { chatId?: unknown }).chatId;
    if (typeof maybeChatId === "string" && maybeChatId.trim().length > 0) {
      privateDestinations.push(maybeChatId.trim());
    }
  }

  const bySource: Record<string, number> = {};
  const byReasonCode: Record<DeadLetterReasonCode, number> = {
    RATE_LIMITED: 0,
    TIMEOUT: 0,
    AUTH_OR_PERMISSION: 0,
    BAD_REQUEST: 0,
    UPSTREAM_UNAVAILABLE: 0,
    NETWORK_ERROR: 0,
    UNKNOWN: 0,
  };

  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  let oldestEnqueuedAt: string | null = null;
  let newestEnqueuedAt: string | null = null;

  const items: DeadLetterIncidentItem[] = options.entries.map((entry) => {
    const safeSource = sanitizeIncidentSource(entry.source);
    const reasonCode = classifyDeadLetterReasonCode(entry.lastError);
    bySource[safeSource] = (bySource[safeSource] ?? 0) + 1;
    byReasonCode[reasonCode] += 1;

    const ts = Date.parse(entry.enqueuedAt);
    if (Number.isFinite(ts)) {
      if (ts < oldestMs) {
        oldestMs = ts;
        oldestEnqueuedAt = entry.enqueuedAt;
      }
      if (ts > newestMs) {
        newestMs = ts;
        newestEnqueuedAt = entry.enqueuedAt;
      }
    }

    return {
      id: sanitizeIncidentEntryId(entry, secrets, privateDestinations),
      enqueuedAt: entry.enqueuedAt,
      source: safeSource,
      ledger: entry.ledger,
      eventName: scrubIncidentText(entry.eventName, secrets, privateDestinations),
      attempts: entry.attempts,
      reasonCode,
      redactedError:
        entry.lastError === null
          ? null
          : scrubIncidentText(entry.lastError, secrets, privateDestinations),
    };
  });

  return {
    schemaVersion: INCIDENT_BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    queue: {
      schemaVersion: 1,
      fileUpdatedAt: options.fileUpdatedAt ?? null,
      depth: items.length,
      maxEntries: options.maxEntries ?? DEAD_LETTER_MAX_ENTRIES,
      maxAttempts: options.maxAttempts ?? DEAD_LETTER_MAX_ATTEMPTS,
      oldestEnqueuedAt,
      newestEnqueuedAt,
      bySource,
      byReasonCode,
    },
    entries: items,
  };
}

export function createDeadLetterQueue(options: DeadLetterQueueOptions) {
  const now = options.now ?? Date.now;
  const filePath = options.filePath;
  const quiet = options.quiet === true;
  let entries: DeadLetterEntry[] = [];
  let fileUpdatedAt: string | null = null;
  const stats: DeadLetterStats = {
    depth: 0,
    enqueued: 0,
    replayed: 0,
    dropped: 0,
  };

  /** Redacted, truncated error text — the only form that may be persisted. */
  function safeError(err: unknown): string {
    return truncate(safeErrorMessage(err, options.secrets ?? []), ERROR_TRUNCATE);
  }

  function syncDepth(): void {
    stats.depth = entries.length;
  }

  async function load(): Promise<void> {
    if (filePath === null) {
      entries = [];
      syncDepth();
      return;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // No file yet is the normal first-run case, not a problem to report.
      entries = [];
      syncDepth();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as DeadLetterFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        if (!quiet) {
          console.warn(
            `[dead-letter] unknown or corrupt queue at ${filePath}; starting empty`,
          );
        }
        entries = [];
        fileUpdatedAt = null;
      } else {
        fileUpdatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
        entries = parsed.entries
          .filter(
            (e) =>
              e &&
              typeof e.id === "string" &&
              typeof e.text === "string" &&
              typeof e.ledger === "number",
          )
          .map((e) => ({
            id: e.id,
            enqueuedAt:
              typeof e.enqueuedAt === "string" ? e.enqueuedAt : new Date(now()).toISOString(),
            source: typeof e.source === "string" ? e.source : "unknown",
            ledger: e.ledger,
            eventName: typeof e.eventName === "string" ? e.eventName : "unknown",
            text: truncate(e.text, TEXT_TRUNCATE),
            attempts: typeof e.attempts === "number" && e.attempts >= 0 ? e.attempts : 0,
            lastError: typeof e.lastError === "string" ? truncate(e.lastError, ERROR_TRUNCATE) : null,
          }));
        // Bound on load too: the file may have been edited by hand.
        while (entries.length > options.maxEntries) {
          entries.shift();
          stats.dropped += 1;
        }
      }
    } catch (err) {
      if (!quiet) {
        console.warn(
          `[dead-letter] unreadable queue at ${filePath}, starting empty: ${safeError(err)}`,
        );
      }
      entries = [];
      fileUpdatedAt = null;
    }
    syncDepth();
    if (entries.length > 0 && !quiet) {
      console.log(`[dead-letter] loaded ${entries.length} parked send(s) from ${filePath}`);
    }
  }

  async function persist(): Promise<void> {
    if (filePath === null) {
      syncDepth();
      return;
    }
    const updatedAt = new Date(now()).toISOString();
    const payload: DeadLetterFile = {
      version: 1,
      updatedAt,
      entries,
    };
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      // Write-then-rename, like the cursor and status files: a reader never sees
      // a half-written queue, and a crash leaves the previous one intact.
      const tmp = `${filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, filePath);
      fileUpdatedAt = updatedAt;
    } catch (err) {
      // An unwritable queue is degraded observability, never a reason to stop
      // notifying or to throw into the poll loop.
      console.error(`[dead-letter] could not persist queue: ${safeError(err)}`);
    }
    syncDepth();
  }

  async function enqueue(input: {
    source: string;
    ledger: number;
    eventName: string;
    text: string;
    error: unknown;
  }): Promise<DeadLetterEntry> {
    const id = makeEntryId(input.source, input.ledger, input.eventName, input.text);
    const existing = entries.find((e) => e.id === id);
    if (existing) {
      existing.attempts += 1;
      existing.lastError = safeError(input.error);
      await persist();
      return existing;
    }

    while (entries.length >= Math.max(1, options.maxEntries)) {
      const dropped = entries.shift();
      stats.dropped += 1;
      if (dropped) {
        console.warn(
          `[dead-letter] queue full (max ${options.maxEntries}); dropped oldest ` +
            `${dropped.source} ${dropped.eventName} @ ledger ${dropped.ledger}`,
        );
      }
    }

    const entry: DeadLetterEntry = {
      id,
      enqueuedAt: new Date(now()).toISOString(),
      source: input.source,
      ledger: input.ledger,
      eventName: input.eventName,
      text: truncate(input.text, TEXT_TRUNCATE),
      attempts: 1,
      lastError: safeError(input.error),
    };
    entries.push(entry);
    stats.enqueued += 1;
    syncDepth();
    console.warn(
      `[dead-letter] parked ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
        `(depth ${entries.length}/${options.maxEntries}): ${entry.lastError}`,
    );
    await persist();
    return entry;
  }

  /**
   * Resend parked messages, oldest first. Stops after `budget` successful sends
   * so one recovery cannot flood the channel. Never throws: a failed replay
   * updates the entry in place, and a poison entry is dropped once it has used
   * its attempts.
   */
  async function flush(
    send: (text: string, entry: DeadLetterEntry) => Promise<void>,
    budget: number,
  ): Promise<{ sent: number; remaining: number }> {
    if (budget <= 0 || entries.length === 0) {
      return { sent: 0, remaining: entries.length };
    }

    let sent = 0;
    const kept: DeadLetterEntry[] = [];

    for (const entry of entries) {
      if (sent >= budget) {
        kept.push(entry);
        continue;
      }

      try {
        await send(entry.text, entry);
        sent += 1;
        stats.replayed += 1;
        console.log(
          `[dead-letter] replayed ${entry.source} ${entry.eventName} @ ledger ${entry.ledger}`,
        );
      } catch (err) {
        entry.attempts += 1;
        entry.lastError = safeError(err);
        if (entry.attempts >= options.maxAttempts) {
          stats.dropped += 1;
          console.error(
            `[dead-letter] dropping ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
              `after ${entry.attempts} attempts: ${entry.lastError}`,
          );
        } else {
          kept.push(entry);
          console.warn(
            `[dead-letter] replay failed for ${entry.source} ${entry.eventName} ` +
              `@ ledger ${entry.ledger} (attempt ${entry.attempts}/${options.maxAttempts}): ` +
              entry.lastError,
          );
        }
      }
    }

    entries = kept;
    syncDepth();
    await persist();
    return { sent, remaining: entries.length };
  }

  return {
    load,
    enqueue,
    flush,
    incidentBundle(
      extra?: { privateDestinations?: readonly string[] },
    ): DeadLetterIncidentBundle {
      return buildDeadLetterIncidentBundle({
        entries,
        fileUpdatedAt,
        maxEntries: options.maxEntries,
        maxAttempts: options.maxAttempts,
        secrets: options.secrets,
        privateDestinations: extra?.privateDestinations,
        now,
      });
    },
    stats(): DeadLetterStats {
      return { ...stats, depth: entries.length };
    },
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
