/**
 * Outbound notification sending: the poller's one path to Telegram.
 *
 * Extracted from `src/bot.ts` so notification-send changes and
 * command-handling changes no longer touch the same file.
 *
 * Public API (all re-exported from `src/bot.ts` for backwards compatibility):
 *   - {@link SendExtra}         — extra options a caller attaches to a send
 *   - {@link NotifierOptions}   — shared limiter and send-journal options
 *   - {@link createTelegramSendLimiter} — bounded global Telegram send limiter
 *   - {@link TelegramSendLimiterCancelledError} — deterministic cancel/drain error
 *   - {@link isMarkdownParseError} — classifier for Telegram entity-parse failures
 *   - {@link notifierSkips}    — counters for suppressed sends
 *   - {@link createNotifier}   — factory that returns the poller's send function
 */

import type { Bot } from "grammy";

import {
  DEFAULT_TELEGRAM_MAX_CONCURRENT_SENDS,
  MAX_TELEGRAM_MAX_CONCURRENT_SENDS,
  type BotConfig,
} from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import type { SendJournal } from "./send-journal.js";

export {
  DEFAULT_TELEGRAM_MAX_CONCURRENT_SENDS,
  MAX_TELEGRAM_MAX_CONCURRENT_SENDS,
};
export const MIN_TELEGRAM_MAX_CONCURRENT_SENDS = 1;
export const DEFAULT_TELEGRAM_SEND_MAX_QUEUE = 1_000;

// ── Global Telegram Send Concurrency Limiter ─────────────────────────────────

export type TelegramSendLimiterState = "open" | "draining" | "cancelled";

export class TelegramSendLimiterCancelledError extends Error {
  readonly code: "TELEGRAM_SEND_CANCELLED" | "TELEGRAM_SEND_DRAINING" | "TELEGRAM_SEND_QUEUE_FULL";
  readonly reason: string;
  /** True only when the task was rejected before `sendMessage` ever started. */
  readonly beforeSend = true;

  constructor(
    message: string,
    code: "TELEGRAM_SEND_CANCELLED" | "TELEGRAM_SEND_DRAINING" | "TELEGRAM_SEND_QUEUE_FULL",
    reason: string = code,
  ) {
    super(message);
    this.name = "TelegramSendLimiterCancelledError";
    this.code = code;
    this.reason = reason;
  }
}

export interface TelegramSendLimiterOptions {
  /** Maximum concurrent in-flight Telegram API sends across all routes (`1..32`). */
  maxConcurrent?: number;
  /** Maximum queued sends awaiting a slot (defaults to `1000`). */
  maxQueueSize?: number;
}

export interface TelegramSendLimiterStats {
  maxConcurrent: number;
  maxQueueSize: number;
  active: number;
  peakActive: number;
  queued: number;
  completed: number;
  cancelled: number;
  state: TelegramSendLimiterState;
}

export interface TelegramSendCancelResult {
  cancelled: number;
  active: number;
}

export interface TelegramSendDrainResult {
  drained: boolean;
  cancelledQueued: number;
  remainingActive: number;
}

export interface TelegramSendLimiter {
  readonly maxConcurrent: number;
  run<T>(task: () => Promise<T>, meta?: { route?: string }): Promise<T>;
  drain(options?: { timeoutMs?: number }): Promise<TelegramSendDrainResult>;
  cancelPending(reason?: string): TelegramSendCancelResult;
  shutdown(options?: {
    mode?: "drain" | "cancel";
    timeoutMs?: number;
    reason?: string;
  }): Promise<TelegramSendDrainResult>;
  stats(): TelegramSendLimiterStats;
}

interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Bounded FIFO concurrency limiter shared across all Telegram destination
 * routes (`market`, `squad`, `default`, multi-chat, and operator messages),
 * with deterministic shutdown `drain()` and `cancelPending()` controls.
 */
