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
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export interface JournalEntry {
  kind: "intent" | "done" | "timeout";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  at: number;
  /**
   * Bounded, scrubbed description of the timeout that produced this entry.
   * Only present on `timeout` lines; never on `intent` or `done` lines.
   * Never contains bot tokens or raw chat ids.
   */
  timeoutReason?: string;
}

export interface SendJournalOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
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
    textHash?: string;
    at: number;
  }): Promise<void>;
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
   * Pending intents that also have at least one matching `timeout` line.
   * These are **confirmed-unknown outcomes**: the HTTP call reached Telegram's
   * endpoint but the client did not receive a response, so the notification
   * may have been accepted. Callers should not retry without de-duplication
   * and must not claim exactly-once delivery.
   */
  loadUnknownOutcomes(): Promise<JournalEntry[]>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
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
    textHash?: string;
    at: number;
  }): Promise<void> {
    await append({ kind: "intent", ...entry });
  }

  async function recordDone(id: string): Promise<void> {
    await append({ kind: "done", id, source: "", ledger: 0, eventName: "", at: now() });
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    const stats = await journalStats();
    if (stats.entries > maxEntries || stats.bytes > maxBytes) {
      await compact();
    }
  }

  async function recordTimeout(id: string, timeoutReason?: string): Promise<void> {
    const entry: JournalEntry = {
      kind: "timeout",
      id,
      source: "",
      ledger: 0,
      eventName: "",
      at: now(),
    };
    if (typeof timeoutReason === "string" && timeoutReason.trim().length > 0) {
      // Bound the reason string to avoid persisting unbounded remote payloads.
      entry.timeoutReason = timeoutReason.slice(0, 200);
    }
    await append(entry);
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
    }
    return entries.filter((e) => e.kind === "intent" && !done.has(e.id));
  }

  async function loadUnknownOutcomes(): Promise<JournalEntry[]> {
    const entries = await readLines();
    const done = new Set<string>();
    const timedOut = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
      if (entry.kind === "timeout") timedOut.add(entry.id);
    }
    // Return pending intents that also have at least one timeout line:
    // the send reached Telegram's endpoint but the response was not received.
    return entries.filter(
      (e) => e.kind === "intent" && !done.has(e.id) && timedOut.has(e.id),
    );
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
    }
    // A done line settles its intent: both lines (and any associated timeout
    // lines for the same id) can be dropped. Keep only unresolved intents and
    // their associated timeout lines so the unknown-outcome signal is preserved.
    const unresolved = entries.filter(
      (e) => (e.kind === "intent" || e.kind === "timeout") && !done.has(e.id),
    );
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

  return { recordIntent, recordDone, recordTimeout, loadPending, loadUnknownOutcomes, compact, stats };
}
