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
 */

import { createHash } from "node:crypto";
import type { Bot } from "grammy";

import type { BotConfig } from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import type { SendJournal } from "./send-journal.js";

// ── SendExtra ────────────────────────────────────────────────────────────────

/** A Telegram destination: a chat id plus an optional forum topic (thread) id. */
export interface NotificationDestination {
  chatId: string;
  topicId?: number | undefined;
}

/** Optional dependencies for {@link createNotifier}. */
export interface NotifierOptions {
  /** Optional send journal for persisting per-destination delivery outcomes. */
  sendJournal?: SendJournal | undefined;
  /** Clock override for journal timestamps (defaults to `Date.now`). */
  now?: (() => number) | undefined;
}

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
  /** Optional Telegram forum topic id (`message_thread_id`) for single-route sends. */
  topicId?: number | undefined;
  /** Optional explicit list of destinations (each with chatId and optional topicId). */
  destinations?: readonly NotificationDestination[] | undefined;
  /**
   * When true and a `sendJournal` is attached, only send to destinations that
   * have an unresolved intent in the journal for `eventRef.eventId`.
   */
  recoverOnly?: boolean | undefined;
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
function destinationKey(chatId: string, topicId?: number): string {
  return `${chatId}\0${topicId !== undefined ? String(topicId) : ""}`;
}

export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<Pick<BotConfig, "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents">>,
  options?: NotifierOptions,
) {
  const sendJournal = options?.sendJournal;
  const now = options?.now ?? Date.now;

  async function sendToDestination(
    dest: NotificationDestination,
    text: string,
    notificationOptions: {
      parse_mode: "MarkdownV2";
      link_preview_options: { is_disabled: boolean };
      disable_notification?: boolean;
    },
    silentOption: { disable_notification?: boolean },
    extra?: SendExtra,
  ): Promise<void> {
    const { chatId, topicId } = dest;
    const threadOption = topicId !== undefined ? { message_thread_id: topicId } : {};

    // Oversized payloads go out as ordered chunks under Telegram's limit. The
    // thread reply rides on the first chunk and the explorer button on the
    // last, so the message reads exactly like the unsplit one.
    const parts = splitTelegramMessage(text);
    if (parts.length > 1) {
      for (const [index, part] of parts.entries()) {
        await bot.api.sendMessage(chatId, part, {
          ...notificationOptions,
          ...threadOption,
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
        ...threadOption,
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
        ...threadOption,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
    }
  }

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
    const defaultChatId = source === "market"
      ? config.marketChatId || defaultChat
      : source === "squad"
        ? config.squadChatId || defaultChat
        : defaultChat;

    const rawDestinations: readonly NotificationDestination[] =
      extra?.destinations && extra.destinations.length > 0
        ? extra.destinations
        : [{ chatId: defaultChatId, topicId: extra?.topicId }];

    // Deduplicate destinations by (chatId, topicId) while preserving order.
    const seen = new Set<string>();
    let destinations: NotificationDestination[] = [];
    for (const dest of rawDestinations) {
      const key = destinationKey(dest.chatId, dest.topicId);
      if (seen.has(key)) continue;
      seen.add(key);
      destinations.push(dest);
    }

    const eventId = extra?.eventRef?.eventId;
    if (sendJournal && extra?.recoverOnly && eventId) {
      const pending = await sendJournal.loadPendingForEvent(eventId);
      const pendingKeys = new Set(
        pending.map((entry) => destinationKey(entry.chatId ?? "", entry.topicId)),
      );
      destinations = destinations.filter((dest) =>
        pendingKeys.has(destinationKey(dest.chatId, dest.topicId)),
      );
      if (destinations.length === 0) return;
    }

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

    if (sendJournal && eventId && !extra?.recoverOnly) {
      const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      const ledger = extra?.eventRef?.ledger ?? 0;
      const eventName = extra?.eventName ?? "";
      const eventSource = source ?? extra?.eventRef?.source ?? "";
      const at = now();
      for (const dest of destinations) {
        try {
          await sendJournal.recordIntent({
            id: eventId,
            source: eventSource,
            ledger,
            eventName,
            chatId: dest.chatId,
            ...(dest.topicId !== undefined ? { topicId: dest.topicId } : {}),
            textHash,
            at,
          });
        } catch (err) {
          console.error(
            `[notifier] send journal intent failed for ${eventId}: ${safeErrorMessage(
              err,
              typeof config.botToken === "string" ? [config.botToken] : [],
            )}`,
          );
        }
      }
    }

    let firstError: unknown;
    for (const dest of destinations) {
      try {
        await sendToDestination(dest, text, notificationOptions, silentOption, extra);
        if (sendJournal && eventId) {
          try {
            await sendJournal.recordDone(eventId, dest, "sent");
          } catch (err) {
            console.error(
              `[notifier] send journal done failed for ${eventId}: ${safeErrorMessage(
                err,
                typeof config.botToken === "string" ? [config.botToken] : [],
              )}`,
            );
          }
        }
      } catch (err) {
        if (sendJournal && eventId) {
          try {
            await sendJournal.recordDone(eventId, dest, "failed");
          } catch (journalErr) {
            console.error(
              `[notifier] send journal done failed for ${eventId}: ${safeErrorMessage(
                journalErr,
                typeof config.botToken === "string" ? [config.botToken] : [],
              )}`,
            );
          }
        }
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
}
