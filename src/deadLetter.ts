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

export type DeadLetterReasonCode =
  | "DLQ_RATE_LIMITED"
  | "DLQ_AUTH_ERROR"
  | "DLQ_BAD_REQUEST"
  | "DLQ_TIMEOUT"
  | "DLQ_NETWORK_ERROR"
  | "DLQ_SERVER_ERROR"
  | "DLQ_UNKNOWN";

export interface DeadLetterIncidentEntry {
  id: string;
  enqueuedAt: string;
  source: string;
  ledger: number;
  eventName: string;
  attempts: number;
  reasonCode: DeadLetterReasonCode;
  textBytes: number;
}

export interface DeadLetterIncidentBundle {
  schemaVersion: 1;
  exportedAt: string;
  queue: {
    depth: number;
    maxEntries: number;
    maxAttempts: number;
    bySource: Record<string, number>;
    byReasonCode: Record<string, number>;
    oldestEnqueuedAt: string | null;
    newestEnqueuedAt: string | null;
  };
  entries: DeadLetterIncidentEntry[];
}

/** Map a persisted error string to a stable, destination-safe reason code. */
export function classifyReasonCode(
  lastError: string | null | undefined,
): DeadLetterReasonCode {
  if (!lastError || lastError.trim().length === 0) return "DLQ_UNKNOWN";
  const lower = lastError.toLowerCase();
  if (/\b429\b|too many requests|retry after|rate[- ]limit/.test(lower)) {
    return "DLQ_RATE_LIMITED";
  }
  if (/\b40[13]\b|unauthorized|forbidden|blocked|kicked/.test(lower)) {
    return "DLQ_AUTH_ERROR";
  }
  if (/\b40[04]\b|bad request|chat not found|can't parse|markdown|entity/.test(lower)) {
    return "DLQ_BAD_REQUEST";
  }
  if (/timed? ?out|etimedout|esockettimedout|aborterror|\b408\b/.test(lower)) {
    return "DLQ_TIMEOUT";
  }
  if (/econnrefused|econnreset|enotfound|ehostunreach|eai_again|fetch failed|network|socket/.test(lower)) {
    return "DLQ_NETWORK_ERROR";
  }
  if (/\b50[0234]\b|internal server error|bad gateway|service unavailable/.test(lower)) {
    return "DLQ_SERVER_ERROR";
  }
  return "DLQ_UNKNOWN";
}

/**
 * Build a redacted incident bundle containing queue metadata and stable reason
 * codes while omitting message bodies, bot credentials, and destination ids.
 */
export function buildIncidentBundle(
  entries: readonly DeadLetterEntry[],
  options: { maxEntries: number; maxAttempts: number; now?: () => number },
): DeadLetterIncidentBundle {
  const now = options.now ?? Date.now;
  const bySource: Record<string, number> = {};
  const byReasonCode: Record<string, number> = {};
  let oldestEnqueuedAt: string | null = null;
  let newestEnqueuedAt: string | null = null;

  const incidentEntries: DeadLetterIncidentEntry[] = entries.map((entry) => {
    const source = entry.source || "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const reasonCode = classifyReasonCode(entry.lastError);
    byReasonCode[reasonCode] = (byReasonCode[reasonCode] ?? 0) + 1;

    if (typeof entry.enqueuedAt === "string" && entry.enqueuedAt.length > 0) {
      if (oldestEnqueuedAt === null || entry.enqueuedAt < oldestEnqueuedAt) {
        oldestEnqueuedAt = entry.enqueuedAt;
      }
      if (newestEnqueuedAt === null || entry.enqueuedAt > newestEnqueuedAt) {
        newestEnqueuedAt = entry.enqueuedAt;
      }
    }

    return {
      id: entry.id,
      enqueuedAt: entry.enqueuedAt,
      source,
      ledger: entry.ledger,
      eventName: entry.eventName,
      attempts: entry.attempts,
      reasonCode,
      textBytes: Buffer.byteLength(entry.text, "utf8"),
    };
  });

  return {
    schemaVersion: 1,
    exportedAt: new Date(now()).toISOString(),
    queue: {
      depth: entries.length,
      maxEntries: options.maxEntries,
      maxAttempts: options.maxAttempts,
      bySource,
      byReasonCode,
      oldestEnqueuedAt,
      newestEnqueuedAt,
    },
    entries: incidentEntries,
  };
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

export function createDeadLetterQueue(options: DeadLetterQueueOptions) {
  const now = options.now ?? Date.now;
  const filePath = options.filePath;
  let entries: DeadLetterEntry[] = [];
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
        console.warn(
          `[dead-letter] unknown or corrupt queue at ${filePath}; starting empty`,
        );
        entries = [];
      } else {
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
      console.warn(
        `[dead-letter] unreadable queue at ${filePath}, starting empty: ${safeError(err)}`,
      );
      entries = [];
    }
    syncDepth();
    if (entries.length > 0) {
      console.log(`[dead-letter] loaded ${entries.length} parked send(s) from ${filePath}`);
    }
  }

  async function persist(): Promise<void> {
    if (filePath === null) {
      syncDepth();
      return;
    }
    const payload: DeadLetterFile = {
      version: 1,
      updatedAt: new Date(now()).toISOString(),
      entries,
    };
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      // Write-then-rename, like the cursor and status files: a reader never sees
      // a half-written queue, and a crash leaves the previous one intact.
      const tmp = `${filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, filePath);
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
    stats(): DeadLetterStats {
      return { ...stats, depth: entries.length };
    },
    incidentBundle(): DeadLetterIncidentBundle {
      return buildIncidentBundle(entries, {
        maxEntries: options.maxEntries,
        maxAttempts: options.maxAttempts,
        now,
      });
    },
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