export function createTelegramSendLimiter(
  options: TelegramSendLimiterOptions = {},
): TelegramSendLimiter {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_TELEGRAM_MAX_CONCURRENT_SENDS;
  if (
    typeof maxConcurrent !== "number" ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < MIN_TELEGRAM_MAX_CONCURRENT_SENDS ||
    maxConcurrent > MAX_TELEGRAM_MAX_CONCURRENT_SENDS
  ) {
    throw new RangeError(
      `maxConcurrent must be an integer in ${MIN_TELEGRAM_MAX_CONCURRENT_SENDS}..${MAX_TELEGRAM_MAX_CONCURRENT_SENDS}, got ${String(maxConcurrent)}`,
    );
  }

  const maxQueueSize = options.maxQueueSize ?? DEFAULT_TELEGRAM_SEND_MAX_QUEUE;
  if (typeof maxQueueSize !== "number" || !Number.isInteger(maxQueueSize) || maxQueueSize < 0) {
    throw new RangeError(`maxQueueSize must be a non-negative integer, got ${String(maxQueueSize)}`);
  }

  let active = 0;
  let peakActive = 0;
  let completed = 0;
  let cancelled = 0;
  let state: TelegramSendLimiterState = "open";

  const queue: QueuedTask<unknown>[] = [];
  const idleListeners = new Set<() => void>();

  function notifyIfIdle(): void {
    if (active === 0 && queue.length === 0) {
      for (const listener of [...idleListeners]) {
        idleListeners.delete(listener);
        listener();
      }
    }
  }

  function waitForIdle(): Promise<void> {
    if (active === 0 && queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleListeners.add(resolve);
    });
  }

  function startNext(): void {
    while (state !== "cancelled" && active < maxConcurrent && queue.length > 0) {
      const next = queue.shift()!;
      executeSlot(next.task, next.resolve, next.reject);
    }
    notifyIfIdle();
  }

  function executeSlot<T>(
    task: () => Promise<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): void {
    active += 1;
    if (active > peakActive) peakActive = active;

    Promise.resolve()
      .then(task)
      .then(
        (val) => {
          active -= 1;
          completed += 1;
          resolve(val);
          startNext();
        },
        (err) => {
          active -= 1;
          completed += 1;
          reject(err);
          startNext();
        },
      );
  }

  function run<T>(task: () => Promise<T>): Promise<T> {
    if (state === "draining") {
      cancelled += 1;
      return Promise.reject(
        new TelegramSendLimiterCancelledError(
          "Telegram send rejected because limiter is draining for shutdown",
          "TELEGRAM_SEND_DRAINING",
          "draining",
        ),
      );
    }
    if (state === "cancelled") {
      cancelled += 1;
      return Promise.reject(
        new TelegramSendLimiterCancelledError(
          "Telegram send rejected because limiter was cancelled",
          "TELEGRAM_SEND_CANCELLED",
          "cancelled",
        ),
      );
    }

    if (active < maxConcurrent) {
      return new Promise<T>((resolve, reject) => {
        executeSlot(task, resolve, reject);
      });
    }

    if (queue.length >= maxQueueSize) {
      cancelled += 1;
      return Promise.reject(
        new TelegramSendLimiterCancelledError(
          `Telegram send queue capacity (${maxQueueSize}) exceeded`,
          "TELEGRAM_SEND_QUEUE_FULL",
          "queue_full",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  function cancelPending(reason: string = "shutdown_cancel"): TelegramSendCancelResult {
    state = "cancelled";
    const rejectedCount = queue.length;
    while (queue.length > 0) {
      const pending = queue.shift()!;
      cancelled += 1;
      pending.reject(
        new TelegramSendLimiterCancelledError(
          `Queued Telegram send cancelled (${reason})`,
          "TELEGRAM_SEND_CANCELLED",
          reason,
        ),
      );
    }
    notifyIfIdle();
    return { cancelled: rejectedCount, active };
  }

  async function drain(options?: { timeoutMs?: number }): Promise<TelegramSendDrainResult> {
    if (state === "open") {
      state = "draining";
    }
    if (active === 0 && queue.length === 0) {
      return { drained: true, cancelledQueued: 0, remainingActive: 0 };
    }

    const timeoutMs = options?.timeoutMs;
    if (timeoutMs === undefined) {
      await waitForIdle();
      return { drained: true, cancelledQueued: 0, remainingActive: 0 };
    }

    const boundedMs = Math.max(0, timeoutMs);
    if (boundedMs === 0) {
      const res = cancelPending("drain_timeout");
      return {
        drained: res.active === 0 && res.cancelled === 0,
        cancelledQueued: res.cancelled,
        remainingActive: res.active,
      };
    }

    let timer: NodeJS.Timeout | undefined;
    const idlePromise = waitForIdle().then(() => true);
    const timeoutPromise = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), boundedMs);
      timer.unref?.();
    });

    const finishedInTime = await Promise.race([idlePromise, timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);

    if (finishedInTime) {
      return { drained: true, cancelledQueued: 0, remainingActive: 0 };
    }

    const cancelRes = cancelPending("drain_timeout");
    return {
      drained: false,
      cancelledQueued: cancelRes.cancelled,
      remainingActive: cancelRes.active,
    };
  }

  async function shutdown(
    shutdownOpts: {
      mode?: "drain" | "cancel";
      timeoutMs?: number;
      reason?: string;
    } = {},
  ): Promise<TelegramSendDrainResult> {
    const mode = shutdownOpts.mode ?? "drain";
    if (mode === "drain") {
      return drain(
        shutdownOpts.timeoutMs !== undefined ? { timeoutMs: shutdownOpts.timeoutMs } : undefined,
      );
    }

    const cancelRes = cancelPending(shutdownOpts.reason ?? "shutdown_cancel");
    if (active === 0) {
      return { drained: true, cancelledQueued: cancelRes.cancelled, remainingActive: 0 };
    }
    if (shutdownOpts.timeoutMs === undefined) {
      await waitForIdle();
      return { drained: true, cancelledQueued: cancelRes.cancelled, remainingActive: 0 };
    }
    const boundedMs = Math.max(0, shutdownOpts.timeoutMs);
    if (boundedMs === 0) {
      return {
        drained: false,
        cancelledQueued: cancelRes.cancelled,
        remainingActive: active,
      };
    }
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      waitForIdle().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return {
      drained: settled,
      cancelledQueued: cancelRes.cancelled,
      remainingActive: active,
    };
  }

  function stats(): TelegramSendLimiterStats {
    return {
      maxConcurrent,
      maxQueueSize,
      active,
      peakActive,
      queued: queue.length,
      completed,
      cancelled,
      state,
    };
  }

  return {
    maxConcurrent,
    run,
    drain,
    cancelPending,
    shutdown,
    stats,
  };
}

