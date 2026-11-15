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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
}

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;
export const DEAD_LETTER_CHECKPOINT_VERSION = 1 as const;
export const DEAD_LETTER_MAX_CHECKPOINT_IDS = 500;

export interface DeadLetterRecoveryCheckpoint {
  version: typeof DEAD_LETTER_CHECKPOINT_VERSION;
  updatedAt: string;
  selectedIds: string[];
  acknowledgedIds: string[];
  lastProcessedId: string | null;
  interrupted: boolean;
}

export interface RecoverDeadLettersOptions {
  /** Optional explicit entry IDs to recover (defaults to resumed selection or current queue IDs). */
  ids?: readonly string[];
  /** Checkpoint file path; defaults to `${filePath}.recovery.json` when `filePath` is set. */
  checkpointFile?: string | null;
  /** Maximum entry IDs retained in checkpoint arrays (defaults to 500). */
  maxCheckpointIds?: number;
  /** Resume from an existing checkpoint file when present (defaults to true). */
  resume?: boolean;
  /** Maximum sends in a single pass before pausing recovery (defaults to maxEntries). */
  budget?: number;
  /** Cooperative interruption check evaluated before each entry. */
  shouldStop?: () => boolean;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Transport callback invoked for each selected, unacknowledged entry. */
  send: (text: string, entry: DeadLetterEntry) => Promise<void>;
}

export interface RecoverDeadLettersResult {
  resumed: boolean;
  interrupted: boolean;
  acknowledged: number;
  failed: number;
  skippedAcknowledged: number;
  remainingSelected: number;
  remainingQueue: number;
  acknowledgedIds: string[];
  pendingSelectedIds: string[];
  checkpointFile: string | null;
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

function boundIdList(ids: readonly unknown[], maxIds: number): string[] {
  const limit = Math.max(1, maxIds);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 256 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  if (unique.length <= limit) return unique;
  return unique.slice(unique.length - limit);
}

/** Resolve the default recovery checkpoint path for a dead-letter file. */
export function defaultRecoveryCheckpointPath(filePath: string | null): string | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  return `${filePath}.recovery.json`;
}

/** Load and validate a bounded recovery checkpoint from disk, returning null if absent or invalid. */
export async function loadRecoveryCheckpoint(
  checkpointFile: string | null,
  maxCheckpointIds = DEAD_LETTER_MAX_CHECKPOINT_IDS,
): Promise<DeadLetterRecoveryCheckpoint | null> {
  if (checkpointFile === null || checkpointFile.trim() === "") return null;
  let raw: string;
  try {
    raw = await readFile(checkpointFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeadLetterRecoveryCheckpoint>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== DEAD_LETTER_CHECKPOINT_VERSION ||
      !Array.isArray(parsed.selectedIds) ||
      !Array.isArray(parsed.acknowledgedIds)
    ) {
      return null;
    }
    return {
      version: DEAD_LETTER_CHECKPOINT_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      selectedIds: boundIdList(parsed.selectedIds, maxCheckpointIds),
      acknowledgedIds: boundIdList(parsed.acknowledgedIds, maxCheckpointIds),
      lastProcessedId:
        typeof parsed.lastProcessedId === "string" && parsed.lastProcessedId.length <= 256
          ? parsed.lastProcessedId
          : null,
      interrupted: parsed.interrupted === true,
    };
  } catch {
    return null;
  }
}

