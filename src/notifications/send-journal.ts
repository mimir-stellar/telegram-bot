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
export const SEND_JOURNAL_DIAGNOSTIC_MAX_CHARS = 200;

export interface JournalEntry {
  kind: "intent" | "done" | "invalid_result";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  /** Bounded diagnostic retained when a delivery result is invalid (e.g. missing message_id). */
  diagnostic?: string;
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
  /**
   * Record a bounded diagnostic when a send returned an invalid delivery result
   * (such as missing `message_id`) without marking the intent as `done`.
   */
  recordInvalidResult(id: string, diagnostic: string): Promise<void>;
  /** Intents with no matching done: notifications that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

function boundDiagnostic(raw: string): string {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= SEND_JOURNAL_DIAGNOSTIC_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, SEND_JOURNAL_DIAGNOSTIC_MAX_CHARS)}…`;
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

  async function recordInvalidResult(id: string, diagnostic: string): Promise<void> {
    await append({
      kind: "invalid_result",
      id,
      source: "",
      ledger: 0,
      eventName: "",
      diagnostic: boundDiagnostic(diagnostic),
      at: now(),
    });
    const stats = await journalStats();
    if (stats.entries > maxEntries || stats.bytes > maxBytes) {
      await compact();
    }
  }

  function resolveUnresolvedIntents(entries: JournalEntry[]): JournalEntry[] {
    const done = new Set<string>();
    const diagnostics = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === "done") {
        done.add(entry.id);
      } else if (entry.kind === "invalid_result" && typeof entry.diagnostic === "string") {
        diagnostics.set(entry.id, boundDiagnostic(entry.diagnostic));
      }
    }
    return entries
      .filter((e) => e.kind === "intent" && !done.has(e.id))
      .map((e) => {
        const diag = diagnostics.get(e.id) ?? e.diagnostic;
        return diag !== undefined ? { ...e, diagnostic: boundDiagnostic(diag) } : e;
      });
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    return resolveUnresolvedIntents(entries);
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    // A done line settles its intent: both lines can be dropped. Keep only
    // unresolved intents (with any attached bounded diagnostic).
    const unresolved = resolveUnresolvedIntents(entries);
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

  return { recordIntent, recordDone, recordInvalidResult, loadPending, compact, stats };
}
