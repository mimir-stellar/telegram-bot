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

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeErrorMessage } from "./notifications/format.js";

export interface DeadLetterEntry {
  /** Stable id within the queue (source + ledger + event + short text hash). */
  id: string;
  /** ISO 8601 timestamp of the original failure, or `null` for legacy entries missing one. */
  enqueuedAt: string | null;
  source: string;
  ledger: number;
  eventName: string;
  /** Already-formatted MarkdownV2 message body, truncated to {@link TEXT_TRUNCATE}. */
  text: string;
  attempts: number;
  lastError: string | null;
  /** Stellar network passphrase where the failure originated, if recorded. */
  networkPassphrase?: string;
}

export interface DeadLetterAgeSummary {
  oldestEnqueuedAt: string | null;
  ageMs: number | null;
  missingTimestamps: number;
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
  expired: number;
}

export interface DeadLetterAckResult {
  acknowledged: DeadLetterEntry[];
  acknowledgedIds: string[];
  unmatchedIds: string[];
  remaining: number;
}

/**
 * Bounded, content-free utilization report for the queue. Carries only counts
 * and capacity — never message bodies, error text, or identifiers — so it is
 * safe to expose on a gauge or a status endpoint.
 *
 * When the queue is disabled (`maxEntries` below 1) `enabled` is `false`,
 * `maxEntries` is `0`, and `utilization` is `0`: a disabled queue has no
 * capacity to be utilized, and reporting `0` keeps the gauge bounded in
 * `[0, 1]` rather than dividing by zero or emitting `NaN`.
 */
export interface DeadLetterCapacity {
  enabled: boolean;
  used: number;
  maxEntries: number;
  /** `used / maxEntries`, clamped to `[0, 1]`; `0` when disabled. */
  utilization: number;
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
   * Maximum retention age in milliseconds (`null` disables age expiry).
   * Defaults to {@link DEAD_LETTER_MAX_AGE_MS}.
   */
  maxAgeMs?: number | null;
  /**
   * Config secrets to scrub from a recorded error, passed straight to
   * `safeErrorMessage`. The poller hands over its bot token: a Telegram failure
   * routinely embeds the token in the request URL, and main's shape rule
   * deliberately does not match a token that follows the literal `bot` prefix in
   * a URL, so the value itself is what makes that case safe.
   */
  secrets?: readonly string[];
  /** Active Stellar network passphrase; replay rejects entries from another network. */
  networkPassphrase?: string;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /**
   * When `true`, validation errors during `load()` (such as duplicate entry
   * IDs) throw instead of logging a warning and starting empty. The source
   * file is always preserved untouched in either mode.
   */
  strict?: boolean;
}

export class DeadLetterDuplicateIdError extends Error {
  readonly filePath: string | null;
  readonly duplicateIds: string[];

  constructor(filePath: string | null, duplicateIds: readonly string[]) {
    const location = filePath ? ` in ${filePath}` : "";
    super(
      `duplicate dead-letter entry id(s)${location}: ${duplicateIds.join(", ")}; ` +
        `source file preserved for inspection`,
    );
    this.name = "DeadLetterDuplicateIdError";
    this.filePath = filePath;
    this.duplicateIds = [...duplicateIds];
  }
}

/**
 * Return any duplicate entry IDs in first-seen conflict order.
 * An empty array means all entry IDs are unique.
 */
export function findDuplicateEntryIds(
  entries: readonly Pick<DeadLetterEntry, "id">[],
): string[] {
  const seen = new Set<string>();
  const recorded = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      if (!recorded.has(entry.id)) {
        recorded.add(entry.id);
        duplicates.push(entry.id);
      }
    } else {
      seen.add(entry.id);
    }
  }
  return duplicates;
}

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;
export const DEAD_LETTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export class DeadLetterMalformedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeadLetterMalformedError";
  }
}

export class DeadLetterAccessError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeadLetterAccessError";
    this.code = code;
  }
}

