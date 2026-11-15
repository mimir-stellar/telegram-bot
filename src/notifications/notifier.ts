/**
 * Outbound notification sending: the poller's one path to Telegram.
 *
 * Extracted from `src/bot.ts` so notification-send changes and
 * command-handling changes no longer touch the same file.
 *
 * Public API (all re-exported from `src/bot.ts` for backwards compatibility):
 *   - {@link SendExtra}         — extra options a caller attaches to a send
 *   - {@link isMarkdownParseError} — classifier for Telegram entity-parse failures
 *   - {@link notifierSkips}    — counters for suppressed sends
 *   - {@link createNotifier}   — factory that returns the poller's send function
 *   - {@link reconcileDeliveryState} — offline journal vs. message-index report
 *   - {@link formatDeliveryReconciliationReport} — destination-safe report formatter
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Bot } from "grammy";

import type { BotConfig } from "../config.js";
import { redactError } from "../redact.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import {
  isValidChatId,
  isValidMessageId,
  isValidRef,
  MESSAGE_INDEX_SCHEMA_VERSION,
  type MessageIndexFileEntry,
} from "./message-index.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import {
  readSendJournalSnapshot,
  type JournalEntry,
} from "./send-journal.js";

// ── SendExtra ────────────────────────────────────────────────────────────────

/** Extra Telegram send options the poller may attach to a notification. */
export interface SendExtra {
  reply_markup?: ExplorerKeyboard | undefined;
  /**
   * Plain-text rendering of the same notification, sent without a `parse_mode`
   * when Telegram rejects the MarkdownV2 version for entity/parse reasons.
   * Optional: without it the notifier behaves exactly as before (parse errors
   * propagate, no second send). Empty or whitespace-only values count as absent.
   */
  plainText?: string | undefined;
  /**
   * Bounded identifiers for fallback logging only. Optional; never sent.
   */
  eventRef?: { eventId?: string | undefined; ledger?: number | undefined; source?: string | undefined } | undefined;
  /**
   * Post the notification as a reply to this message, for chats that thread
   * their notifications. Optional: omitted from the payload entirely when
   * absent, so the send is byte-identical to the unthreaded one.
   */
  replyToMessageId?: number | undefined;
  /** Decoded contract event name used to apply silent-notification policy. */
  eventName?: string | undefined;
}

// ── Offline Delivery Reconciliation ──────────────────────────────────────────

export type DeliveryInconsistencyKind =
  | "pending_with_index_record"
  | "pending_without_index_record"
  | "done_missing_index_record"
  | "orphan_done_without_intent"
  | "message_id_mismatch"
  | "route_chat_mismatch"
  | "index_without_journal_record";

export interface MessageIndexSnapshot {
  status: "ok" | "missing" | "corrupt";
  entries: MessageIndexFileEntry[];
  invalidEntries: number;
  error?: string;
}

export interface DeliveryInconsistency {
  kind: DeliveryInconsistencyKind;
  id?: string;
  ref: string;
  source?: string;
  ledger?: number;
  eventName?: string;
  journalMessageId?: number;
  indexMessageId?: number;
  expectedDestinationHash?: string;
  actualDestinationHash?: string;
  detail: string;
}

export interface DeliveryReconciliationReport {
  generatedAt: string;
  consistent: boolean;
  consistentCount: number;
  journal: {
    status: "ok" | "missing";
    totalEntries: number;
    intentCount: number;
    doneCount: number;
    corruptLines: number;
  };
  messageIndex: {
    status: "ok" | "missing" | "corrupt";
    validEntries: number;
    invalidEntries: number;
    error?: string;
  };
  countsByKind: Record<DeliveryInconsistencyKind, number>;
  inconsistencies: DeliveryInconsistency[];
}

export interface ReconcileDeliveryOptions {
  journalFilePath?: string;
  journalEntries?: readonly JournalEntry[];
  indexFilePath?: string;
  indexEntries?: readonly MessageIndexFileEntry[];
  config?: Partial<Pick<BotConfig, "chatId" | "chatIds" | "marketChatId" | "squadChatId">>;
  /** Include message-index records that have no matching journal intent (default `true`). */
  includeUnmatchedIndex?: boolean;
  secrets?: readonly string[];
  now?: () => number;
}

/** Non-reversible 8-hex destination fingerprint so raw chat IDs stay private. */
export function fingerprintDestination(chatId: string | number): string {
  const digest = createHash("sha256").update(String(chatId)).digest("hex").slice(0, 8);
  return `chat#${digest}`;
}