// ── SendExtra & NotifierOptions ──────────────────────────────────────────────

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

export interface NotifierOptions {
  /** Shared concurrency limiter across all Telegram routes and callers. */
  limiter?: TelegramSendLimiter | undefined;
  /** Concurrency limit when `createNotifier` constructs its own shared limiter. */
  maxConcurrentSends?: number | undefined;
  /** Optional send journal so pre-send cancellations settle cleanly. */
  sendJournal?: SendJournal | undefined;
}

export type Notifier = ((
  text: string | null,
  source?: ContractSource,
  extra?: SendExtra,
) => Promise<void>) & {
  readonly limiter: TelegramSendLimiter;
  drain: TelegramSendLimiter["drain"];
  cancelPending: TelegramSendLimiter["cancelPending"];
  shutdown: TelegramSendLimiter["shutdown"];
};

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
 * All destination routes (`market`, `squad`, and `default`) share a bounded
 * global concurrency limiter (`options.limiter` or a limiter sized from
 * `config.telegramMaxConcurrentSends`, default `4`). Callers can also share one
 * `TelegramSendLimiter` across multiple notifiers or operator messages and call
 * `drain()` or `cancelPending()` deterministically during shutdown.
 */
export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<
      Pick<
        BotConfig,
        | "chatIds"
        | "linkPreviewMarket"
        | "linkPreviewSquad"
        | "silentEvents"
        | "telegramMaxConcurrentSends"
      >
    >,
  options?: NotifierOptions,
): Notifier {
  const sharedLimiter =
    options?.limiter ??
    createTelegramSendLimiter({
      maxConcurrent:
        options?.maxConcurrentSends ??
        config.telegramMaxConcurrentSends ??
        DEFAULT_TELEGRAM_MAX_CONCURRENT_SENDS,
    });

  const notifyFn = async (
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

    const routeLabel = typeof source === "string" && source ? source : "default";
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

    const runLimitedSend = async (
      chunkIndex: number,
      sendTask: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await sharedLimiter.run(sendTask, { route: routeLabel });
      } catch (err) {
        const eventId = extra?.eventRef?.eventId;
        if (
          err instanceof TelegramSendLimiterCancelledError &&
          chunkIndex === 0 &&
          options?.sendJournal &&
          typeof eventId === "string" &&
          eventId !== ""
        ) {
          await options.sendJournal.recordCancelled(eventId).catch(() => {});
        }
        throw err;
      }
    };

    // Oversized payloads go out as ordered chunks under Telegram's limit. The
    // thread reply rides on the first chunk and the explorer button on the
    // last, so the message reads exactly like the unsplit one.
    const parts = splitTelegramMessage(text);
    if (parts.length > 1) {
      for (const [index, part] of parts.entries()) {
        await runLimitedSend(index, () =>
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
      await runLimitedSend(0, () =>
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
      if (err instanceof TelegramSendLimiterCancelledError) {
        throw err;
      }
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
      await runLimitedSend(0, () =>
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

  return Object.assign(notifyFn, {
    limiter: sharedLimiter,
    drain: (opts?: { timeoutMs?: number }) => sharedLimiter.drain(opts),
    cancelPending: (reason?: string) => sharedLimiter.cancelPending(reason),
    shutdown: (opts?: { mode?: "drain" | "cancel"; timeoutMs?: number; reason?: string }) =>
      sharedLimiter.shutdown(opts),
  });
}
