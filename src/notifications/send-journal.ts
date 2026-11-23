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
 *
 * Routing preview: `previewRoutingDecision` is not part of this module; the
 * journal only records send intents and outcomes.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export type DeliveryOutcome = "sent" | "failed" | "skipped";

export interface JournalDestination {
  chatId: string;
  topicId?: number | undefined;
}

export interface JournalEntry {
  kind: "intent" | "done";
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
  /** Resolved Telegram chat route at the time the intent was recorded. */
  chatId?: string;
  /** Stellar network passphrase at the time the intent was recorded. */
  networkPassphrase?: string;
  at: number;
}

export type OrphanReason = "removed_route" | "network_changed";

export interface OrphanedJournalEntry {
  entry: JournalEntry;
  reason: OrphanReason;
  /** Current resolved route chat ID for this entry's source, if any. */
  currentChatId?: string;
  /** Current configured network passphrase, if any. */
  currentNetworkPassphrase?: string;
}

export interface JournalRecoveryContext {
  /** Resolve the current route chat ID for a given entry source (empty = removed). */
  resolveRouteChatId?: (source: string) => string;
  /** Current Stellar network passphrase. */
  networkPassphrase?: string;
}

export type OrphanDecision =
  | { action: "discard" }
  | { action: "reroute"; chatId?: string; networkPassphrase?: string };

export interface OrphanRecoveryResult {
  valid: JournalEntry[];
  orphaned: OrphanedJournalEntry[];
  discarded: number;
  rerouted: number;
  reroutedEntries: JournalEntry[];
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
    chatId?: string;
    topicId?: number;
    textHash?: string;
    chatId?: string;
    networkPassphrase?: string;
    at: number;
  }): Promise<void>;
  recordDone(
    id: string,
    destination?: JournalDestination,
    outcome?: DeliveryOutcome,
  ): Promise<void>;
  /** Intents with no matching done: notifications/destinations that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
  /** Partition pending entries into valid vs orphaned (removed route / changed network). */
  classifyPending(context: JournalRecoveryContext): Promise<{
    valid: JournalEntry[];
    orphaned: OrphanedJournalEntry[];
  }>;
  /**
   * Apply an explicit discard or reroute decision to each orphaned entry
   * instead of silently replaying it under the new configuration.
   */
  recoverOrphans(
    context: JournalRecoveryContext,
    decide: (orphan: OrphanedJournalEntry) => OrphanDecision | Promise<OrphanDecision>,
  ): Promise<OrphanRecoveryResult>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

function entryKey(id: string, chatId?: string, topicId?: number): string {
  if (chatId === undefined && topicId === undefined) return id;
  return `${id}\0${chatId ?? ""}\0${topicId !== undefined ? String(topicId) : ""}`;
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
  }): Promise<void> {
    await append({ kind: "intent", ...entry });
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

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") {
        done.add(entryKey(entry.id, entry.chatId, entry.topicId));
      }
    }
    return entries.filter(
      (e) => e.kind === "intent" && !done.has(entryKey(e.id, e.chatId, e.topicId)),
    );
  }

  async function loadPendingForEvent(id: string): Promise<JournalEntry[]> {
    const pending = await loadPending();
    return pending.filter((e) => e.id === id);
  }

  async function classifyPending(context: JournalRecoveryContext): Promise<{
    valid: JournalEntry[];
    orphaned: OrphanedJournalEntry[];
  }> {
    const pending = await loadPending();
    const valid: JournalEntry[] = [];
    const orphaned: OrphanedJournalEntry[] = [];

    for (const entry of pending) {
      if (
        entry.networkPassphrase &&
        context.networkPassphrase &&
        entry.networkPassphrase !== context.networkPassphrase
      ) {
        orphaned.push({
          entry,
          reason: "network_changed",
          currentNetworkPassphrase: context.networkPassphrase,
          ...(context.resolveRouteChatId
            ? { currentChatId: context.resolveRouteChatId(entry.source) }
            : {}),
        });
        continue;
      }

      if (entry.chatId && context.resolveRouteChatId) {
        const currentChatId = context.resolveRouteChatId(entry.source);
        if (!currentChatId || currentChatId !== entry.chatId) {
          orphaned.push({
            entry,
            reason: "removed_route",
            currentChatId,
            ...(context.networkPassphrase
              ? { currentNetworkPassphrase: context.networkPassphrase }
              : {}),
          });
          continue;
        }
      }

      valid.push(entry);
    }

    return { valid, orphaned };
  }

  async function recoverOrphans(
    context: JournalRecoveryContext,
    decide: (orphan: OrphanedJournalEntry) => OrphanDecision | Promise<OrphanDecision>,
  ): Promise<OrphanRecoveryResult> {
    const { valid, orphaned } = await classifyPending(context);
    if (orphaned.length === 0) {
      return { valid, orphaned: [], discarded: 0, rerouted: 0, reroutedEntries: [] };
    }

    const entries = await readLines();
    const doneIds = new Set<string>();
    const rerouteMap = new Map<string, JournalEntry>();
    let discarded = 0;
    let rerouted = 0;
    const reroutedEntries: JournalEntry[] = [];

    for (const orphan of orphaned) {
      const decision = await decide(orphan);
      if (decision.action === "discard") {
        doneIds.add(orphan.entry.id);
        discarded += 1;
      } else if (decision.action === "reroute") {
        const nextChatId = decision.chatId ?? orphan.currentChatId ?? "";
        if (!nextChatId) {
          throw new Error(
            `Cannot reroute orphaned journal entry ${orphan.entry.id}: target route is empty`,
          );
        }
        const nextNetwork =
          decision.networkPassphrase ??
          context.networkPassphrase ??
          orphan.entry.networkPassphrase;
        const updated: JournalEntry = {
          ...orphan.entry,
          chatId: nextChatId,
          ...(nextNetwork ? { networkPassphrase: nextNetwork } : {}),
          at: now(),
        };
        rerouteMap.set(orphan.entry.id, updated);
        rerouted += 1;
        reroutedEntries.push(updated);
      } else {
        throw new Error(
          `Invalid orphan decision for ${orphan.entry.id}: expected "discard" or "reroute"`,
        );
      }
    }

    const nextEntries: JournalEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === "intent" && doneIds.has(entry.id)) {
        continue;
      }
      if (entry.kind === "intent" && rerouteMap.has(entry.id)) {
        nextEntries.push(rerouteMap.get(entry.id)!);
        continue;
      }
      nextEntries.push(entry);
    }
    await persist(nextEntries);

    return { valid, orphaned, discarded, rerouted, reroutedEntries };
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "done") {
        done.add(entryKey(entry.id, entry.chatId, entry.topicId));
      }
    }
    // A done line settles its intent: both lines can be dropped. Keep only
    // unresolved intents.
    const unresolved = entries.filter(
      (e) => e.kind === "intent" && !done.has(entryKey(e.id, e.chatId, e.topicId)),
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

  return { recordIntent, recordDone, loadPending, classifyPending, recoverOrphans, compact, stats };
}