/** Canonical `message-index` reference derived from a send-journal intent. */
export function deriveJournalEventRef(
  entry: Pick<JournalEntry, "id" | "source" | "ref">,
): string {
  if (typeof entry.ref === "string" && entry.ref.trim() !== "") {
    return entry.ref.trim();
  }
  if (entry.id.startsWith("market:") || entry.id.startsWith("squad:")) {
    return entry.id;
  }
  if (entry.source === "market" || entry.source === "squad") {
    return `${entry.source}:${entry.id}`;
  }
  return entry.id;
}

function resolveExpectedChatId(
  source: string,
  config?: ReconcileDeliveryOptions["config"],
): string | undefined {
  if (!config) return undefined;
  const defaultChat = config.chatId ?? config.chatIds?.[0] ?? "";
  const chosen =
    source === "market"
      ? config.marketChatId || defaultChat
      : source === "squad"
        ? config.squadChatId || defaultChat
        : defaultChat;
  return chosen ? String(chosen) : undefined;
}

/**
 * Read a `MessageIndex` JSON file strictly offline without mutating, renaming,
 * or quarantining the underlying file on disk.
 */
export async function readMessageIndexSnapshot(
  filePath: string,
  secrets?: readonly string[],
): Promise<MessageIndexSnapshot> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing", entries: [], invalidEntries: 0 };
    }
    return {
      status: "corrupt",
      entries: [],
      invalidEntries: 0,
      error: redactError(err, { ...(secrets ? { secrets } : {}), maxLen: 200 }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "corrupt",
      entries: [],
      invalidEntries: 0,
      error: `invalid JSON: ${redactError(err, { ...(secrets ? { secrets } : {}), maxLen: 180 })}`,
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== MESSAGE_INDEX_SCHEMA_VERSION ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    return {
      status: "corrupt",
      entries: [],
      invalidEntries: 0,
      error: "schema validation failed: expected version 1 with entries array",
    };
  }

  const deduped = new Map<string, MessageIndexFileEntry>();
  let invalidEntries = 0;
  for (const item of (parsed as { entries: unknown[] }).entries) {
    if (
      item &&
      typeof item === "object" &&
      isValidChatId((item as MessageIndexFileEntry).chatId) &&
      isValidRef((item as MessageIndexFileEntry).ref) &&
      isValidMessageId((item as MessageIndexFileEntry).messageId)
    ) {
      const typed = item as MessageIndexFileEntry;
      const key = `${String(typed.chatId)}:::${typed.ref}`;
      if (deduped.has(key)) deduped.delete(key);
      deduped.set(key, {
        chatId: typed.chatId,
        ref: typed.ref,
        messageId: typed.messageId,
      });
    } else {
      invalidEntries += 1;
    }
  }

  return {
    status: "ok",
    entries: Array.from(deduped.values()),
    invalidEntries,
  };
}

const ALL_INCONSISTENCY_KINDS: readonly DeliveryInconsistencyKind[] = [
  "pending_with_index_record",
  "pending_without_index_record",
  "done_missing_index_record",
  "orphan_done_without_intent",
  "message_id_mismatch",
  "route_chat_mismatch",
  "index_without_journal_record",
];

/**
 * Compare send-journal entries with `message-index` records strictly offline:
 * makes zero Telegram/network calls and never mutates either state file.
 */