/** Atomically write a bounded recovery checkpoint via write-then-rename. */
export async function saveRecoveryCheckpoint(
  checkpointFile: string | null,
  checkpoint: DeadLetterRecoveryCheckpoint,
  maxCheckpointIds = DEAD_LETTER_MAX_CHECKPOINT_IDS,
): Promise<void> {
  if (checkpointFile === null || checkpointFile.trim() === "") return;
  const bounded: DeadLetterRecoveryCheckpoint = {
    version: DEAD_LETTER_CHECKPOINT_VERSION,
    updatedAt: checkpoint.updatedAt,
    selectedIds: boundIdList(checkpoint.selectedIds, maxCheckpointIds),
    acknowledgedIds: boundIdList(checkpoint.acknowledgedIds, maxCheckpointIds),
    lastProcessedId:
      typeof checkpoint.lastProcessedId === "string"
        ? checkpoint.lastProcessedId.slice(0, 256)
        : null,
    interrupted: checkpoint.interrupted,
  };
  await mkdir(path.dirname(checkpointFile), { recursive: true });
  const tmp = `${checkpointFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
  await rename(tmp, checkpointFile);
}

/** Delete a completed recovery checkpoint if present. */
export async function clearRecoveryCheckpoint(checkpointFile: string | null): Promise<void> {
  if (checkpointFile === null || checkpointFile.trim() === "") return;
  await rm(checkpointFile, { force: true }).catch(() => {});
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

  /**
   * Interruptible, resumable recovery over a bounded selection of dead-letter IDs.
   * Persists acknowledged IDs in a bounded checkpoint so interrupted runs resume
   * cleanly without reprocessing entries that already succeeded.
   */
  async function recoverSelection(
    recoverOptions: RecoverDeadLettersOptions,
  ): Promise<RecoverDeadLettersResult> {
    const maxCheckpointIds = Math.max(
      1,
      recoverOptions.maxCheckpointIds ?? DEAD_LETTER_MAX_CHECKPOINT_IDS,
    );
    const checkpointFile =
      recoverOptions.checkpointFile !== undefined
        ? recoverOptions.checkpointFile
        : defaultRecoveryCheckpointPath(filePath);
    const existingCheckpoint =
      recoverOptions.resume !== false
        ? await loadRecoveryCheckpoint(checkpointFile, maxCheckpointIds)
        : null;
    const resumed = existingCheckpoint !== null;

    const selectedIds =
      recoverOptions.ids !== undefined
        ? boundIdList(recoverOptions.ids, maxCheckpointIds)
        : existingCheckpoint
          ? existingCheckpoint.selectedIds
          : boundIdList(
              entries.map((e) => e.id),
              maxCheckpointIds,
            );
    const selectedSet = new Set(selectedIds);
    const acknowledgedList = existingCheckpoint ? [...existingCheckpoint.acknowledgedIds] : [];
    const acknowledgedSet = new Set(acknowledgedList);

    const budget =
      recoverOptions.budget !== undefined
        ? Math.max(0, recoverOptions.budget)
        : Math.max(1, options.maxEntries);

    let acknowledgedThisRun = 0;
    let failedThisRun = 0;
    let skippedAcknowledged = 0;
    let interrupted = false;
    let lastProcessedId = existingCheckpoint?.lastProcessedId ?? null;

    const isStopped = (): boolean =>
      Boolean(recoverOptions.signal?.aborted) || Boolean(recoverOptions.shouldStop?.());

    const persistCheckpointState = async (isInterrupted: boolean): Promise<void> => {
      try {
        await saveRecoveryCheckpoint(
          checkpointFile,
          {
            version: DEAD_LETTER_CHECKPOINT_VERSION,
            updatedAt: new Date(now()).toISOString(),
            selectedIds,
            acknowledgedIds: boundIdList(acknowledgedList, maxCheckpointIds),
            lastProcessedId,
            interrupted: isInterrupted,
          },
          maxCheckpointIds,
        );
      } catch (err) {
        console.error(`[dead-letter] could not persist recovery checkpoint: ${safeError(err)}`);
      }
    };

    const kept: DeadLetterEntry[] = [];

    for (let idx = 0; idx < entries.length; idx += 1) {
      const entry = entries[idx]!;
      if (!selectedSet.has(entry.id)) {
        kept.push(entry);
        continue;
      }

      if (acknowledgedSet.has(entry.id)) {
        skippedAcknowledged += 1;
        continue;
      }

      if (interrupted || isStopped() || acknowledgedThisRun >= budget) {
        interrupted = true;
        kept.push(entry);
        continue;
      }

      try {
        await recoverOptions.send(entry.text, entry);
        acknowledgedThisRun += 1;
        stats.replayed += 1;
        acknowledgedSet.add(entry.id);
        acknowledgedList.push(entry.id);
        lastProcessedId = entry.id;
        await persistCheckpointState(false);
      } catch (err) {
        failedThisRun += 1;
        lastProcessedId = entry.id;
        entry.attempts += 1;
        entry.lastError = safeError(err);
        if (entry.attempts >= options.maxAttempts) {
          stats.dropped += 1;
        } else {
          kept.push(entry);
        }
        if (isStopped()) {
          interrupted = true;
        }
      }
    }

    entries = kept;
    syncDepth();
    await persist();

    const remainingIdsInQueue = new Set(entries.map((e) => e.id));
    const pendingSelectedIds = selectedIds.filter(
      (id) => remainingIdsInQueue.has(id) && !acknowledgedSet.has(id),
    );

    if (pendingSelectedIds.length > 0 || interrupted) {
      await persistCheckpointState(interrupted);
    } else {
      await clearRecoveryCheckpoint(checkpointFile);
    }

    return {
      resumed,
      interrupted,
      acknowledged: acknowledgedThisRun,
      failed: failedThisRun,
      skippedAcknowledged,
      remainingSelected: pendingSelectedIds.length,
      remainingQueue: entries.length,
      acknowledgedIds: boundIdList(acknowledgedList, maxCheckpointIds),
      pendingSelectedIds,
      checkpointFile,
    };
  }

  return {
    load,
    enqueue,
    flush,
    recoverSelection,
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
