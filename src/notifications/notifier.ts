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
 *   - {@link describeTopicRoute} — bounded, redacted topic identifier label for diagnostics
 *   - {@link routeStatus}      — actionable status when zero routes are active
 */

import { createHash } from "node:crypto";
import type { Bot } from "grammy";

import { applyChatMigration, type BotConfig } from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import { splitTelegramMessage, type ExplorerKeyboard } from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";
import { retryDelayMs, type SendJournal } from "./send-journal.js";

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
  /** Optional claim/event category used to resolve forum topic overrides. */
  category?: string | undefined;
}

// ── isMarkdownParseError ─────────────────────────────────────────────────────

/**
 * True when a Telegram send failed because the requested parse mode could not
 * be used for the message.
 *
 * Two response families qualify:
 *  - entity/parse failures for MarkdownV2 (`can't parse entities`,
 *    `can't find end of the entity`);
 *  - an unsupported or unknown parse mode (`unsupported parse_mode`,
 *    `parse_mode is not supported`, `unknown parse mode`), which a Telegram
 *    deployment or proxy may return when it rejects the configured renderer.
 *
 * grammy (1.x) surfaces Bot API failures as `GrammyError` with `error_code`
 * and `description` straight from Telegram. The classifier requires error 400
 * when a numeric code is present, so rate limits (429), auth failures (401),
 * chat errors, and network `HttpError`s never qualify. Duck-typed errors
 * carrying the same Telegram description (mocks, wrapped rejections) match on
 * the phrasing alone when no numeric `error_code` is present.
 */
export function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  const parseFailure =
    /can't parse entities|can't find end of the entity/i.test(text) ||
    /unsupported parse[_ ]mode|unknown parse[_ ]mode|parse[_ ]mode (?:is )?(?:unsupported|not supported)/i.test(
      text,
    );
  if (!parseFailure) return false;
  if (typeof record.error_code === "number") return record.error_code === 400;
  return true;
}

/**
 * The most recent parse-mode fallback, for diagnostics and tests.
 *
 * `selectedMode` records which renderer actually delivered the event:
 * `markdown-v2` for the first attempt, `plain-text` for the fallback. Only
 * bounded, redacted values are stored — never message text, a token, or a raw
 * remote payload.
 */
export interface ParseFallbackDiagnostic {
  at: number;
  source: string;
  selectedMode: "plain-text";
  error: string;
  eventRef?: SendExtra["eventRef"];
}

export const notifierDiagnostics: { lastParseFallback: ParseFallbackDiagnostic | null } = {
  lastParseFallback: null,
};

/** Test helper — resets the recorded fallback diagnostic. */
export function resetNotifierDiagnostics(): void {
  notifierDiagnostics.lastParseFallback = null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Bounded log fragment identifying which event a fallback send belongs to. */
function _eventRefLabel(eventRef: SendExtra["eventRef"]): string {
  if (!eventRef) return "";
  const parts: string[] = [];
  if (typeof eventRef.source === "string" && eventRef.source) parts.push(eventRef.source);
  if (typeof eventRef.ledger === "number" && Number.isFinite(eventRef.ledger)) {
    parts.push(`ledger ${eventRef.ledger}`);
  }
  if (typeof eventRef.eventId === "string" && eventRef.eventId) parts.push(eventRef.eventId);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/**
 * Redacted, bounded label for a Telegram destination used in operator
 * diagnostics. Distinguishes separate topics (`message_thread_id`) inside the
 * same chat while never exposing the raw chat identifier: the chat is reduced
 * to a short non-reversible fingerprint, and the topic id is kept only when
 * it is a positive safe integer.
 */
export function describeTopicRoute(
  chatId: string | number | undefined | null,
  topicId?: number | undefined | null,
): string {
  const chat = chatId === undefined || chatId === null ? "" : String(chatId);
  let hash = 0;
  for (let i = 0; i < chat.length; i += 1) {
    hash = (hash * 31 + chat.charCodeAt(i)) >>> 0;
  }
  const chatLabel = chat === "" ? "chat:none" : `chat:${hash.toString(16).padStart(8, "0")}`;
  const topicLabel =
    typeof topicId === "number" && Number.isSafeInteger(topicId) && topicId > 0
      ? `topic:${topicId}`
      : "topic:default";
  return `${chatLabel}/${topicLabel}`;
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
 * Sends suppressed by notifier guards (empty render or route permission
 * cooldown), counted so callers can prove a skipped send never reached the
 * Telegram API.
 */
export const notifierSkips = { emptyText: 0, routeCooldown: 0 };

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
    Partial<Pick<BotConfig, "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents">>,
  options?: NotifierOptions,
): Notifier {
  const migrations = new Map<string, string>();
  void config.botToken;

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
    _silentOption: { disable_notification?: boolean },
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
        const res = await bot.api.sendMessage(chatId, part, {
          ...notificationOptions,
          ...(index === parts.length - 1 && extra?.reply_markup
            ? { reply_markup: extra.reply_markup }
            : {}),
          ...(index === 0 && replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: replyToMessageId } }
            : {}),
        });
        if (requireMessageId) assertDeliveryMessageId(res);
      }
      return;
    }

  async function ensureRetryStateLoaded(): Promise<void> {
    if (!retry || retryStateLoaded) return;
    retryStateLoaded = true;
    try {
      const res = await bot.api.sendMessage(chatId, text, {
        ...notificationOptions,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
        ...(replyToMessageId !== undefined
          ? { reply_parameters: { chat_id: chatId, message_id: replyToMessageId } }
          : {}),
      });
    } catch (err) {
      throw err;
    }
  }

  const notifier = (async (
    text: string | null,
    _source?: ContractSource,
    extra?: SendExtra,
  ): Promise<void> => {
    if (typeof text !== "string" || text.trim() === "") {
      notifierSkips.emptyText += 1;
      return;
    }
    await sendToChat(resolveChatId(config.chatId), text, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } }, {}, extra);
  }) as Notifier;

  notifier.migrateRoute = migrateRoute;
  notifier.resolveChatId = resolveChatId;
  return notifier;
}
