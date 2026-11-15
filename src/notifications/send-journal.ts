/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds it appends a matching `done` line. If a queued send is
 * deterministically cancelled before reaching Telegram (for example during
 * concurrency-limiter shutdown), `recordCancelled` settles the intent so a
 * restart does not mistake an unsent queued item for a maybe-sent crash.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done` / `cancelled`) pairs are dropped, leaving only
 * unresolved intents.
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export interface JournalEntry {
  kind: "intent" | "done" | "cancelled";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  at: number;
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
  /** Settle an intent that was cancelled in the local queue before any HTTP send ran. */
  recordCancelled(id: string): Promise<void>;
  /** Intents with no matching done/cancelled: notifications that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
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

  async function maybeCompact(): Promise<void> {
    const currentStats = await journalStats();
    if (currentStats.entries > maxEntries || currentStats.bytes > maxBytes) {
      await compact();
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
    await maybeCompact();
  }

  async function recordCancelled(id: string): Promise<void> {
    await append({ kind: "cancelled", id, source: "", ledger: 0, eventName: "", at: now() });
    await maybeCompact();
  }

  function collectSettledIds(entries: readonly JournalEntry[]): Set<string> {
    const settled = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done" || entry.kind === "cancelled") {
        settled.add(entry.id);
      }
    }
    return settled;
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    const settled = collectSettledIds(entries);
    return entries.filter((e) => e.kind === "intent" && !settled.has(e.id));
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    const settled = collectSettledIds(entries);
    // A done or cancelled line settles its intent: both lines can be dropped.
    // Keep only unresolved intents.
    const unresolved = entries.filter((e) => e.kind === "intent" && !settled.has(e.id));
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

  return { recordIntent, recordDone, recordCancelled, loadPending, compact, stats };
}
