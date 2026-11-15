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
  /** Suppress informational console output (used by machine-readable CLI subcommands). */
  quiet?: boolean;
}

export class DlqMalformedFileError extends Error {
  readonly code = "MALFORMED_FILE" as const;
  readonly exitCode = 3 as const;

  constructor(message: string) {
    super(message);
    this.name = "DlqMalformedFileError";
  }
}

export class DlqAccessError extends Error {
  readonly code = "ACCESS_FAILURE" as const;
  readonly exitCode = 4 as const;

  constructor(message: string) {
    super(message);
    this.name = "DlqAccessError";
  }
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

/**
 * Strictly read and validate a dead-letter file for offline inspection without
 * writing log lines to stdout. Distinguishes missing (`ENOENT` -> empty),
 * filesystem access failure ({@link DlqAccessError}), and malformed content
 * ({@link DlqMalformedFileError}).
 */
export async function inspectDeadLetterFile(
  filePath: string,
  options: {
    now?: () => number;
    secrets?: readonly string[];
    maxEntries?: number;
  } = {},
): Promise<{ exists: boolean; updatedAt: string | null; entries: DeadLetterEntry[] }> {
  const now = options.now ?? Date.now;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { exists: false, updatedAt: null, entries: [] };
    }
    const safeMsg = truncate(safeErrorMessage(err, options.secrets ?? []), ERROR_TRUNCATE);
    throw new DlqAccessError(`cannot read dead-letter file ${filePath}: ${safeMsg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const safeMsg = truncate(safeErrorMessage(err, options.secrets ?? []), ERROR_TRUNCATE);
    throw new DlqMalformedFileError(`malformed JSON in dead-letter file ${filePath}: ${safeMsg}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new DlqMalformedFileError(
      `invalid dead-letter schema in ${filePath}: expected { version: 1, entries: [...] }`,
    );
  }

  const rawEntries = (parsed as { entries: unknown[]; updatedAt?: unknown }).entries;
  const validated: DeadLetterEntry[] = [];

  for (let i = 0; i < rawEntries.length; i += 1) {
    const item = rawEntries[i];
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as { id?: unknown }).id !== "string" ||
      (item as { id: string }).id.trim() === "" ||
      typeof (item as { text?: unknown }).text !== "string" ||
      typeof (item as { ledger?: unknown }).ledger !== "number" ||
      !Number.isFinite((item as { ledger: number }).ledger)
    ) {
      throw new DlqMalformedFileError(
        `malformed dead-letter entry at index ${i} in ${filePath}`,
      );
    }
    const rec = item as Partial<DeadLetterEntry> & { id: string; text: string; ledger: number };
    validated.push({
      id: rec.id,
      enqueuedAt:
        typeof rec.enqueuedAt === "string" ? rec.enqueuedAt : new Date(now()).toISOString(),
      source: typeof rec.source === "string" ? rec.source : "unknown",
      ledger: rec.ledger,
      eventName: typeof rec.eventName === "string" ? rec.eventName : "unknown",
      text: truncate(rec.text, TEXT_TRUNCATE),
      attempts: typeof rec.attempts === "number" && rec.attempts >= 0 ? rec.attempts : 0,
      lastError: typeof rec.lastError === "string" ? truncate(rec.lastError, ERROR_TRUNCATE) : null,
    });
  }

  const maxEntries = options.maxEntries;
  if (typeof maxEntries === "number" && maxEntries >= 1) {
    while (validated.length > maxEntries) {
      validated.shift();
    }
  }

  return {
    exists: true,
    updatedAt:
      typeof (parsed as { updatedAt?: unknown }).updatedAt === "string"
        ? ((parsed as { updatedAt: string }).updatedAt)
        : null,
    entries: validated,
  };
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
    if (entries.length > 0 && !options.quiet) {
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
        if (!options.quiet) {
          console.log(
            `[dead-letter] replayed ${entry.source} ${entry.eventName} @ ledger ${entry.ledger}`,
          );
        }
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
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
