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
}

export interface DeadLetterAckResult {
  acknowledged: DeadLetterEntry[];
  acknowledgedIds: string[];
  unmatchedIds: string[];
  remaining: number;
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
export const DEAD_LETTER_MAX_ACK_IDS = 100;

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
  let entries: DeadLetterEntry[] = [];
  let sourcePreserved = false;
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

        // Reject conflicting duplicate IDs before trimming to maxEntries so an
        // older duplicate is never silently discarded, and preserve the source
        // file for inspection rather than overwriting it.
        const duplicateIds = findDuplicateEntryIds(candidateEntries);
        if (duplicateIds.length > 0) {
          entries = [];
          sourcePreserved = true;
          syncDepth();
          const err = new DeadLetterDuplicateIdError(filePath, duplicateIds);
          if (options.strict) {
            throw err;
          }
          console.warn(`[dead-letter] ${safeError(err)}; starting empty`);
          return;
        }

        entries = candidateEntries;
        // Bound on load too: the file may have been edited by hand.
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
   * Interruptible, resumable recovery over a filtered selection of entries.
   * Persists a bounded checkpoint of acknowledged IDs so a resumed run skips
   * entries that were already acknowledged before interruption.
   */
  async function recoverSelection(
    send: (text: string, entry: DeadLetterEntry) => Promise<void>,
    recoverOptions: RecoverSelectionOptions = {},
  ): Promise<RecoverSelectionResult> {
    const maxAckIds = recoverOptions.maxAcknowledgedIds ?? DEAD_LETTER_CHECKPOINT_MAX_IDS;
    const checkpointFile = recoverOptions.checkpointFile;

    if (checkpointFile && recoverOptions.resetCheckpoint) {
      await clearRecoveryCheckpoint(checkpointFile);
    }

    const existingCheckpoint = checkpointFile
      ? await loadRecoveryCheckpoint(checkpointFile, maxAckIds)
      : null;
    const acknowledgedIds = existingCheckpoint ? [...existingCheckpoint.acknowledgedIds] : [];
    const acknowledgedSet = new Set(acknowledgedIds);

    const budget = recoverOptions.budget ?? entries.length;
    let sent = 0;
    let skippedAcknowledged = 0;
    let interrupted = false;
    const kept: DeadLetterEntry[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (acknowledgedSet.has(entry.id)) {
        skippedAcknowledged += 1;
        continue;
      }
      if (recoverOptions.source && entry.source !== recoverOptions.source) {
        kept.push(entry);
        continue;
      }
      if (recoverOptions.signal?.aborted || sent >= budget) {
        interrupted = true;
        kept.push(...entries.slice(index));
        break;
      }

      try {
        await send(entry.text, entry);
        sent += 1;
        stats.replayed += 1;
        if (!acknowledgedSet.has(entry.id)) {
          acknowledgedSet.add(entry.id);
          acknowledgedIds.push(entry.id);
        }
        if (checkpointFile) {
          await saveRecoveryCheckpoint(
            checkpointFile,
            {
              version: 1,
              updatedAt: new Date(now()).toISOString(),
              acknowledgedIds,
              source: recoverOptions.source,
              completed: false,
            },
            maxAckIds,
          );
        }
      } catch (err) {
        entry.attempts += 1;
        entry.lastError = safeError(err);
        if (entry.attempts >= options.maxAttempts) {
          stats.dropped += 1;
        } else {
          kept.push(entry);
        }
      }
    }

    entries = kept;
    syncDepth();
    await persist();

    const remainingSelected = entries.filter(
      (e) =>
        !acknowledgedSet.has(e.id) &&
        (!recoverOptions.source || e.source === recoverOptions.source),
    ).length;
    const completed = !interrupted && remainingSelected === 0;

    if (checkpointFile) {
      await saveRecoveryCheckpoint(
        checkpointFile,
        {
          version: 1,
          updatedAt: new Date(now()).toISOString(),
          acknowledgedIds,
          source: recoverOptions.source,
          completed,
        },
        maxAckIds,
      );
    }

    return {
      sent,
      skippedAcknowledged,
      remaining: entries.length,
      interrupted,
      completed,
      acknowledgedCount: boundAcknowledgedIds(acknowledgedIds, maxAckIds).length,
    };
  }

  /**
   * Atomically acknowledge (remove) an explicit, bounded list of inspected
   * dead-letter entry IDs. Unmatched IDs are reported and all non-matching
   * queued entries are preserved untouched in their original order.
   */
  async function acknowledge(ids: readonly string[]): Promise<DeadLetterAckResult> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new RangeError("acknowledge requires at least one entry id");
    }
    if (ids.length > DEAD_LETTER_MAX_ACK_IDS) {
      throw new RangeError(
        `acknowledge accepts at most ${DEAD_LETTER_MAX_ACK_IDS} entry ids (received ${ids.length})`,
      );
    }

    const normalizedIds: string[] = [];
    const requestedSet = new Set<string>();
    for (const rawId of ids) {
      if (typeof rawId !== "string" || rawId.trim() === "") {
        throw new RangeError("acknowledge entry ids must be non-empty strings");
      }
      const id = rawId.trim();
      if (!requestedSet.has(id)) {
        requestedSet.add(id);
        normalizedIds.push(id);
      }
    }

    const acknowledged: DeadLetterEntry[] = [];
    const kept: DeadLetterEntry[] = [];
    const matchedSet = new Set<string>();

    for (const entry of entries) {
      if (requestedSet.has(entry.id)) {
        acknowledged.push(entry);
        matchedSet.add(entry.id);
      } else {
        kept.push(entry);
      }
    }

    const unmatchedIds = normalizedIds.filter((id) => !matchedSet.has(id));

    if (acknowledged.length > 0) {
      entries = kept;
      syncDepth();
      await persist();
      console.log(
        `[dead-letter] acknowledged ${acknowledged.length} entry(s) ` +
          `(${unmatchedIds.length} unmatched, ${entries.length} remaining)`,
      );
    }

    return {
      acknowledged: acknowledged.map((e) => ({ ...e })),
      acknowledgedIds: acknowledged.map((e) => e.id),
      unmatchedIds,
      remaining: entries.length,
    };
  }

  return {
    load,
    enqueue,
    flush,
    acknowledge,
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
