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

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;
export const DEAD_LETTER_DEFAULT_REPLAY_BUDGET = 20;

export type DeadLetterReplayReason =
  | "eligible"
  | "deferred_zero_budget"
  | "deferred_over_budget"
  | "max_attempts_exhausted"
  | "empty_message_body"
  | "filtered_source";

export interface DeadLetterReplayPlanItem {
  id: string;
  source: string;
  destination: string;
  ledger: number;
  eventName: string;
  enqueuedAt: string;
  attempts: number;
  selected: boolean;
  reason: DeadLetterReplayReason;
}

export interface DeadLetterDestinationReplayGroup {
  destination: string;
  sources: string[];
  totalCount: number;
  selectedCount: number;
  excludedCount: number;
  reasonCounts: Partial<Record<DeadLetterReplayReason, number>>;
  items: DeadLetterReplayPlanItem[];
}

export interface DeadLetterReplayPlanOptions {
  /** Maximum entries selected for replay in this cycle (default {@link DEAD_LETTER_DEFAULT_REPLAY_BUDGET}). */
  budget?: number;
  /** Optional source filter (e.g. `"market"` or `"squad"`). */
  source?: string;
  /** Maps an entry to its destination route label (defaults to `entry.source`). */
  resolveDestination?: (entry: DeadLetterEntry) => string;
}

export interface DeadLetterReplayPlan {
  dryRun: true;
  budget: number;
  maxAttempts: number;
  totalEntries: number;
  selectedCount: number;
  excludedCount: number;
  reasonCounts: Partial<Record<DeadLetterReplayReason, number>>;
  destinations: DeadLetterDestinationReplayGroup[];
}

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
 * Compute a side-effect-free, dry-run replay plan grouped by destination route.
 * Performs no network I/O and mutates neither the input entries nor disk state.
 */
export function buildDeadLetterReplayPlan(
  entries: readonly DeadLetterEntry[],
  options: DeadLetterReplayPlanOptions & { maxAttempts?: number } = {},
): DeadLetterReplayPlan {
  const budget = Math.max(0, Math.trunc(options.budget ?? DEAD_LETTER_DEFAULT_REPLAY_BUDGET));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEAD_LETTER_MAX_ATTEMPTS));
  const sourceFilter = options.source?.trim();
  const resolveDestination =
    options.resolveDestination ??
    ((entry: DeadLetterEntry) => {
      const candidate = (entry as DeadLetterEntry & { chatId?: string }).chatId;
      return typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : entry.source;
    });

  let selectedCount = 0;
  const reasonCounts: Partial<Record<DeadLetterReplayReason, number>> = {};
  const groupMap = new Map<string, DeadLetterDestinationReplayGroup>();

  for (const entry of entries) {
    let selected = false;
    let reason: DeadLetterReplayReason;

    if (sourceFilter && entry.source !== sourceFilter) {
      reason = "filtered_source";
    } else if (entry.text.trim().length === 0) {
      reason = "empty_message_body";
    } else if (entry.attempts >= maxAttempts) {
      reason = "max_attempts_exhausted";
    } else if (budget <= 0) {
      reason = "deferred_zero_budget";
    } else if (selectedCount >= budget) {
      reason = "deferred_over_budget";
    } else {
      selected = true;
      reason = "eligible";
      selectedCount += 1;
    }

    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;

    const destination = resolveDestination(entry);
    let group = groupMap.get(destination);
    if (!group) {
      group = {
        destination,
        sources: [],
        totalCount: 0,
        selectedCount: 0,
        excludedCount: 0,
        reasonCounts: {},
        items: [],
      };
      groupMap.set(destination, group);
    }

    if (!group.sources.includes(entry.source)) {
      group.sources.push(entry.source);
    }
    group.totalCount += 1;
    if (selected) {
      group.selectedCount += 1;
    } else {
      group.excludedCount += 1;
    }
    group.reasonCounts[reason] = (group.reasonCounts[reason] ?? 0) + 1;
    group.items.push({
      id: entry.id,
      source: entry.source,
      destination,
      ledger: entry.ledger,
      eventName: entry.eventName,
      enqueuedAt: entry.enqueuedAt,
      attempts: entry.attempts,
      selected,
      reason,
    });
  }

  return {
    dryRun: true,
    budget,
    maxAttempts,
    totalEntries: entries.length,
    selectedCount,
    excludedCount: entries.length - selectedCount,
    reasonCounts,
    destinations: [...groupMap.values()],
  };
}

export function createDeadLetterQueue(options: DeadLetterQueueOptions) {
  const now = options.now ?? Date.now;
  const filePath = options.filePath;
  const quiet = options.quiet === true;
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
    if (entries.length > 0 && !quiet) {
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

  function planReplay(planOptions: DeadLetterReplayPlanOptions = {}): DeadLetterReplayPlan {
    return buildDeadLetterReplayPlan(entries, {
      ...planOptions,
      maxAttempts: options.maxAttempts,
    });
  }

  return {
    load,
    enqueue,
    flush,
    planReplay,
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