export async function reconcileDeliveryState(
  options: ReconcileDeliveryOptions = {},
): Promise<DeliveryReconciliationReport> {
  const clock = options.now ?? Date.now;
  const includeUnmatchedIndex = options.includeUnmatchedIndex ?? true;

  const journalSnap =
    options.journalEntries !== undefined
      ? {
          status: "ok" as const,
          entries: [...options.journalEntries],
          corruptLines: 0,
          bytes: 0,
        }
      : options.journalFilePath
        ? await readSendJournalSnapshot(options.journalFilePath)
        : { status: "missing" as const, entries: [], corruptLines: 0, bytes: 0 };

  const indexSnap: MessageIndexSnapshot =
    options.indexEntries !== undefined
      ? {
          status: "ok",
          entries: [...options.indexEntries],
          invalidEntries: 0,
        }
      : options.indexFilePath
        ? await readMessageIndexSnapshot(options.indexFilePath, options.secrets)
        : { status: "missing", entries: [], invalidEntries: 0 };

  const intentsById = new Map<string, JournalEntry>();
  const doneById = new Map<string, JournalEntry>();
  let intentCount = 0;
  let doneCount = 0;

  for (const entry of journalSnap.entries) {
    if (entry.kind === "intent") {
      intentCount += 1;
      intentsById.set(entry.id, entry);
    } else if (entry.kind === "done") {
      doneCount += 1;
      doneById.set(entry.id, entry);
    }
  }

  // Group valid message-index entries by `ref`.
  const indexByRef = new Map<string, MessageIndexFileEntry[]>();
  for (const record of indexSnap.entries) {
    const bucket = indexByRef.get(record.ref) ?? [];
    bucket.push(record);
    indexByRef.set(record.ref, bucket);
  }

  const matchedIndexKeys = new Set<string>();
  const inconsistencies: DeliveryInconsistency[] = [];
  let consistentCount = 0;

  for (const [id, intent] of intentsById.entries()) {
    const ref = deriveJournalEventRef(intent);
    const done = doneById.get(id);
    const expectedChat = resolveExpectedChatId(intent.source, options.config);
    const candidates = indexByRef.get(ref) ?? [];

    let matchedRecord: MessageIndexFileEntry | undefined;
    if (expectedChat !== undefined) {
      matchedRecord = candidates.find((c) => String(c.chatId) === expectedChat);
    } else {
      matchedRecord = candidates[0];
    }

    if (matchedRecord) {
      matchedIndexKeys.add(`${String(matchedRecord.chatId)}:::${matchedRecord.ref}`);
    } else if (candidates.length > 0) {
      for (const c of candidates) {
        matchedIndexKeys.add(`${String(c.chatId)}:::${c.ref}`);
      }
    }

    if (!done) {
      const anyRecord = matchedRecord ?? candidates[0];
      if (anyRecord) {
        inconsistencies.push({
          kind: "pending_with_index_record",
          id,
          ref,
          source: intent.source,
          ledger: intent.ledger,
          eventName: intent.eventName,
          indexMessageId: anyRecord.messageId,
          actualDestinationHash: fingerprintDestination(anyRecord.chatId),
          detail:
            `unresolved journal intent already has message-index record ` +
            `(message_id=${anyRecord.messageId})`,
        });
      } else {
        inconsistencies.push({
          kind: "pending_without_index_record",
          id,
          ref,
          source: intent.source,
          ledger: intent.ledger,
          eventName: intent.eventName,
          ...(expectedChat ? { expectedDestinationHash: fingerprintDestination(expectedChat) } : {}),
          detail: "unresolved journal intent has no matching message-index record",
        });
      }
      continue;
    }

    // Settled (`intent` + `done`) entry: verify against message-index.
    if (!matchedRecord && candidates.length > 0 && expectedChat !== undefined) {
      const wrongChatRecord = candidates[0]!;
      inconsistencies.push({
        kind: "route_chat_mismatch",
        id,
        ref,
        source: intent.source,
        ledger: intent.ledger,
        eventName: intent.eventName,
        indexMessageId: wrongChatRecord.messageId,
        expectedDestinationHash: fingerprintDestination(expectedChat),
        actualDestinationHash: fingerprintDestination(wrongChatRecord.chatId),
        detail: "journal route destination does not match message-index chat destination",
      });
      continue;
    }

    if (!matchedRecord) {
      inconsistencies.push({
        kind: "done_missing_index_record",
        id,
        ref,
        source: intent.source,
        ledger: intent.ledger,
        eventName: intent.eventName,
        ...(done.messageId !== undefined ? { journalMessageId: done.messageId } : {}),
        ...(expectedChat ? { expectedDestinationHash: fingerprintDestination(expectedChat) } : {}),
        detail: "journal entry is marked done but missing from message-index",
      });
      continue;
    }

    if (done.messageId !== undefined && done.messageId !== matchedRecord.messageId) {
      inconsistencies.push({
        kind: "message_id_mismatch",
        id,
        ref,
        source: intent.source,
        ledger: intent.ledger,
        eventName: intent.eventName,
        journalMessageId: done.messageId,
        indexMessageId: matchedRecord.messageId,
        actualDestinationHash: fingerprintDestination(matchedRecord.chatId),
        detail:
          `journal message_id (${done.messageId}) differs from ` +
          `message-index (${matchedRecord.messageId})`,
      });
      continue;
    }

    consistentCount += 1;
  }

  for (const [id, done] of doneById.entries()) {
    if (!intentsById.has(id)) {
      inconsistencies.push({
        kind: "orphan_done_without_intent",
        id,
        ref: id,
        ...(done.messageId !== undefined ? { journalMessageId: done.messageId } : {}),
        detail: "journal contains done marker without a preceding intent entry",
      });
    }
  }

  if (includeUnmatchedIndex) {
    for (const record of indexSnap.entries) {
      const key = `${String(record.chatId)}:::${record.ref}`;
      if (!matchedIndexKeys.has(key)) {
        inconsistencies.push({
          kind: "index_without_journal_record",
          ref: record.ref,
          indexMessageId: record.messageId,
          actualDestinationHash: fingerprintDestination(record.chatId),
          detail: "message-index record has no corresponding entry in the send journal",
        });
      }
    }
  }

  const countsByKind = Object.fromEntries(
    ALL_INCONSISTENCY_KINDS.map((k) => [k, 0]),
  ) as Record<DeliveryInconsistencyKind, number>;
  for (const item of inconsistencies) {
    countsByKind[item.kind] += 1;
  }

  const consistent =
    inconsistencies.length === 0 &&
    journalSnap.corruptLines === 0 &&
    indexSnap.status !== "corrupt" &&
    indexSnap.invalidEntries === 0;

  return {
    generatedAt: new Date(clock()).toISOString(),
    consistent,
    consistentCount,
    journal: {
      status: journalSnap.status,
      totalEntries: journalSnap.entries.length,
      intentCount,
      doneCount,
      corruptLines: journalSnap.corruptLines,
    },
    messageIndex: {
      status: indexSnap.status,
      validEntries: indexSnap.entries.length,
      invalidEntries: indexSnap.invalidEntries,
      ...(indexSnap.error !== undefined ? { error: indexSnap.error } : {}),
    },
    countsByKind,
    inconsistencies,
  };
}

