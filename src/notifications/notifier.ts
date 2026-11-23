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
 *   - {@link previewRouting}   — read-only routing preview (no Telegram calls)
 *   - {@link routeStatus}      — actionable status when zero routes are active
 */

import { createHash } from "node:crypto";
import type { Bot } from "grammy";

import { applyChatMigration, type BotConfig } from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  isTimeoutError,
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import type { SendJournal } from "./send-journal.js";

// Re-export isTimeoutError so callers that only import from notifier.ts
// can classify timeout errors without also depending on format.ts directly.
export { isTimeoutError } from "./format.js";

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
  /**
   * Optional callback invoked when the send timed out before Telegram
   * responded. The notification may or may not have been accepted — this is an
   * **unknown outcome**, distinct from a confirmed rejection (4xx error).
   * Callers that maintain a send journal should call `journal.recordTimeout(id)`
   * inside this hook to flag the pending intent as a confirmed-unknown outcome
   * so recovery tooling can distinguish it from a plain crash-recovery intent.
   * The error that triggered the timeout is passed for bounded logging; never
   * re-throw from this callback.
   */
  onTimeout?: ((err: unknown) => void) | undefined;
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

/**
 * Extract `parameters.migrate_to_chat_id` from a Telegram Bot API 400 error
 * when a group chat has been upgraded to a supergroup. Returns `null` for any
 * other error or invalid migration target.
 */
export function extractMigrateToChatId(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const record = err as {
    error_code?: unknown;
    parameters?: { migrate_to_chat_id?: unknown } | undefined;
  };
  if (typeof record.error_code === "number" && record.error_code !== 400) {
    return null;
  }
  const raw = record.parameters?.migrate_to_chat_id;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw !== 0 ? String(raw) : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return /^-?\d+$/.test(trimmed) && trimmed !== "0" ? trimmed : null;
  }
  return null;
}

