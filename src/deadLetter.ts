/**
 * Local dead-letter queue for Telegram sends that exhausted in-cycle retries.
 *
 * Failed notifications are persisted to a flat JSON file so a transient
 * Telegram outage (rate limit, brief network blip) can be replayed after the
 * chain cursor has already advanced. The queue is bounded: when full, the
 * oldest entry is dropped so a permanently broken token cannot grow the file
 * without limit. Entries that exceed the attempt budget are also dropped.
 *
 * The chain remains the source of truth. This queue never holds signing keys,
 * bot tokens, or unbounded remote payloads — only the already-formatted
 * MarkdownV2 text the notifier was about to send, plus short operational
 * metadata (source, ledger, event name, truncated last error).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeadLetterEntry {
  /** Stable id within the queue (source + ledger + event + short hash of text). */
  id: string;
  enqueuedAt: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Already-formatted MarkdownV2 message body. */
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
  filePath: string;
  maxEntries: number;
  maxAttempts: number;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

const ERROR_TRUNCATE = 200;
const TEXT_TRUNCATE = 4_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Short non-crypto fingerprint so duplicate failures dedupe within a cycle. */
function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

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
  let entries: DeadLetterEntry[] = [];
  const stats: DeadLetterStats = {
    depth: 0,
    enqueued: 0,
    replayed: 0,
    dropped: 0,
  };

  function syncDepth(): void {
    stats.depth = entries.length;
  }

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(options.filePath, "utf8");
    } catch {
      entries = [];
      syncDepth();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as DeadLetterFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        console.warn(
          `[dead-letter] unknown or corrupt file at ${options.filePath}; starting empty`,
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
            enqueuedAt: typeof e.enqueuedAt === "string" ? e.enqueuedAt : new Date(now()).toISOString(),
            source: typeof e.source === "string" ? e.source : "unknown",
            ledger: e.ledger,
            eventName: typeof e.eventName === "string" ? e.eventName : "unknown",
            text: truncate(e.text, TEXT_TRUNCATE),
            attempts: typeof e.attempts === "number" && e.attempts >= 0 ? e.attempts : 0,
            lastError:
              typeof e.lastError === "string" ? truncate(e.lastError, ERROR_TRUNCATE) : null,
          }));
        // Bound on load in case the file was edited by hand.
        while (entries.length > options.maxEntries) {
          entries.shift();
          stats.dropped += 1;
        }
      }
    } catch (err) {
      console.warn(
        `[dead-letter] unreadable file at ${options.filePath}, starting empty: ${errorMessage(err)}`,
      );
      entries = [];
    }
    syncDepth();
    if (entries.length > 0) {
      console.log(`[dead-letter] loaded ${entries.length} pending send(s) from ${options.filePath}`);
    }
  }

  async function persist(): Promise<void> {
    const payload: DeadLetterFile = {
      version: 1,
      updatedAt: new Date(now()).toISOString(),
      entries,
    };
    try {
      await mkdir(path.dirname(options.filePath), { recursive: true });
      const tmp = `${options.filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, options.filePath);
    } catch (err) {
      console.error(`[dead-letter] could not persist queue: ${errorMessage(err)}`);
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
      existing.lastError = truncate(errorMessage(input.error), ERROR_TRUNCATE);
      await persist();
      return existing;
    }

    while (entries.length >= options.maxEntries) {
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
      lastError: truncate(errorMessage(input.error), ERROR_TRUNCATE),
    };
    entries.push(entry);
    stats.enqueued += 1;
    syncDepth();
    console.warn(
      `[dead-letter] enqueued ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
        `(depth ${entries.length}/${options.maxEntries}): ${entry.lastError}`,
    );
    await persist();
    return entry;
  }

  /**
   * Attempt to resend queued messages, oldest first.
   * Stops after `budget` successful sends (or when the queue is empty).
   * Does not throw — send failures update the entry in place.
   */
  async function flush(
    send: (text: string) => Promise<void>,
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
        await send(entry.text);
        sent += 1;
        stats.replayed += 1;
        console.log(
          `[dead-letter] replayed ${entry.source} ${entry.eventName} @ ledger ${entry.ledger}`,
        );
      } catch (err) {
        entry.attempts += 1;
        entry.lastError = truncate(errorMessage(err), ERROR_TRUNCATE);
        if (entry.attempts >= options.maxAttempts) {
          stats.dropped += 1;
          console.error(
            `[dead-letter] dropping ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
              `after ${entry.attempts} attempts: ${entry.lastError}`,
          );
        } else {
          kept.push(entry);
          console.warn(
            `[dead-letter] replay failed for ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
              `(attempt ${entry.attempts}/${options.maxAttempts}): ${entry.lastError}`,
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