/**
 * Render a human-readable offline reconciliation summary with destination
 * chat IDs fingerprinted (`chat#<8-hex>`) so private chat identifiers are not
 * exposed.
 */
export function formatDeliveryReconciliationReport(
  report: DeliveryReconciliationReport,
): string {
  const lines: string[] = [
    `Delivery Reconciliation Report (${report.generatedAt})`,
    `Status: ${report.consistent ? "CONSISTENT" : "INCONSISTENT"}`,
    `Journal: status=${report.journal.status} intents=${report.journal.intentCount} done=${report.journal.doneCount} corruptLines=${report.journal.corruptLines}`,
    `MessageIndex: status=${report.messageIndex.status} valid=${report.messageIndex.validEntries} invalid=${report.messageIndex.invalidEntries}` +
      (report.messageIndex.error ? ` error="${report.messageIndex.error}"` : ""),
    `Confirmed consistent pairs: ${report.consistentCount}`,
    `Inconsistencies (${report.inconsistencies.length}):`,
  ];

  if (report.inconsistencies.length === 0) {
    lines.push("  none");
  } else {
    for (const inc of report.inconsistencies) {
      const dest = inc.actualDestinationHash ?? inc.expectedDestinationHash ?? "n/a";
      lines.push(
        `  - [${inc.kind}] ref=${inc.ref}${inc.id ? ` id=${inc.id}` : ""} dest=${dest}: ${inc.detail}`,
      );
    }
  }

  return lines.join("\n");
}

// ── isMarkdownParseError ─────────────────────────────────────────────────────

/**
 * True when a Telegram send failed because the message text could not be
 * parsed as MarkdownV2 entities.
 *
 * grammy (1.x) surfaces Bot API failures as `GrammyError` with `error_code`
 * and `description` straight from Telegram, e.g. error 400 with
 * `"Bad Request: can't parse entities: …"` or `"… can't find end of the
 * entity …"`. The classifier matches that shape — error 400 plus the
 * entity-parse phrasing — so rate limits (429), auth failures (401), chat
 * errors, and network `HttpError`s never qualify. Duck-typed errors carrying
 * the same Telegram description (mocks, wrapped rejections) match on the
 * phrasing alone when no numeric `error_code` is present.
 */