export interface NotifierOptions {
  /** Optional callback invoked when a route is updated via `migrate_to_chat_id`. */
  onRouteMigrated?: ((fromChatId: string, toChatId: string) => void) | undefined;
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

/** Resolves the destination chat id for a contract source. */
function resolveChatId(
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId"> & Partial<Pick<BotConfig, "chatIds">>,
  source: ContractSource | undefined,
): string {
  const defaultChat = config.chatId ?? config.chatIds?.[0] ?? "";
  if (source === "market") return config.marketChatId || defaultChat;
  if (source === "squad") return config.squadChatId || defaultChat;
  return defaultChat;
}

/** Resolves whether link previews are disabled for a contract source. */
function resolveLinkPreviewDisabled(
  config: Partial<Pick<BotConfig, "linkPreviewMarket" | "linkPreviewSquad">>,
  source: ContractSource | undefined,
): boolean {
  if (source === "market") return !config.linkPreviewMarket;
  if (source === "squad") return !config.linkPreviewSquad;
  return true;
}

// ── routeStatus ──────────────────────────────────────────────────────────────

/** Outcome of checking which configured notification routes are active. */
export type RouteStatus =
  | { state: "active"; activeRoutes: number }
  | {
      state: "no-active-routes";
      activeRoutes: 0;
      /** Human-readable, actionable explanation. Never claims delivery. */
      message: string;
    };

/**
 * Report whether any notification route is active. A zero-active-route result
 * is reported distinctly from healthy delivery, and it never implies that a
 * notification was delivered.
 *
 * `activeRoutes` is the count of routes the caller considers enabled; when it
 * is zero the result is `no-active-routes` with an actionable message.
 */
export function routeStatus(activeRoutes: number): RouteStatus {
  if (Number.isFinite(activeRoutes) && activeRoutes > 0) {
    return { state: "active", activeRoutes: Math.floor(activeRoutes) };
  }
  return {
    state: "no-active-routes",
    activeRoutes: 0,
    message:
      "No notification routes are enabled: every configured route is disabled, so no notifications will be sent. Enable at least one route in the chat configuration (chatId, marketChatId, squadChatId) to receive notifications. No delivery has been attempted or confirmed.",
  };
}

// ── notifierSkips ────────────────────────────────────────────────────────────

/**
 * Sends suppressed by the empty-message guard, counted so callers (and the
 * empty-text tests) can prove a blank render never reached the Telegram API.
 */
export const notifierSkips = { emptyText: 0 };

// ── previewRouting ───────────────────────────────────────────────────────────

/** Result of previewing where a notification would be delivered. */
export interface RoutingPreview {
  /** Destinations that will receive the message. */
  matched: Array<{ chatId: string; source: ContractSource | undefined }>;
  /** Destinations suppressed by policy (empty render, blank chat id). */
  filtered: Array<{ source: ContractSource | undefined; reason: "empty-text" | "no-chat-id" }>;
  /** Destinations that cannot be reached (no chat configured for the source). */
  unavailable: Array<{ source: ContractSource | undefined; reason: "no-chat-id" }>;
  /** Whether the message would be sent silently. */
  silent: boolean;
  /** Link preview disabled flag used for the destination. */
  linkPreviewDisabled: boolean;
}

/**
 * Previews the routing decision for a notification without calling Telegram.
 * Uses the same chat resolution, empty-text guard, and silent/link-preview
 * policy as {@link createNotifier}, so the preview cannot drift from delivery.
 */
export function previewRouting(
  text: string | null,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId"> &
    Partial<Pick<BotConfig, "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents">>,
  source?: ContractSource,
  extra?: Pick<SendExtra, "eventName">,
): RoutingPreview {
  const preview: RoutingPreview = {
    matched: [],
    filtered: [],
    unavailable: [],
    silent: Boolean(
      extra?.eventName && isSilent(extra.eventName, config.silentEvents ?? DEFAULT_SILENT_EVENTS),
    ),
    linkPreviewDisabled: resolveLinkPreviewDisabled(config, source),
  };

  if (typeof text !== "string" || text.trim() === "") {
    preview.filtered.push({ source, reason: "empty-text" });
    return preview;
  }

  const chatId = resolveChatId(config, source);
  if (chatId.trim() === "") {
    preview.unavailable.push({ source, reason: "no-chat-id" });
    return preview;
  }

  preview.matched.push({ chatId, source });
  return preview;
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
export type Notifier = ((
  text: string | null,
  source?: ContractSource,
  extra?: SendExtra,
) => Promise<void>) & {
  migrateRoute: (fromChatId: string, toChatId: string) => boolean;
  resolveChatId: (chatId: string) => string;
};

export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<
      Pick<
        BotConfig,
        "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents" | "routes"
      >
    >,
  options?: NotifierOptions,
): Notifier {
  const migrations = new Map<string, string>();
  const secrets = typeof config.botToken === "string" ? [config.botToken] : [];

  function resolveMigratedChatId(chatId: string): string {
    let current = chatId;
    const seen = new Set<string>();
    while (migrations.has(current) && !seen.has(current)) {
      seen.add(current);
      current = migrations.get(current)!;
    }
    return current;
  }

  function migrateRoute(fromChatId: string, toChatId: string): boolean {
    const from = fromChatId.trim();
    const to = toChatId.trim();
    if (!from || !to || from === to) return false;
    // Prevent cyclic migrations (e.g. to -> ... -> from).
    if (resolveMigratedChatId(to) === from) return false;
    if (migrations.get(from) === to) return false;

    migrations.set(from, to);
    applyChatMigration(config, from, to);
    console.warn(`[notifier] route migrated to supergroup chat id`);
    options?.onRouteMigrated?.(from, to);
    return true;
  }

  async function sendToChat(
    chatId: string,
    text: string,
    notificationOptions: {
      parse_mode: "MarkdownV2";
      link_preview_options: { is_disabled: boolean };
      disable_notification?: boolean;
    },
    silentOption: { disable_notification?: boolean },
    extra?: SendExtra,
    omitReplyTo = false,
  ): Promise<void> {
    const replyToMessageId = omitReplyTo ? undefined : extra?.replyToMessageId;

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
          ...(index === 0 && replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: replyToMessageId } }
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
        ...(replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: replyToMessageId } }
          : {}),
      });
      return;
    } catch (err) {
      // When the HTTP call timed out, the notification may have been accepted
      // by Telegram even though the client received no response. Notify the
      // caller so it can flag the pending journal intent as an unknown outcome
      // rather than a confirmed rejection, before the error propagates.
      if (isTimeoutError(err) && typeof extra?.onTimeout === "function") {
        try {
          extra.onTimeout(err);
        } catch {
          // onTimeout must never interrupt the error path.
        }
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
          `retrying as plain text: ${safeErrorMessage(err, secrets)}`,
      );
      // Plain text (no parse mode), same per-source link preview setting.
      await bot.api.sendMessage(chatId, fallback, {
        link_preview_options: notificationOptions.link_preview_options,
        ...threadOption,
        ...silentOption,
        ...threadOption,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: replyToMessageId } }
          : {}),
      });
    }
  }

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

    const chatId = resolveChatId(config, source);

    // Select link preview settings based on the contract source.
    // Commands (where source is undefined) always use TELEGRAM_OPTIONS (disabled).
    const linkPreviewDisabled = resolveLinkPreviewDisabled(config, source);

    const silentOption = extra?.eventName && isSilent(extra.eventName, config.silentEvents ?? DEFAULT_SILENT_EVENTS)
      ? { disable_notification: true }
      : {};
    const notificationOptions = {
      parse_mode: "MarkdownV2" as const,
      link_preview_options: { is_disabled: linkPreviewDisabled },
      ...silentOption,
    };

    try {
      await sendToChat(chatId, text, notificationOptions, silentOption, extra);
    } catch (err) {
      const migratedTo = extractMigrateToChatId(err);
      if (migratedTo && migrateRoute(chatId, migratedTo)) {
        await sendToChat(migratedTo, text, notificationOptions, silentOption, extra, true);
        return;
      }
      throw err;
    }
  };

  return Object.assign(notify, { migrateRoute, resolveChatId: resolveMigratedChatId });
}