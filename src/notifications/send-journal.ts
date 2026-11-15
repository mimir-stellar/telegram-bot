/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds it appends a matching `done` line. On restart, lines that carry
 * an `intent` but no `done` identify notifications that may or may not have
 * been delivered -- instead of guessing from the cursor.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done`) pairs are dropped, leaving only unresolved
 * intents.
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export interface JournalEntry {
  kind: "intent" | "done";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Optional canonical message-index reference (`market:<id>` / `squad:<id>`). */
  ref?: string;
  /** Optional confirmed Telegram `message_id` recorded on `done`. */
  messageId?: number;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  at: number;
}

export interface SendJournalSnapshot {
  status: "ok" | "missing";
  entries: JournalEntry[];
  corruptLines: number;
  bytes: number;
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
    ref?: string;
    textHash?: string;
    at: number;
  }): Promise<void>;
  recordDone(id: string, details?: { messageId?: number }): Promise<void>;
  /** Intents with no matching done: notifications that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
  /** Read all valid entries and corrupt-line count without mutating disk state. */
  readAll(): Promise<SendJournalSnapshot>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

function line(entry: JournalEntry): string {
  return JSON.stringify(entry);
}

function isDoneError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isValidJournalEntry(candidate: unknown): candidate is JournalEntry {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const rec = candidate as Record<string, unknown>;
  if (rec.kind !== "intent" && rec.kind !== "done") return false;
  if (typeof rec.id !== "string" || rec.id.trim() === "") return false;
  if (typeof rec.source !== "string") return false;
  if (typeof rec.ledger !== "number" || !Number.isFinite(rec.ledger)) return false;
  if (typeof rec.eventName !== "string") return false;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return false;
  return true;
}

/**
 * Read a send-journal JSONL file offline without mutating or compacting it.
 */
export async function readSendJournalSnapshot(
  filePath: string,
): Promise<SendJournalSnapshot> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isDoneError(err)) {
      return { status: "missing", entries: [], corruptLines: 0, bytes: 0 };
    }
    throw err;
  }

  const entries: JournalEntry[] = [];
  let corruptLines = 0;
  for (const ln of raw.split("\n")) {
    const trimmed = ln.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidJournalEntry(parsed)) {
        entries.push(parsed);
      } else {
        corruptLines += 1;
      }
    } catch {
      corruptLines += 1;
    }
  }

  return {
    status: "ok",
    entries,
    corruptLines,
    bytes: Buffer.byteLength(raw, "utf8"),
  };
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
    const snapshot = await readSendJournalSnapshot(filePath);
    return snapshot.entries;
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
    ref?: string;
    textHash?: string;
    at: number;
  }): Promise<void> {
    await append({ kind: "intent", ...entry });
  }

  async function recordDone(
    id: string,
    details?: { messageId?: number },
  ): Promise<void> {
    await append({
      kind: "done",
      id,
      source: "",
      ledger: 0,
      eventName: "",
      ...(details?.messageId !== undefined ? { messageId: details.messageId } : {}),
      at: now(),
    });
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    const currentStats = await journalStats();
    if (currentStats.entries > maxEntries || currentStats.bytes > maxBytes) {
      await compact();
    }
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
    }
    return entries.filter((e) => e.kind === "intent" && !done.has(e.id));
  }

  async function readAll(): Promise<SendJournalSnapshot> {
    return readSendJournalSnapshot(filePath);
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") done.add(entry.id);
    }
    // A done line settles its intent: both lines can be dropped. Keep only
    // unresolved intents.
    const unresolved = entries.filter((e) => e.kind === "intent" && !done.has(e.id));
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

  return { recordIntent, recordDone, loadPending, readAll, compact, stats };
}
