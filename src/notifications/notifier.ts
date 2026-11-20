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

import type { Bot } from "grammy";

import type { BotConfig } from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import { retryDelayMs, type SendJournal } from "./send-journal.js";

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

// ── NotifierOptions ──────────────────────────────────────────────────────────

const DEFAULT_NOTIFIER_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_NOTIFIER_MAX_BACKOFF_MS = 60_000;

/**
 * Optional persistent retry scheduling for {@link createNotifier}.
 *
 * When configured, failed sends persist their next eligible attempt timestamp
 * (`nextAttemptAt`) to the send journal, and a restarted notifier hydrates
 * pending timestamps before sending so pending deliveries honour their
 * remaining backoff instead of bursting immediately on restart.
 */
export interface NotifierRetryOptions {
  journal: SendJournal;
  /** Clock used to compute and evaluate `nextAttemptAt` (defaults to `Date.now`). */
  now?: () => number;
  /** Sleep function used to wait until a persisted `nextAttemptAt` (defaults to `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Initial backoff in ms when a failure has no `retry_after` hint (default: 1000). */
  initialBackoffMs?: number;
  /** Maximum backoff cap in ms (default: 60_000). */
  maxBackoffMs?: number;
}

/** Optional extensions for {@link createNotifier}. */
export interface NotifierOptions {
  retry?: NotifierRetryOptions | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const params = (err as { parameters?: { retry_after?: unknown } }).parameters;
  if (params && typeof params.retry_after === "number" && Number.isFinite(params.retry_after) && params.retry_after > 0) {
    return Math.ceil(params.retry_after * 1_000);
  }
  return null;
}

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
  options?: NotifierOptions,
) {
  const retry = options?.retry;
  const retryNow = retry?.now ?? Date.now;
  const retrySleep = retry?.sleep ?? defaultSleep;
  const initialBackoffMs = Math.max(0, retry?.initialBackoffMs ?? DEFAULT_NOTIFIER_INITIAL_BACKOFF_MS);
  const maxBackoffMs = Math.max(initialBackoffMs, retry?.maxBackoffMs ?? DEFAULT_NOTIFIER_MAX_BACKOFF_MS);
  const scheduledRetries = new Map<string, { nextAttemptAt: number; attempts: number }>();
  let retryStateLoaded = false;

  async function ensureRetryStateLoaded(): Promise<void> {
    if (!retry || retryStateLoaded) return;
    retryStateLoaded = true;
    try {
      for (const entry of await retry.journal.loadPending()) {
        if (typeof entry.nextAttemptAt === "number" && Number.isFinite(entry.nextAttemptAt)) {
          scheduledRetries.set(entry.id, {
            nextAttemptAt: entry.nextAttemptAt,
            attempts: typeof entry.attempts === "number" && Number.isFinite(entry.attempts) ? entry.attempts : 1,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[notifier] failed to load persisted retry schedule: ${safeErrorMessage(
          err,
          typeof config.botToken === "string" ? [config.botToken] : [],
        )}`,
      );
    }
  }

  async function recordRetryFailure(eventId: string | undefined, err: unknown): Promise<void> {
    if (!retry || !eventId) return;
    const prevAttempts = scheduledRetries.get(eventId)?.attempts ?? 0;
    const retryAfterMs = extractRetryAfterMs(err);
    const delayMs =
      retryAfterMs !== null
        ? retryAfterMs
        : Math.min(initialBackoffMs * 2 ** prevAttempts, maxBackoffMs);
    const nextAttemptAt = retryNow() + delayMs;
    const attempts = prevAttempts + 1;
    scheduledRetries.set(eventId, { nextAttemptAt, attempts });
    try {
      await retry.journal.recordRetry(eventId, nextAttemptAt, attempts);
    } catch (journalErr) {
      console.warn(
        `[notifier] failed to persist retry schedule for ${eventId}: ${safeErrorMessage(
          journalErr,
          typeof config.botToken === "string" ? [config.botToken] : [],
        )}`,
      );
    }
  }

  async function clearRetrySuccess(eventId: string | undefined): Promise<void> {
    if (!retry || !eventId || !scheduledRetries.has(eventId)) return;
    scheduledRetries.delete(eventId);
    try {
      await retry.journal.recordDone(eventId);
    } catch (journalErr) {
      console.warn(
        `[notifier] failed to clear retry schedule for ${eventId}: ${safeErrorMessage(
          journalErr,
          typeof config.botToken === "string" ? [config.botToken] : [],
        )}`,
      );
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

    const eventId =
      typeof extra?.eventRef?.eventId === "string" && extra.eventRef.eventId.length > 0
        ? extra.eventRef.eventId
        : undefined;

    if (retry && eventId) {
      await ensureRetryStateLoaded();
      const scheduled = scheduledRetries.get(eventId);
      if (scheduled) {
        const waitMs = retryDelayMs(scheduled.nextAttemptAt, retryNow());
        if (waitMs > 0) {
          await retrySleep(waitMs);
        }
      }
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
      try {
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
        await clearRetrySuccess(eventId);
        return;
      } catch (err) {
        await recordRetryFailure(eventId, err);
        throw err;
      }
    }

    try {
      await bot.api.sendMessage(chatId, text, {
        ...notificationOptions,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(extra?.replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
          : {}),
      });
      await clearRetrySuccess(eventId);
      return;
    } catch (err) {
      // A blank fallback is no fallback: sending whitespace-only text would
      // just draw the same 400, so the original parse error propagates.
      const fallback = extra?.plainText;
      if (typeof fallback !== "string" || fallback.trim() === "" || !isMarkdownParseError(err)) {
        await recordRetryFailure(eventId, err);
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
      try {
        await bot.api.sendMessage(chatId, fallback, {
          link_preview_options: notificationOptions.link_preview_options,
          ...silentOption,
          ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
          ...(extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        });
        await clearRetrySuccess(eventId);
      } catch (fallbackErr) {
        await recordRetryFailure(eventId, fallbackErr);
        throw fallbackErr;
      }
    }
  };
}
