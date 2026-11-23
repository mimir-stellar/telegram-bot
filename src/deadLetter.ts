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
  enqueuedAt: string;
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

export type DeadLetterReasonCategory =
  | "rate_limited"
  | "auth_error"
  | "bad_request"
  | "timeout"
  | "network"
  | "server_error"
  | "unknown";

export interface DeadLetterStatusSummary {
  depth: number;
  bySource: Record<string, number>;
  byReason: Record<string, number>;
  oldestEnqueuedAt: string | null;
  newestEnqueuedAt: string | null;
  maxAttemptsSeen: number;
}

/**
 * Map a persisted error string to a stable, destination-safe reason category
 * so operator status never leaks raw error payloads or chat identifiers.
 */
export function classifyDeadLetterReason(
  lastError: string | null | undefined,
): DeadLetterReasonCategory {
  if (!lastError || lastError.trim().length === 0) return "unknown";
  const lower = lastError.toLowerCase();
  if (/\b429\b|too many requests|retry after|rate[- ]limit/.test(lower)) {
    return "rate_limited";
  }
  if (/\b40[13]\b|unauthorized|forbidden|blocked|kicked/.test(lower)) {
    return "auth_error";
  }
  if (/\b40[04]\b|bad request|chat not found|can't parse|markdown|entity/.test(lower)) {
    return "bad_request";
  }
  if (/timed? ?out|etimedout|esockettimedout|aborterror|\b408\b/.test(lower)) {
    return "timeout";
  }
  if (/econnrefused|econnreset|enotfound|ehostunreach|eai_again|fetch failed|network|socket/.test(lower)) {
    return "network";
  }
  if (/\b50[0234]\b|internal server error|bad gateway|service unavailable/.test(lower)) {
    return "server_error";
  }
  return "unknown";
}

/**
 * Build a destination-safe summary of dead-letter entries containing counts
 * and reason categories only (never raw message text or destination ids).
 */