export function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  if (!/can't parse entities|can't find end of the entity/i.test(text)) return false;
  if (typeof record.error_code === "number") return record.error_code === 400;
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Bounded log fragment identifying which event a fallback send belongs to. */
function eventRefLabel(eventRef: SendExtra["eventRef"]): string {
  if (!eventRef) return "";
  const parts: string[] = [];
  if (typeof eventRef.source === "string" && eventRef.source) parts.push(eventRef.source);
  if (typeof eventRef.ledger === "number" && Number.isFinite(eventRef.ledger)) {
    parts.push(`ledger ${eventRef.ledger}`);
  }
  if (typeof eventRef.eventId === "string" && eventRef.eventId) parts.push(eventRef.eventId);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

// ── notifierSkips ────────────────────────────────────────────────────────────

/**
 * Sends suppressed by the empty-message guard, counted so callers (and the
 * empty-text tests) can prove a blank render never reached the Telegram API.
 */
export const notifierSkips = { emptyText: 0 };

// ── createNotifier ───────────────────────────────────────────────────────────

/**
 * The poller's send path: route each contract's messages to its named chat,
 * with the event's explorer button when `extra.reply_markup` is set.
 *
 * MarkdownV2 first; exactly one plain-text retry when Telegram rejects the
 * entities *and* the caller supplied a non-blank `extra.plainText`. The retry
 * carries no `parse_mode`, so it cannot fail the same way. Every other failure —
 * network, rate limit, auth, unknown chats, or a failed plain-text retry —
 * propagates unchanged, preserving the poller's existing error/cursor
 * accounting. An oversized payload is split into chunks and an
 * unspecified one into a single call, so the MarkdownV2-to-plain-text
 * retry happens at most once per chunk, never in a loop.
 *
 * A rendering that is empty, whitespace-only, or not a string at all is
 * skipped before any API call: Telegram rejects blank message text with a
 * 400, and a formatters' `null` must never turn into a doomed send. The skip
 * is counted in {@link notifierSkips} and logged with bounded metadata.
 */
export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<Pick<BotConfig, "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents">>,
) {
  return async (
    text: string | null,
    source?: ContractSource,
    extra?: SendExtra,
  ): Promise<void> => {
    if (typeof text !== "string" || text.trim() === "") {
      notifierSkips.emptyText += 1;
      // Only bounded metadata: which chat path and how short the render was —
      // never the payload itself.
      console.warn(
        `[notifier] skipped empty message${eventRefLabel(extra?.eventRef)} ` +
          `(source=${typeof source === "string" && source ? source.slice(0, 32) : "default"}, ` +
          `chars=${typeof text === "string" ? text.length : -1})`,
      );
      return;
    }

    const defaultChat = config.chatId ?? config.chatIds?.[0] ?? "";
    const chatId = source === "market"
      ? config.marketChatId || defaultChat
      : source === "squad"
        ? config.squadChatId || defaultChat
        : defaultChat;

    // Select link preview settings based on the contract source.
    // Commands (where source is undefined) always use TELEGRAM_OPTIONS (disabled).
    const linkPreviewDisabled = source === "market"
      ? !config.linkPreviewMarket
      : source === "squad"
        ? !config.linkPreviewSquad
        : true;

    const silentOption = extra?.eventName && isSilent(extra.eventName, config.silentEvents ?? DEFAULT_SILENT_EVENTS)
      ? { disable_notification: true }
      : {};
    const notificationOptions = {
      parse_mode: "MarkdownV2" as const,
      link_preview_options: { is_disabled: linkPreviewDisabled },
      ...silentOption,
    };

    // Oversized payloads go out as ordered chunks under Telegram's limit. The
    // thread reply rides on the first chunk and the explorer button on the
    // last, so the message reads exactly like the unsplit one.
    const parts = splitTelegramMessage(text);
    if (parts.length > 1) {
      for (const [index, part] of parts.entries()) {
        await bot.api.sendMessage(chatId, part, {
          ...notificationOptions,
          ...(index === parts.length - 1 && extra?.reply_markup
            ? { reply_markup: extra.reply_markup }
            : {}),
          ...(index === 0 && extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        });
      }
      return;
    }

    try {
      await bot.api.sendMessage(chatId, text, {
        ...notificationOptions,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
      return;
    } catch (err) {
      // A blank fallback is no fallback: sending whitespace-only text would
      // just draw the same 400, so the original parse error propagates.
      const fallback = extra?.plainText;
      if (typeof fallback !== "string" || fallback.trim() === "" || !isMarkdownParseError(err)) {
        throw err;
      }
      // Only bounded metadata is logged: the fallback outcome, the safe error
      // category, and the caller-supplied event reference — never message
      // text, tokens, or remote payloads.
      console.warn(
        `[notifier] MarkdownV2 rejected${eventRefLabel(extra?.eventRef)}, ` +
          `retrying as plain text: ${safeErrorMessage(
            err,
            typeof config.botToken === "string" ? [config.botToken] : [],
          )}`,
      );
      // Plain text (no parse mode), same per-source link preview setting.
      await bot.api.sendMessage(chatId, fallback, {
        link_preview_options: notificationOptions.link_preview_options,
        ...silentOption,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
    }
  };
}
