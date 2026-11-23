/**
 * Offline delivery reconciliation report.
 *
 * Compares the send journal (intent/done bookkeeping) with the message-index
 * (confirmed Telegram message IDs) to surface delivery inconsistencies without
 * contacting Telegram or mutating either file.
 *
 * The two sources cover different scopes:
 *
 * - The send journal records every *attempted* send: an intent is written
 *   before the sendMessage call and a done is written after it succeeds.  An
 *   intent with no matching done means the process was killed between the two
 *   writes — the message *may or may not* have reached Telegram.
 *
 * - The message index records (chatId, ref) → messageId for events the bot
 *   wants to edit or reply to later (markets and squads).  A record here means
 *   Telegram returned a message ID, so delivery was confirmed by the API.
 *
 * Inconsistencies the report identifies:
 *
 *   UNRESOLVED_INTENT  — journal pending intent with no message-index record
 *                        for the same (source, ledger, eventName).  The send
 *                        outcome is ambiguous: Telegram may or may not have
 *                        accepted it.
 *
 *   ORPHANED_INDEX     — message-index record with no pending journal intent.
 *                        This is usually healthy (the intent was settled by a
 *                        done and compacted away), but it is surfaced so
 *                        operators can confirm the population is expected.
 *
 * The report is always read-only; it touches no file and makes no network
 * calls.
 */

import {
  createSendJournal,
  type JournalEntry,
} from "./send-journal.js";
import {
  createMessageIndex,
  type MessageIndexFileEntry,
} from "./message-index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type InconsistencyKind = "UNRESOLVED_INTENT" | "ORPHANED_INDEX";

export interface DeliveryInconsistency {
  kind: InconsistencyKind;
  /**
   * Human-readable explanation of why this entry is considered inconsistent.
   */
  reason: string;
  /** Populated for UNRESOLVED_INTENT entries. */
  journalEntry?: JournalEntry;
  /** Populated for ORPHANED_INDEX entries. */
  indexEntry?: MessageIndexFileEntry;
}

export interface DeliveryReportOptions {
  /** Path to the send-journal JSONL file. */
  journalFile: string;
  /** Path to the message-index JSON file. */
  indexFile: string;
}

export interface DeliveryReport {
  /** Always true: the report never contacts Telegram or mutates state. */
  readOnly: true;
  /**
   * Total pending intents loaded from the journal (intents with no done).
   */
  pendingIntents: number;
  /**
   * Total entries loaded from the message index.
   */
  indexedMessages: number;
  /**
   * All detected inconsistencies, in journal-then-index order.
   */
  inconsistencies: DeliveryInconsistency[];
  /** Convenience counts. */
  unresolvedIntents: number;
  orphanedIndexEntries: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a canonical message-index ref from a journal entry's source and
 * event-specific fields.  The message index uses refs of the form
 * `"market:<id>"` or `"squad:<id>"`.  The journal records a raw Stellar event
 * id (`"<ledger>-<opIndex>"`) plus the source and ledger.
 *
 * We build a ref key as `"<source>:<ledger>"` for correlation: coarse enough
 * to match across the two stores without requiring a perfect event-id mapping.
 */
function journalRefKey(entry: JournalEntry): string {
  return `${entry.source}:${entry.ledger}`;
}

/**
 * Derive the same coarse ref key from a message-index entry's `ref` field.
 * Message-index refs look like `"market:123"` or `"squad:42"`.  We normalise
 * by extracting the prefix up to the second colon (or the whole value when
 * there is only one colon segment), giving `"market:123"` → `"market:123"`.
 */
function indexRefKey(entry: MessageIndexFileEntry): string {
  // The ref is already in `source:id` form; use it directly.
  return String(entry.ref);
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Build a delivery reconciliation report by reading the journal and the
 * message index from disk.  Makes no Telegram requests and does not mutate
 * either file.
 */
export async function buildDeliveryReport(
  options: DeliveryReportOptions,
): Promise<DeliveryReport> {
  // ── Load send journal pending intents ────────────────────────────────────
  const journal = createSendJournal({ filePath: options.journalFile });
  const pending = await journal.loadPending();

  // ── Load message-index entries ───────────────────────────────────────────
  const index = await createMessageIndex({ filePath: options.indexFile });
  const indexEntries = index.toJSON();

  // Build lookup sets for cross-referencing.
  //
  // Journal side: map from coarse ref key → entry.
  const pendingByRef = new Map<string, JournalEntry>();
  for (const entry of pending) {
    const key = journalRefKey(entry);
    // Keep the first occurrence per key (oldest pending intent per event).
    if (!pendingByRef.has(key)) {
      pendingByRef.set(key, entry);
    }
  }

  // Index side: map from ref key → entry.
  const indexByRef = new Map<string, MessageIndexFileEntry>();
  for (const entry of indexEntries) {
    const key = indexRefKey(entry);
    if (!indexByRef.has(key)) {
      indexByRef.set(key, entry);
    }
  }

  const inconsistencies: DeliveryInconsistency[] = [];

  // ── UNRESOLVED_INTENT: pending intent with no index record ───────────────
  for (const [key, entry] of pendingByRef) {
    if (!indexByRef.has(key)) {
      inconsistencies.push({
        kind: "UNRESOLVED_INTENT",
        reason:
          `send intent for ${entry.source} event at ledger ${entry.ledger} ` +
          `(id=${entry.id}, event=${entry.eventName}) has no matching ` +
          `message-index record — delivery outcome is unknown`,
        journalEntry: entry,
      });
    }
  }

  // ── ORPHANED_INDEX: index record with no pending intent ──────────────────
  for (const [key, entry] of indexByRef) {
    if (!pendingByRef.has(key)) {
      inconsistencies.push({
        kind: "ORPHANED_INDEX",
        reason:
          `message-index record for ref "${entry.ref}" (chatId=${entry.chatId}, ` +
          `messageId=${entry.messageId}) has no pending journal intent — ` +
          `this is expected when delivery was confirmed and the intent was settled`,
        indexEntry: entry,
      });
    }
  }

  const unresolvedIntents = inconsistencies.filter(
    (i) => i.kind === "UNRESOLVED_INTENT",
  ).length;
  const orphanedIndexEntries = inconsistencies.filter(
    (i) => i.kind === "ORPHANED_INDEX",
  ).length;

  return {
    readOnly: true,
    pendingIntents: pending.length,
    indexedMessages: indexEntries.length,
    inconsistencies,
    unresolvedIntents,
    orphanedIndexEntries,
  };
}
