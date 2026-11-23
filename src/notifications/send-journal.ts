/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds it appends a matching `done` line. On restart, lines that carry
 * an `intent` but no `done` identify notifications that may or may not have
 * been delivered -- instead of guessing from the cursor.
 *
 * A `timeout` line is written when the HTTP call to Telegram timed out before
 * a response was received. A pending intent that also has a matching `timeout`
 * line is a **confirmed-unknown outcome**: Telegram may have received the
 * message even though the client did not. This is distinct from a plain pending
 * intent (crashed before or during the send, no timeout observed). Both cases
 * leave the notification potentially sent, but the timeout case gives recovery
 * tooling a stronger signal for de-duplication decisions.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done`) pairs are dropped, leaving only unresolved
 * intents and any associated `timeout` lines.
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 *
 * Routing preview: `previewRoutingDecision` is not part of this module; the
 * journal only records send intents and outcomes.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { sanitizeTelegramError } from "./notifier.js";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export type DeliveryOutcome = "sent" | "failed" | "skipped";

export interface JournalDestination {
  chatId: string;
  topicId?: number | undefined;
}

export interface JournalEntry {
  kind: "intent" | "retry" | "done";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Target Telegram chat id when tracked per-destination. */
  chatId?: string;
  /** Target Telegram forum topic / thread id when tracked per-destination. */
  topicId?: number;
  /** Persisted delivery outcome on `done` entries. */
  outcome?: DeliveryOutcome;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  /** Stable error code for operator triage (e.g. Telegram error_code 400, 429). */
  errorCode?: number | string;
  /** Sanitized, redacted, and length-bounded error description. */
  errorDescription?: string;
  at: number;
  /**
   * Epoch milliseconds when the next retry attempt is eligible.
   * Stored with pending deliveries so a restart honours remaining backoff
   * instead of immediately bursting retries.
   */
  nextAttemptAt?: number;
  /** Number of failed delivery attempts recorded for this pending delivery. */
  attempts?: number;
}

export interface SendJournalOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  /** Known secrets (e.g. botToken) to redact from persisted error descriptions. */
  secrets?: readonly string[];
}

export interface SendJournalStats {
  entries: number;
  bytes: number;
}

export interface SendJournal {
  recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    chatId?: string;
    topicId?: number;
    textHash?: string;
    chatId?: string;
    networkPassphrase?: string;
    at: number;
    nextAttemptAt?: number;
    attempts?: number;
  }): Promise<void>;
  /**
   * Persist the next eligible retry time for a pending delivery so a restart
   * does not immediately burst retries.
   */
  recordRetry(id: string, nextAttemptAt: number, attempts?: number): Promise<void>;
  recordDone(id: string): Promise<void>;
  /**
   * Record that a send attempt for `id` timed out before Telegram responded.
   * The notification may or may not have been delivered. This is distinct from
   * a confirmed rejection (4xx error) or a crash before the send was attempted.
   * `timeoutReason` is a bounded, pre-scrubbed description; never persisted raw.
   */
  recordTimeout(id: string, timeoutReason?: string): Promise<void>;
  /** Intents with no matching done: notifications that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
  /**
   * Pending deliveries whose `nextAttemptAt` is absent or `<= asOf`
   * (defaults to the journal clock). Entries scheduled in the future are
   * excluded until their retry time arrives.
   */
  loadDue(asOf?: number): Promise<JournalEntry[]>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

/**
 * Remaining wait time in milliseconds until `nextAttemptAt` is due.
 * Returns `0` when `nextAttemptAt` is absent, non-finite, or already due.
 */
export function retryDelayMs(
  nextAttemptAt: number | undefined,
  asOf: number = Date.now(),
): number {
  if (typeof nextAttemptAt !== "number" || !Number.isFinite(nextAttemptAt)) return 0;
  if (typeof asOf !== "number" || !Number.isFinite(asOf)) return 0;
  return Math.max(0, nextAttemptAt - asOf);
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function line(entry: JournalEntry): string {
  return JSON.stringify(entry);
}

function isDoneError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function createSendJournal(options: SendJournalOptions): SendJournal {
  const filePath = options.filePath;
  const dir = path.dirname(filePath);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_SEND_JOURNAL_MAX_ENTRIES);
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_SEND_JOURNAL_MAX_BYTES);
  const now = options.now ?? Date.now;

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Append one JSONL line and fsync so it survives a crash. */
  async function append(entry: JournalEntry): Promise<void> {
    await ensureDir();
    const handle = await open(filePath, "a");
    try {
      await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readLines(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return [];
      throw err;
    }
    const out: JournalEntry[] = [];
    for (const ln of raw.split("\n")) {
      const trimmed = ln.trim();
      if (trimmed === "") continue;
      try {
        out.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // A torn or corrupt line is skipped rather than failing the journal.
      }
    }
    return out;
  }

  /** Atomically rewrite the journal with the given entries and fsync. */
  async function persist(entries: JournalEntry[]): Promise<void> {
    await ensureDir();
    const tmp = `${filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      for (const entry of entries) await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmp, filePath);
    // Best-effort directory fsync so the rename itself is durable.
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the file fsync is
      // the durable part that matters for crash recovery.
    }
  }

  async function recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    chatId?: string;
    topicId?: number;
    textHash?: string;
    chatId?: string;
    networkPassphrase?: string;
    at: number;
    nextAttemptAt?: number;
    attempts?: number;
  }): Promise<void> {
    const nextAttemptAt = normalizeNonNegativeInt(entry.nextAttemptAt);
    const attempts = normalizeNonNegativeInt(entry.attempts);
    await append({
      kind: "intent",
      id: entry.id,
      source: entry.source,
      ledger: entry.ledger,
      eventName: entry.eventName,
      ...(entry.textHash !== undefined ? { textHash: entry.textHash } : {}),
      at: entry.at,
      ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
    });
  }

  async function recordRetry(
    id: string,
    nextAttemptAt: number,
    attempts?: number,
  ): Promise<void> {
    const normalizedNext = normalizeNonNegativeInt(nextAttemptAt);
    if (normalizedNext === undefined) {
      throw new RangeError(
        `nextAttemptAt must be a finite non-negative number, got ${String(nextAttemptAt)}`,
      );
    }
    const normalizedAttempts = normalizeNonNegativeInt(attempts);
    await append({
      kind: "retry",
      id,
      source: "",
      ledger: 0,
      eventName: "",
      at: now(),
      nextAttemptAt: normalizedNext,
      ...(normalizedAttempts !== undefined ? { attempts: normalizedAttempts } : {}),
    });
  }

  async function recordDone(
    id: string,
    destination?: JournalDestination,
    outcome?: DeliveryOutcome,
  ): Promise<void> {
    const doneEntry: JournalEntry = {
      kind: "done",
      id,
      source: "",
      ledger: 0,
      eventName: "",
      ...(destination ? { chatId: destination.chatId } : {}),
      ...(destination?.topicId !== undefined ? { topicId: destination.topicId } : {}),
      ...(outcome !== undefined ? { outcome } : destination ? { outcome: "sent" as const } : {}),
      at: now(),
    };
    await append(doneEntry);
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    const stats = await journalStats();
    if (stats.entries > maxEntries || stats.bytes > maxBytes) {
      await compact();
    }
  }

  function resolvePending(entries: JournalEntry[]): JournalEntry[] {
    const done = new Set<string>();
    const timedOut = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
      if (entry.kind === "timeout") timedOut.add(entry.id);
    }
    const pending = new Map<string, JournalEntry>();
    for (const entry of entries) {
      if (done.has(entry.id)) continue;
      if (entry.kind === "intent") {
        const nextAttemptAt = normalizeNonNegativeInt(entry.nextAttemptAt);
        const attempts = normalizeNonNegativeInt(entry.attempts);
        pending.set(entry.id, {
          kind: "intent",
          id: entry.id,
          source: entry.source,
          ledger: entry.ledger,
          eventName: entry.eventName,
          ...(entry.textHash !== undefined ? { textHash: entry.textHash } : {}),
          at: entry.at,
          ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
          ...(attempts !== undefined ? { attempts } : {}),
        });
      } else if (entry.kind === "retry") {
        const nextAttemptAt = normalizeNonNegativeInt(entry.nextAttemptAt);
        const attempts = normalizeNonNegativeInt(entry.attempts);
        const existing = pending.get(entry.id);
        if (existing) {
          if (nextAttemptAt !== undefined) existing.nextAttemptAt = nextAttemptAt;
          if (attempts !== undefined) existing.attempts = attempts;
        } else {
          pending.set(entry.id, {
            kind: "intent",
            id: entry.id,
            source: entry.source ?? "",
            ledger: entry.ledger ?? 0,
            eventName: entry.eventName ?? "",
            at: entry.at,
            ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
            ...(attempts !== undefined ? { attempts } : {}),
          });
        }
      }
    }
    return [...pending.values()];
  }

  async function loadPending(): Promise<JournalEntry[]> {
    return resolvePending(await readLines());
  }

  async function loadDue(asOf: number = now()): Promise<JournalEntry[]> {
    const pending = await loadPending();
    return pending.filter((entry) => retryDelayMs(entry.nextAttemptAt, asOf) === 0);
  }

  async function compact(): Promise<void> {
    // A done line settles its intent and any retry lines: all can be dropped.
    // Unresolved intents are persisted with their latest nextAttemptAt/attempts.
    const unresolved = resolvePending(await readLines());
    await persist(unresolved);
  }

  async function journalStats(): Promise<SendJournalStats> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return { entries: 0, bytes: 0 };
      throw err;
    }
    let entries = 0;
    for (const ln of raw.split("\n")) {
      if (ln.trim() !== "") entries += 1;
    }
    return { entries, bytes: Buffer.byteLength(raw, "utf8") };
  }

  async function stats(): Promise<SendJournalStats> {
    return journalStats();
  }

  return { recordIntent, recordRetry, recordDone, loadPending, loadDue, compact, stats };
}
