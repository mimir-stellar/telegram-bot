/**
 * Outbound notification sending: the poller's one path to Telegram.
 *
 * Extracted from `src/bot.ts` so notification-send changes and
 * command-handling changes no longer touch the same file.
 *
 * Public API (all re-exported from `src/bot.ts` for backwards compatibility):
 *   - {@link SendExtra}                   — extra options a caller attaches to a send
 *   - {@link SendLimiter}                 — bounded global concurrency limiter
 *   - {@link SendLimiterClosedError}      — error thrown when limiter is shut down
 *   - {@link DEFAULT_MAX_CONCURRENT_SENDS} — default global send concurrency cap
 *   - {@link createSendLimiter}           — factory for a shared send limiter
 *   - {@link isMarkdownParseError}        — classifier for Telegram entity-parse failures
 *   - {@link notifierSkips}               — counters for suppressed sends
 *   - {@link createNotifier}              — factory that returns the poller's send function
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

// ── SendLimiter ──────────────────────────────────────────────────────────────

/** Default maximum number of concurrent outbound Telegram `sendMessage` calls. */
export const DEFAULT_MAX_CONCURRENT_SENDS = 4;

export type SendLimiterShutdownMode = "drain" | "cancel";

/**
 * Thrown when a send is rejected because the {@link SendLimiter} was shut down
 * (either newly submitted after shutdown or cancelled while queued).
 */
export class SendLimiterClosedError extends Error {
  readonly mode: SendLimiterShutdownMode;

  constructor(mode: SendLimiterShutdownMode = "drain") {
    super(
      mode === "cancel"
        ? "Telegram send limiter shut down (pending sends cancelled)"
        : "Telegram send limiter is shutting down",
    );
    this.name = "SendLimiterClosedError";
    this.mode = mode;
  }
}

export interface SendLimiterOptions {
  /** Maximum number of concurrent `sendMessage` calls across all routes. */
  maxConcurrent?: number | undefined;
}

export interface SendLimiterStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  closed: boolean;
}

export interface SendLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  shutdown(mode?: SendLimiterShutdownMode): Promise<void>;
  stats(): SendLimiterStats;
}

/**
 * Bounded global concurrency limiter shared across all Telegram destination routes.
 *
 * `shutdown("drain")` stops accepting new work and waits for queued + in-flight
 * sends to finish. `shutdown("cancel")` stops accepting new work, immediately
 * rejects all queued sends with {@link SendLimiterClosedError}, and waits for
 * in-flight sends to settle.
 */
export function createSendLimiter(options?: SendLimiterOptions): SendLimiter {
  const maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SENDS;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `maxConcurrent must be a positive integer, got ${String(maxConcurrent)}`,
    );
  }

  let active = 0;
  let closed = false;
  const queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const idleResolvers: Array<() => void> = [];

  function notifyIdleIfDone(): void {
    if (active === 0 && queue.length === 0 && idleResolvers.length > 0) {
      const resolvers = idleResolvers.splice(0, idleResolvers.length);
      for (const resolve of resolvers) resolve();
    }
  }

  function startTask(
    fn: () => Promise<unknown>,
    resolve: (value: unknown) => void,
    reject: (reason?: unknown) => void,
  ): void {
    active += 1;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        const next = queue.shift();
        if (next) {
          startTask(next.fn, next.resolve, next.reject);
        } else {
          notifyIdleIfDone();
        }
      });
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) {
      return Promise.reject(new SendLimiterClosedError("drain"));
    }
    return new Promise<T>((resolve, reject) => {
      if (active < maxConcurrent) {
        startTask(
          fn as () => Promise<unknown>,
          resolve as (value: unknown) => void,
          reject,
        );
      } else {
        queue.push({
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      }
    });
  }

  function shutdown(mode: SendLimiterShutdownMode = "drain"): Promise<void> {
    closed = true;
    if (mode === "cancel" && queue.length > 0) {
      const cancelled = queue.splice(0, queue.length);
      for (const item of cancelled) {
        item.reject(new SendLimiterClosedError("cancel"));
      }
    }
    if (active === 0 && queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  function stats(): SendLimiterStats {
    return { active, queued: queue.length, maxConcurrent, closed };
  }

  return { run, shutdown, stats };
}

export interface NotifierOptions {
  /** Shared limiter across destination routes (defaults to a fresh limiter per notifier). */
  limiter?: SendLimiter | undefined;
  /** Maximum concurrent sends when creating a default limiter. */
  maxConcurrentSends?: number | undefined;
}

export type Notifier = ((
  text: string | null,
  source?: ContractSource,
  extra?: SendExtra,
) => Promise<void>) & {
  limiter: SendLimiter;
  shutdown: (mode?: SendLimiterShutdownMode) => Promise<void>;
};

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
): Notifier {
  const limiter =
    options?.limiter ?? createSendLimiter({ maxConcurrent: options?.maxConcurrentSends });

  const notify = async (
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
        await limiter.run(() =>
          bot.api.sendMessage(chatId, part, {
            ...notificationOptions,
            ...(index === parts.length - 1 && extra?.reply_markup
              ? { reply_markup: extra.reply_markup }
              : {}),
            ...(index === 0 && extra?.replyToMessageId !== undefined
              ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
              : {}),
          }),
        );
      }
      return;
    }

    try {
      await limiter.run(() =>
        bot.api.sendMessage(chatId, text, {
          ...notificationOptions,
          ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
          ...(extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        }),
      );
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
      await limiter.run(() =>
        bot.api.sendMessage(chatId, fallback, {
          link_preview_options: notificationOptions.link_preview_options,
          ...silentOption,
          ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
          ...(extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        }),
      );
    }
  };

  return Object.assign(notify, {
    limiter,
    shutdown: (mode?: SendLimiterShutdownMode) => limiter.shutdown(mode),
  });
}