export function summarizeDeadLetters(
  entries: readonly DeadLetterEntry[],
): DeadLetterStatusSummary {
  const bySource: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let oldestEnqueuedAt: string | null = null;
  let newestEnqueuedAt: string | null = null;
  let maxAttemptsSeen = 0;

  for (const entry of entries) {
    const source = entry.source || "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const reason = classifyDeadLetterReason(entry.lastError);
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    if (entry.attempts > maxAttemptsSeen) {
      maxAttemptsSeen = entry.attempts;
    }
    if (typeof entry.enqueuedAt === "string" && entry.enqueuedAt.length > 0) {
      if (oldestEnqueuedAt === null || entry.enqueuedAt < oldestEnqueuedAt) {
        oldestEnqueuedAt = entry.enqueuedAt;
      }
      if (newestEnqueuedAt === null || entry.enqueuedAt > newestEnqueuedAt) {
        newestEnqueuedAt = entry.enqueuedAt;
      }
    }
  }

  return {
    depth: entries.length,
    bySource,
    byReason,
    oldestEnqueuedAt,
    newestEnqueuedAt,
    maxAttemptsSeen,
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
  /** Active Stellar network passphrase; replay rejects entries from another network. */
  networkPassphrase?: string;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;
export const DEAD_LETTER_CHECKPOINT_VERSION = 1;
export const DEAD_LETTER_CHECKPOINT_MAX_IDS = 500;

export interface DeadLetterRecoveryCheckpoint {
  version: 1;
  updatedAt: string;
  acknowledgedIds: string[];
  source?: string;
  completed: boolean;
}

export interface RecoverSelectionOptions {
  checkpointFile?: string;
  source?: string;
  budget?: number;
  maxAcknowledgedIds?: number;
  resetCheckpoint?: boolean;
  signal?: AbortSignal;
}

export interface RecoverSelectionResult {
  sent: number;
  skippedAcknowledged: number;
  remaining: number;
  interrupted: boolean;
  completed: boolean;
  acknowledgedCount: number;
}

function boundAcknowledgedIds(ids: readonly string[], maxIds: number): string[] {
  const cap = Math.max(1, maxIds);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  if (deduped.length <= cap) return deduped;
  return deduped.slice(deduped.length - cap);
}

/**
 * Load a persisted dead-letter recovery checkpoint, returning `null` if absent
 * or malformed. Enforces the bounded ID ceiling on load.
 */
export async function loadRecoveryCheckpoint(
  checkpointFile: string,
  maxIds: number = DEAD_LETTER_CHECKPOINT_MAX_IDS,
): Promise<DeadLetterRecoveryCheckpoint | null> {
  let raw: string;
  try {
    raw = await readFile(checkpointFile, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DeadLetterRecoveryCheckpoint>;
    if (parsed.version !== DEAD_LETTER_CHECKPOINT_VERSION || !Array.isArray(parsed.acknowledgedIds)) {
      return null;
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      acknowledgedIds: boundAcknowledgedIds(parsed.acknowledgedIds, maxIds),
      ...(typeof parsed.source === "string" && parsed.source.length > 0
        ? { source: parsed.source }
        : {}),
      completed: parsed.completed === true,
    };
  } catch {
    return null;
  }
}

/** Atomically persist a bounded dead-letter recovery checkpoint. */
export async function saveRecoveryCheckpoint(
  checkpointFile: string,
  checkpoint: DeadLetterRecoveryCheckpoint,
  maxIds: number = DEAD_LETTER_CHECKPOINT_MAX_IDS,
): Promise<void> {
  const bounded: DeadLetterRecoveryCheckpoint = {
    version: 1,
    updatedAt: checkpoint.updatedAt,
    acknowledgedIds: boundAcknowledgedIds(checkpoint.acknowledgedIds, maxIds),
    ...(checkpoint.source ? { source: checkpoint.source } : {}),
    completed: checkpoint.completed,
  };
  await mkdir(path.dirname(checkpointFile), { recursive: true });
  const tmp = `${checkpointFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
  await rename(tmp, checkpointFile);
}

/** Remove a dead-letter recovery checkpoint file if present. */
export async function clearRecoveryCheckpoint(checkpointFile: string): Promise<void> {
  await unlink(checkpointFile).catch(() => undefined);
}

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

  async function load(loadOptions: DeadLetterLoadOptions = {}): Promise<void> {
    const strict = loadOptions.strict === true;
    const quiet = loadOptions.quiet === true;
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
        const rawEntries = (parsed as DeadLetterFile).entries;
        const validEntry = (e: unknown): e is DeadLetterEntry =>
          Boolean(
            e &&
              typeof e === "object" &&
              !Array.isArray(e) &&
              typeof (e as DeadLetterEntry).id === "string" &&
              typeof (e as DeadLetterEntry).text === "string" &&
              typeof (e as DeadLetterEntry).ledger === "number",
          );
        if (strict && rawEntries.some((e) => !validEntry(e))) {
          throw new DeadLetterMalformedError(
            `malformed dead-letter entry in ${filePath}: expected id, text, and ledger`,
          );
        }
        entries = rawEntries
          .filter(validEntry)
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
            ...(typeof e.networkPassphrase === "string" && e.networkPassphrase.trim() !== ""
              ? { networkPassphrase: e.networkPassphrase }
              : {}),
          }));
        // Bound on load too: the file may have been edited by hand.
        while (entries.length > options.maxEntries) {
          entries.shift();
          stats.dropped += 1;
        }
      }
    } catch (err) {
      if (strict) {
        if (err instanceof DeadLetterMalformedError) throw err;
        throw new DeadLetterMalformedError(
          `malformed dead-letter file at ${filePath}: ${safeError(err)}`,
          { cause: err },
        );
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

  return {
    load,
    enqueue,
    flush,
    recoverSelection,
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