export interface DeadLetterLoadOptions {
  /**
   * When true, surface malformed files and non-ENOENT access errors instead of
   * falling back to an empty queue. Used by the offline inspection CLI.
   */
  strict?: boolean;
  /** Suppress informational `loaded ...` stdout logging (keeps CLI stdout machine-readable). */
  quiet?: boolean;
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
 * Parse an entry's original failed-at timestamp (`enqueuedAt`), returning `null`
 * for missing or invalid legacy timestamps instead of falling back to `now` or file mtime.
 */
export function parseEntryTimestampMs(enqueuedAt: unknown): number | null {
  if (typeof enqueuedAt !== "string" || enqueuedAt.trim() === "") {
    return null;
  }
  const ms = Date.parse(enqueuedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compute the dead-letter queue age from the oldest retained failure's original
 * `enqueuedAt` timestamp, counting entries whose legacy timestamp is missing or invalid.
 */
export function summarizeDeadLetterAge(
  entries: readonly Pick<DeadLetterEntry, "enqueuedAt">[],
  nowMs: number = Date.now(),
): DeadLetterAgeSummary {
  let oldestMs: number | null = null;
  let oldestEnqueuedAt: string | null = null;
  let missingTimestamps = 0;

  for (const entry of entries) {
    const ms = parseEntryTimestampMs(entry.enqueuedAt);
    if (ms === null) {
      missingTimestamps += 1;
      continue;
    }
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms;
      oldestEnqueuedAt = entry.enqueuedAt;
    }
  }

  return {
    oldestEnqueuedAt,
    ageMs: oldestMs === null ? null : Math.max(0, nowMs - oldestMs),
    missingTimestamps,
  };
}

export function createDeadLetterQueue(options: DeadLetterQueueOptions) {
  const now = options.now ?? Date.now;
  const filePath = options.filePath;
  const maxAgeMs =
    options.maxAgeMs === null
      ? null
      : options.maxAgeMs !== undefined
        ? Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
          ? options.maxAgeMs
          : null
        : DEAD_LETTER_MAX_AGE_MS;
  let entries: DeadLetterEntry[] = [];
  let sourcePreserved = false;
  const stats: DeadLetterStats = {
    depth: 0,
    enqueued: 0,
    replayed: 0,
    dropped: 0,
    expired: 0,
  };

  /** Redacted, truncated error text — the only form that may be persisted. */
  function safeError(err: unknown): string {
    return truncate(safeErrorMessage(err, options.secrets ?? []), ERROR_TRUNCATE);
  }

  function syncDepth(): void {
    stats.depth = entries.length;
  }

  async function load(): Promise<void> {
    sourcePreserved = false;
    if (filePath === null) {
      entries = [];
      syncDepth();
      return;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (strict && code !== "ENOENT") {
        throw new DeadLetterAccessError(
          `cannot read dead-letter file ${filePath}: ${safeError(err)}`,
          code,
          { cause: err },
        );
      }
      // No file yet is the normal first-run case, not a problem to report.
      entries = [];
      syncDepth();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as DeadLetterFile).version !== 1 ||
        !Array.isArray((parsed as DeadLetterFile).entries)
      ) {
        if (strict) {
          throw new DeadLetterMalformedError(
            `malformed dead-letter file at ${filePath}: expected version 1 with entries array`,
          );
        }
        console.warn(
          `[dead-letter] unknown or corrupt queue at ${filePath}; starting empty`,
        );
        entries = [];
      } else {
        const candidateEntries = parsed.entries
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
              parseEntryTimestampMs(e.enqueuedAt) !== null ? (e.enqueuedAt as string) : null,
            source: typeof e.source === "string" ? e.source : "unknown",
            ledger: e.ledger,
            eventName: typeof e.eventName === "string" ? e.eventName : "unknown",
            text: truncate(e.text, TEXT_TRUNCATE),
            attempts: typeof e.attempts === "number" && e.attempts >= 0 ? e.attempts : 0,
            lastError: typeof e.lastError === "string" ? truncate(e.lastError, ERROR_TRUNCATE) : null,
            ...(typeof e.networkPassphrase === "string" && e.networkPassphrase.trim() !== ""
              ? { networkPassphrase: e.networkPassphrase }
              : {}),
          }));
        // Bound by age first so expired entries do not count against capacity,
        // then bound by entry count.
        pruneExpired();
        while (entries.length > options.maxEntries) {
          entries.shift();
          stats.dropped += 1;
        }
      }
    } catch (err) {
      if (err instanceof DeadLetterDuplicateIdError) {
        throw err;
      }
      console.warn(
        `[dead-letter] unreadable queue at ${filePath}, starting empty: ${safeError(err)}`,
      );
      entries = [];
    }
    syncDepth();
    if (!quiet && entries.length > 0) {
      console.log(`[dead-letter] loaded ${entries.length} parked send(s) from ${filePath}`);
    }
  }

  async function persist(): Promise<void> {
    if (filePath === null) {
      syncDepth();
      return;
    }
    if (sourcePreserved) {
      console.warn(
        `[dead-letter] refusing to overwrite ${filePath} while duplicate-id conflict is unresolved`,
      );
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
    // Evict expired entries before checking deduplication or capacity so
    // newly failed entries are always preserved.
    pruneExpired();

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
      ...(typeof options.networkPassphrase === "string" && options.networkPassphrase.trim() !== ""
        ? { networkPassphrase: options.networkPassphrase }
        : {}),
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
  ): Promise<{ sent: number; remaining: number; rejectedNetworkMismatch: number }> {
    if (budget <= 0 || entries.length === 0) {
      return { sent: 0, remaining: entries.length, rejectedNetworkMismatch: 0 };
    }

    const configuredNetwork =
      typeof options.networkPassphrase === "string" && options.networkPassphrase.trim() !== ""
        ? options.networkPassphrase
        : null;

    let sent = 0;
    let rejectedNetworkMismatch = 0;
    const kept: DeadLetterEntry[] = [];

    for (const entry of entries) {
      if (sent >= budget) {
        kept.push(entry);
        continue;
      }

      if (
        configuredNetwork !== null &&
        typeof entry.networkPassphrase === "string" &&
        entry.networkPassphrase.trim() !== "" &&
        entry.networkPassphrase !== configuredNetwork
      ) {
        rejectedNetworkMismatch += 1;
        kept.push(entry);
        console.warn(
          `[dead-letter] rejected replay for ${entry.source} ${entry.eventName} ` +
            `@ ledger ${entry.ledger}: entry network does not match current configuration`,
        );
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
    return { sent, remaining: entries.length, rejectedNetworkMismatch };
  }

  /**
   * Content-free capacity snapshot. A queue is considered disabled when it has
   * no capacity (`maxEntries` below 1) — the same condition under which
   * `enqueue` would otherwise evict on every insert. Disabled reports
   * `enabled: false`, `maxEntries: 0`, `utilization: 0`.
   */
  function capacity(): DeadLetterCapacity {
    const enabled = options.maxEntries >= 1;
    if (!enabled) {
      return { enabled: false, used: 0, maxEntries: 0, utilization: 0 };
    }
    const used = entries.length;
    const utilization = Math.min(1, Math.max(0, used / options.maxEntries));
    return { enabled: true, used, maxEntries: options.maxEntries, utilization };
  }

  return {
    load,
    enqueue,
    flush,
    capacity,
    stats(): DeadLetterStats {
      return { ...stats, depth: entries.length };
    },
    summary(): DeadLetterStatusSummary {
      return summarizeDeadLetters(entries);
    },
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
