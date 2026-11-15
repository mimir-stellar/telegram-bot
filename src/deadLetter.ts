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

export type DeadLetterReasonCategory =
  | "rate_limited"
  | "timeout"
  | "network"
  | "auth_or_permission"
  | "bad_request"
  | "server_error"
  | "unknown";

export const DEAD_LETTER_REASON_CATEGORIES: readonly DeadLetterReasonCategory[] = [
  "rate_limited",
  "timeout",
  "network",
  "auth_or_permission",
  "bad_request",
  "server_error",
  "unknown",
] as const;

export interface DeadLetterDestinationSummary {
  /** Coarse redacted destination shape (e.g. "-…7890" or "@m…") or logical source name. */
  destination: string;
  count: number;
  reasons: Partial<Record<DeadLetterReasonCategory, number>>;
}

export interface DeadLetterStatusSummary {
  depth: number;
  enqueued: number;
  replayed: number;
  dropped: number;
  reasons: Partial<Record<DeadLetterReasonCategory, number>>;
  destinations: DeadLetterDestinationSummary[];
}

export interface DeadLetterStats {
  depth: number;
  enqueued: number;
  replayed: number;
  dropped: number;
  reasonCounts?: Partial<Record<DeadLetterReasonCategory, number>>;
  sourceCounts?: Record<string, number>;
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

/**
 * Redact a destination chat id to its coarse shape (matching `redactChatId` in
 * `src/status.ts`) so raw numeric chat ids and @channelusernames never leak into
 * operator status summaries.
 */
function redactDestination(raw: string | undefined): string {
  if (typeof raw !== "string") return "…";
  const trimmed = raw.trim();
  if (trimmed === "") return "…";
  if (trimmed.startsWith("@")) {
    return trimmed.length > 1 ? `@${trimmed[1]}…` : "@…";
  }
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 0) {
    // Logical source label such as "market" or "squad" when no chat id is supplied.
    if (/^[a-z0-9_-]{1,32}$/i.test(trimmed)) return trimmed;
    return "…";
  }
  const sign = trimmed.startsWith("-") ? "-" : "";
  return `${sign}…${digits.slice(-4)}`;
}

/**
 * Classify a stored dead-letter error string into a bounded, payload-free reason
 * category safe for operator status surfaces.
 */
export function classifyDeadLetterReason(
  lastError: string | null | undefined,
): DeadLetterReasonCategory {
  if (typeof lastError !== "string" || lastError.trim() === "") {
    return "unknown";
  }
  const lower = lastError.toLowerCase();
  if (/\b429\b|too many requests|retry[_ -]?after|flood/i.test(lower)) {
    return "rate_limited";
  }
  if (/timed?\s*out|etimedout|abort/i.test(lower)) {
    return "timeout";
  }
  if (/\b(?:401|403)\b|unauthorized|forbidden|bot was blocked|kicked|not a member/i.test(lower)) {
    return "auth_or_permission";
  }
  if (/\b400\b|bad request|parse entities|can't find end of the entity|chat not found/i.test(lower)) {
    return "bad_request";
  }
  if (/\b50[0234]\b|bad gateway|service unavailable|gateway timeout|internal server error/i.test(lower)) {
    return "server_error";
  }
  if (/econnreset|econnrefused|enotfound|eai_again|fetch failed|socket|network/i.test(lower)) {
    return "network";
  }
  return "unknown";
}

/**
 * Build a destination-safe summary from parked dead-letter entries and counters.
 * Reports counts and reason categories only — raw failed message text and raw
 * error descriptions are never included.
 */
export function summarizeDeadLetters(
  entries: readonly DeadLetterEntry[],
  counters?: Partial<Pick<DeadLetterStats, "enqueued" | "replayed" | "dropped">>,
  resolveDestination?: (source: string, entry: DeadLetterEntry) => string | undefined,
): DeadLetterStatusSummary {
  const reasons: Partial<Record<DeadLetterReasonCategory, number>> = {};
  const byDest = new Map<string, DeadLetterDestinationSummary>();

  for (const entry of entries) {
    const category = classifyDeadLetterReason(entry.lastError);
    reasons[category] = (reasons[category] ?? 0) + 1;

    const rawDest = resolveDestination
      ? resolveDestination(entry.source, entry)
      : entry.source;
    const destination = redactDestination(rawDest ?? entry.source);

    let bucket = byDest.get(destination);
    if (!bucket) {
      bucket = { destination, count: 0, reasons: {} };
      byDest.set(destination, bucket);
    }
    bucket.count += 1;
    bucket.reasons[category] = (bucket.reasons[category] ?? 0) + 1;
  }

  const destinations = [...byDest.values()].sort(
    (a, b) => b.count - a.count || a.destination.localeCompare(b.destination),
  );

  return {
    depth: entries.length,
    enqueued: counters?.enqueued ?? 0,
    replayed: counters?.replayed ?? 0,
    dropped: counters?.dropped ?? 0,
    reasons,
    destinations,
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

  function computeBreakdown(): {
    reasonCounts: Partial<Record<DeadLetterReasonCategory, number>>;
    sourceCounts: Record<string, number>;
  } {
    const reasonCounts: Partial<Record<DeadLetterReasonCategory, number>> = {};
    const sourceCounts: Record<string, number> = {};
    for (const entry of entries) {
      const cat = classifyDeadLetterReason(entry.lastError);
      reasonCounts[cat] = (reasonCounts[cat] ?? 0) + 1;
      const src = typeof entry.source === "string" && entry.source ? entry.source : "unknown";
      sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    }
    return { reasonCounts, sourceCounts };
  }

  return {
    load,
    enqueue,
    flush,
    stats(): DeadLetterStats {
      const { reasonCounts, sourceCounts } = computeBreakdown();
      return {
        ...stats,
        depth: entries.length,
        reasonCounts,
        sourceCounts,
      };
    },
    /** Destination-safe summary reporting counts and reason categories only (never message text). */
    summary(
      resolveDestination?: (source: string, entry: DeadLetterEntry) => string | undefined,
    ): DeadLetterStatusSummary {
      return summarizeDeadLetters(entries, stats, resolveDestination);
    },
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
