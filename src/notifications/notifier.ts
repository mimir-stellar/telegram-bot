/**
 * Outbound notification sending: the poller's one path to Telegram.
 *
 * Extracted from `src/bot.ts` so notification-send changes and
 * command-handling changes no longer touch the same file.
 *
 * Public API (all re-exported from `src/bot.ts` for backwards compatibility):
 *   - {@link SendExtra}                   — extra options a caller attaches to a send
 *   - {@link DEFAULT_MAX_RETRY_AFTER_MS}  — default upper bound for Telegram retry_after delays
 *   - {@link parseBoundedRetryAfterMs}    — parser/validator for Telegram retry_after delays
 *   - {@link createRoutePacer}            — per-route flood pacing without blocking other routes
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

// ── Bounded retry_after & per-route pacing ───────────────────────────────────

/** Default upper bound (60s) for honoring Telegram `retry_after` flood delays. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export type RetryAfterParseResult =
  | { status: "none" }
  | { status: "ok"; delayMs: number }
  | { status: "rejected"; reason: "malformed" | "extreme"; raw: unknown };

function readRawRetryAfter(err: unknown): { present: boolean; raw: unknown } {
  if (!err || typeof err !== "object") return { present: false, raw: undefined };
  const e = err as Record<string, unknown> & {
    parameters?: Record<string, unknown>;
    response?: { headers?: unknown };
    headers?: unknown;
  };

  if (e.parameters && typeof e.parameters === "object" && "retry_after" in e.parameters) {
    return { present: true, raw: e.parameters.retry_after };
  }
  if ("retry_after" in e) {
    return { present: true, raw: e.retry_after };
  }

  const headers = (e.response?.headers ?? e.headers) as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  if (headers && typeof headers === "object") {
    const val =
      typeof headers.get === "function"
        ? headers.get("retry-after") ?? headers.get("Retry-After")
        : headers["retry-after"] ?? headers["Retry-After"];
    if (val !== undefined && val !== null) {
      return { present: true, raw: val };
    }
  }

  return { present: false, raw: undefined };
}

/**
 * Parse and validate a Telegram flood `retry_after` delay (in seconds),
 * rejecting malformed (non-finite, non-positive, non-numeric) or extreme
 * (`> maxRetryAfterMs`) server delays.
 */
export function parseBoundedRetryAfterMs(
  err: unknown,
  maxRetryAfterMs: number = DEFAULT_MAX_RETRY_AFTER_MS,
): RetryAfterParseResult {
  const { present, raw } = readRawRetryAfter(err);
  if (!present) return { status: "none" };

  let seconds: number;
  if (typeof raw === "number") {
    seconds = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return { status: "rejected", reason: "malformed", raw };
    }
    seconds = Number(trimmed);
  } else {
    return { status: "rejected", reason: "malformed", raw };
  }

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { status: "rejected", reason: "malformed", raw };
  }

  const delayMs = Math.ceil(seconds * 1000);
  if (!Number.isFinite(delayMs) || delayMs > maxRetryAfterMs) {
    return { status: "rejected", reason: "extreme", raw };
  }

  return { status: "ok", delayMs };
}

export interface RoutePacerOptions {
  maxRetryAfterMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface RoutePacer {
  waitForRoute(route: string): Promise<void>;
  recordFloodResponse(route: string, err: unknown): RetryAfterParseResult;
  getRouteCooldownUntil(route: string): number | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Per-route flood pacer: when Telegram returns a valid bounded `retry_after`
 * for one destination route (`chatId`), only that route waits out the cooldown
 * while unrelated routes continue unblocked.
 */
export function createRoutePacer(options?: RoutePacerOptions): RoutePacer {
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? defaultSleep;
  const cooldownUntilByRoute = new Map<string, number>();

  async function waitForRoute(route: string): Promise<void> {
    const deadline = cooldownUntilByRoute.get(route);
    if (deadline === undefined) return;
    const remaining = deadline - now();
    if (remaining > 0) {
      await sleep(remaining);
    } else {
      cooldownUntilByRoute.delete(route);
    }
  }

  function recordFloodResponse(route: string, err: unknown): RetryAfterParseResult {
    const parsed = parseBoundedRetryAfterMs(err, maxRetryAfterMs);
    if (parsed.status === "ok") {
      const target = now() + parsed.delayMs;
      const existing = cooldownUntilByRoute.get(route) ?? 0;
      if (target > existing) {
        cooldownUntilByRoute.set(route, target);
      }
    } else if (parsed.status === "rejected") {
      console.warn(
        `[notifier] rejected ${parsed.reason} retry_after for route ${route}: ${String(parsed.raw).slice(0, 32)}`,
      );
    }
    return parsed;
  }

  function getRouteCooldownUntil(route: string): number | null {
    return cooldownUntilByRoute.get(route) ?? null;
  }

  return { waitForRoute, recordFloodResponse, getRouteCooldownUntil };
}

export interface NotifierOptions {
  maxRetryAfterMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pacer?: RoutePacer | undefined;
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
  const pacer =
    options?.pacer ??
    createRoutePacer({
      maxRetryAfterMs: options?.maxRetryAfterMs,
      now: options?.now,
      sleep: options?.sleep,
    });

  const sendToRoute = async (
    chatId: string,
    body: string,
    payloadOptions: Record<string, unknown>,
  ): Promise<void> => {
    await pacer.waitForRoute(chatId);
    try {
      await bot.api.sendMessage(chatId, body, payloadOptions);
    } catch (err) {
      pacer.recordFloodResponse(chatId, err);
      throw err;
    }
  };

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
        await sendToRoute(chatId, part, {
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
      await sendToRoute(chatId, text, {
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
      await sendToRoute(chatId, fallback, {
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
