/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds with a confirmed Telegram `message_id` it appends a matching
 * `done` line. If Telegram returns a payload missing a valid `message_id`, the
 * journal records a bounded `diagnostic` line instead of `done`, keeping the
 * original `intent` unresolved and recoverable on restart.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done`) pairs are dropped, leaving only unresolved
 * intents (with their latest bounded diagnostic when present).
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { redactText } from "../redact.js";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;
export const MAX_JOURNAL_DIAGNOSTIC_CHARS = 200;

export class InvalidTelegramDeliveryResultError extends Error {
  readonly code = "INVALID_TELEGRAM_DELIVERY_RESULT";
  readonly diagnostic: string;
  recordedInJournal = false;

  constructor(diagnostic: string) {
    super(`Invalid Telegram delivery result: ${diagnostic}`);
    this.name = "InvalidTelegramDeliveryResultError";
    this.diagnostic = diagnostic;
  }
}

/** True when `value` is a positive safe integer Telegram `message_id`. */
export function isValidTelegramMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** True when a Telegram `sendMessage` response contains a valid `message_id`. */
export function isValidTelegramDeliveryResult(
  result: unknown,
): result is { message_id: number } {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    isValidTelegramMessageId((result as { message_id?: unknown }).message_id)
  );
}

/**
 * Build a bounded, credential-safe diagnostic describing why a Telegram
 * `sendMessage` result could not be confirmed. Never echoes message text.
 */
export function describeInvalidDeliveryResult(
  result: unknown,
  chunkIndex?: number,
  chunkCount?: number,
): string {
  const chunkSuffix =
    typeof chunkCount === "number" && chunkCount > 1
      ? ` (chunk ${(chunkIndex ?? 0) + 1}/${chunkCount})`
      : "";

  if (result === null || result === undefined) {
    return `missing_message_id: response was ${String(result)}${chunkSuffix}`;
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    const label = Array.isArray(result) ? "array" : typeof result;
    return `missing_message_id: response was non-object (${label})${chunkSuffix}`;
  }
  const record = result as { message_id?: unknown };
  if (!("message_id" in record) || record.message_id === undefined) {
    return `missing_message_id: Telegram response omitted message_id${chunkSuffix}`;
  }
  const rawId = record.message_id;
  const detail =
    rawId === null
      ? "null"
      : typeof rawId === "number"
        ? `number(${String(rawId).slice(0, 24)})`
        : typeof rawId;
  return `invalid_message_id: expected positive integer, got ${detail}${chunkSuffix}`;
}

/** Sanitize and bound a journal diagnostic string before persistence. */
export function sanitizeJournalDiagnostic(
  diagnostic: string,
  secrets?: readonly string[],
): string {
  const normalized = String(diagnostic ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") {
    return "missing_message_id: invalid Telegram delivery result";
  }
  return redactText(normalized, {
    ...(secrets ? { secrets } : {}),
    maxLen: MAX_JOURNAL_DIAGNOSTIC_CHARS,
  });
}

export interface JournalEntry {
  kind: "intent" | "done" | "diagnostic";
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  /** Confirmed positive Telegram `message_id` when recorded with `done`. */
  messageId?: number;
  /** Bounded diagnostic retained when a send result was missing a valid `message_id`. */
  diagnostic?: string;
  at: number;
}

export interface SendJournalOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  secrets?: readonly string[];
}

export interface SendJournalStats {
  entries: number;
  bytes: number;
}

export type ConfirmDeliveryOutcome =
  | { confirmed: true; messageId: number }
  | { confirmed: false; diagnostic: string };

export interface SendJournal {
  recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    textHash?: string;
    at: number;
  }): Promise<void>;
  recordDone(
    id: string,
    confirmation?: { messageId?: unknown; secrets?: readonly string[] },
  ): Promise<void>;
  recordDiagnostic(entry: {
    id: string;
    diagnostic: string;
    at?: number;
    secrets?: readonly string[];
  }): Promise<void>;
  confirmDelivery(
    id: string,
    response: unknown,
    options?: { secrets?: readonly string[]; at?: number },
  ): Promise<ConfirmDeliveryOutcome>;
  /** Intents with no matching done: notifications that remain unconfirmed/recoverable. */
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
  const defaultSecrets = options.secrets ?? [];

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
    const current = await journalStats();
    if (current.entries > maxEntries || current.bytes > maxBytes) {
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

  async function recordDiagnostic(entry: {
    id: string;
    diagnostic: string;
    at?: number;
    secrets?: readonly string[];
  }): Promise<void> {
    const mergedSecrets = [...defaultSecrets, ...(entry.secrets ?? [])];
    const bounded = sanitizeJournalDiagnostic(entry.diagnostic, mergedSecrets);
    await append({
      kind: "diagnostic",
      id: entry.id,
      source: "",
      ledger: 0,
      eventName: "",
      diagnostic: bounded,
      at: entry.at ?? now(),
    });
    await maybeCompact();
  }

  async function recordDone(
    id: string,
    confirmation?: { messageId?: unknown; secrets?: readonly string[] },
  ): Promise<void> {
    if (confirmation !== undefined) {
      if (!isValidTelegramMessageId(confirmation.messageId)) {
        const rawDiag = describeInvalidDeliveryResult({
          message_id: confirmation.messageId,
        });
        const mergedSecrets = [...defaultSecrets, ...(confirmation.secrets ?? [])];
        const bounded = sanitizeJournalDiagnostic(rawDiag, mergedSecrets);
        await recordDiagnostic({
          id,
          diagnostic: bounded,
          secrets: mergedSecrets,
        });
        const err = new InvalidTelegramDeliveryResultError(bounded);
        err.recordedInJournal = true;
        throw err;
      }
      await append({
        kind: "done",
        id,
        source: "",
        ledger: 0,
        eventName: "",
        messageId: confirmation.messageId,
        at: now(),
      });
      await maybeCompact();
      return;
    }

    await append({ kind: "done", id, source: "", ledger: 0, eventName: "", at: now() });
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    await maybeCompact();
  }

  async function confirmDelivery(
    id: string,
    response: unknown,
    confirmOptions?: { secrets?: readonly string[]; at?: number },
  ): Promise<ConfirmDeliveryOutcome> {
    const mergedSecrets = [...defaultSecrets, ...(confirmOptions?.secrets ?? [])];
    if (isValidTelegramDeliveryResult(response)) {
      await append({
        kind: "done",
        id,
        source: "",
        ledger: 0,
        eventName: "",
        messageId: response.message_id,
        at: confirmOptions?.at ?? now(),
      });
      await maybeCompact();
      return { confirmed: true, messageId: response.message_id };
    }

    const bounded = sanitizeJournalDiagnostic(
      describeInvalidDeliveryResult(response),
      mergedSecrets,
    );
    await recordDiagnostic({
      id,
      diagnostic: bounded,
      ...(confirmOptions?.at !== undefined ? { at: confirmOptions.at } : {}),
      secrets: mergedSecrets,
    });
    return { confirmed: false, diagnostic: bounded };
  }

  function resolvePending(entries: readonly JournalEntry[]): JournalEntry[] {
    const done = new Set<string>();
    const latestDiagnostics = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === "done") {
        done.add(entry.id);
      } else if (entry.kind === "diagnostic" && typeof entry.diagnostic === "string") {
        latestDiagnostics.set(
          entry.id,
          sanitizeJournalDiagnostic(entry.diagnostic, defaultSecrets),
        );
      } else if (entry.kind === "intent" && typeof entry.diagnostic === "string") {
        latestDiagnostics.set(
          entry.id,
          sanitizeJournalDiagnostic(entry.diagnostic, defaultSecrets),
        );
      }
    }

    return entries
      .filter((e) => e.kind === "intent" && !done.has(e.id))
      .map((e) => {
        const diagnostic = latestDiagnostics.get(e.id);
        return diagnostic !== undefined ? { ...e, diagnostic } : e;
      });
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    return resolvePending(entries);
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    // A done line settles its intent: both lines (and any interim diagnostics)
    // can be dropped. Keep only unresolved intents, folding the latest bounded
    // diagnostic onto each unresolved intent so repeated invalid responses stay
    // strictly bounded.
    const unresolved = resolvePending(entries);
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

  return {
    recordIntent,
    recordDone,
    recordDiagnostic,
    confirmDelivery,
    loadPending,
    compact,
    stats,
  };
}
