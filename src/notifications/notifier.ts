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

import {
  formatTelegramRoute,
  parseTelegramRoute,
  type BotConfig,
  type TelegramRoute,
} from "../config.js";
import { redactChatId } from "../status.js";
import type { ContractSource } from "../stellar/decode.js";
import {
  safeErrorMessage,
  splitTelegramMessage,
  type ExplorerKeyboard,
} from "./format.js";
import { DEFAULT_SILENT_EVENTS, isSilent } from "./priority.js";

export interface DisabledNotificationRoute {
  chatId: string;
  topicId?: number | undefined;
  key: string;
  reason: string;
}

export interface RouteVerificationResult<TConfig extends NotifierConfigInput> {
  config: TConfig & {
    routes: TelegramRoute[];
    disabledRouteKeys: ReadonlySet<string>;
  };
  activeRoutes: TelegramRoute[];
  disabledRoutes: DisabledNotificationRoute[];
}

export type NotifierConfigInput = Pick<BotConfig, "chatId"> &
  Partial<
    Pick<
      BotConfig,
      | "marketChatId"
      | "squadChatId"
      | "botToken"
      | "chatIds"
      | "routes"
      | "channelPreviewMode"
      | "linkPreviewMarket"
      | "linkPreviewSquad"
      | "silentEvents"
    >
  > & {
    disabledRouteKeys?: ReadonlySet<string> | undefined;
  };

export function routeIdentityKey(route: Pick<TelegramRoute, "chatId" | "topicId">): string {
  return route.topicId !== undefined ? `${route.chatId}#${route.topicId}` : `${route.chatId}#root`;
}

function coerceRouteTarget(
  raw: string,
  channelPreviewMode = false,
): TelegramRoute | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = parseTelegramRoute(trimmed, channelPreviewMode);
  if (parsed) return parsed;
  const sep = /^([^:#\s]+)[:#]([1-9]\d*)$/.exec(trimmed);
  if (sep) {
    return {
      chatId: sep[1]!,
      topicId: Number(sep[2]!),
      enabled: true,
      channelPreviewMode,
    };
  }
  return {
    chatId: trimmed,
    enabled: true,
    channelPreviewMode,
  };
}

/** True when any configured route targets a Telegram forum topic (`topicId`). */
export function hasConfiguredForumTopics(config: NotifierConfigInput): boolean {
  if (config.routes?.some((r) => r.topicId !== undefined)) return true;
  for (const raw of [
    ...(config.chatIds ?? []),
    config.chatId,
    config.marketChatId,
    config.squadChatId,
  ]) {
    if (typeof raw === "string" && coerceRouteTarget(raw)?.topicId !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Verifies configured Telegram chat and forum-topic routes against the Bot API
 * before enabling them for delivery.
 *
 * Invalid chats or unreachable/closed/non-forum topics are disabled
 * individually with bounded redacted warnings so working chats keep receiving
 * notifications.
 */
export async function verifyNotificationRoutes<TConfig extends NotifierConfigInput>(
  bot: Pick<Bot, "api">,
  config: TConfig,
): Promise<RouteVerificationResult<TConfig>> {
  const secrets =
    typeof config.botToken === "string" && config.botToken !== ""
      ? [config.botToken]
      : [];
  const preview = config.channelPreviewMode ?? false;

  const baseRoutes: TelegramRoute[] =
    config.routes && config.routes.length > 0
      ? config.routes.map((r) => ({ ...r, enabled: r.enabled ?? true }))
      : (config.chatIds && config.chatIds.length > 0
          ? config.chatIds
          : [config.chatId]
        )
          .map((raw) => coerceRouteTarget(raw, preview))
          .filter((r): r is TelegramRoute => r !== null);

  // Collect every unique (chatId, topicId) route referenced by primary, fan-out,
  // or per-contract overrides so each is verified at most once.
  const candidates = new Map<string, TelegramRoute>();
  for (const route of baseRoutes) {
    candidates.set(routeIdentityKey(route), route);
  }
  for (const overrideRaw of [config.marketChatId, config.squadChatId]) {
    if (typeof overrideRaw === "string" && overrideRaw.trim() !== "") {
      const parsed = coerceRouteTarget(overrideRaw, preview);
      if (parsed) {
        const key = routeIdentityKey(parsed);
        if (!candidates.has(key)) candidates.set(key, parsed);
      }
    }
  }

  const disabledRouteKeys = new Set<string>(config.disabledRouteKeys ?? []);
  const disabledRoutes: DisabledNotificationRoute[] = [];

  for (const [key, route] of candidates.entries()) {
    if (route.enabled === false || disabledRouteKeys.has(key)) {
      disabledRouteKeys.add(key);
      continue;
    }

    try {
      const chatInfo = (await bot.api.getChat(route.chatId)) as {
        is_forum?: boolean;
        type?: string;
      };

      if (route.topicId !== undefined) {
        if (chatInfo?.is_forum !== true) {
          throw new Error("target chat does not have forum topics enabled (is_forum=false)");
        }
        await bot.api.sendChatAction(route.chatId, "typing", {
          message_thread_id: route.topicId,
        });
      }
    } catch (err) {
      const reason = safeErrorMessage(err, secrets);
      disabledRouteKeys.add(key);
      disabledRoutes.push({
        chatId: route.chatId,
        ...(route.topicId !== undefined ? { topicId: route.topicId } : {}),
        key,
        reason,
      });
      const safeChat = redactChatId(route.chatId);
      const topicLabel = route.topicId !== undefined ? ` topic=${route.topicId}` : "";
      console.warn(
        `[notifier] disabled invalid notification route (${safeChat}${topicLabel}): ${reason}`,
      );
    }
  }

  const verifiedRoutes = baseRoutes.map((route) => ({
    ...route,
    enabled: route.enabled !== false && !disabledRouteKeys.has(routeIdentityKey(route)),
  }));
  const activeRoutes = verifiedRoutes.filter((route) => route.enabled !== false);

  return {
    config: {
      ...config,
      routes: verifiedRoutes,
      disabledRouteKeys,
    },
    activeRoutes,
    disabledRoutes,
  };
}

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
export const notifierSkips = { emptyText: 0, disabledRoute: 0 };

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
  config: NotifierConfigInput,
) {
  const resolveDestinations = (source?: ContractSource): TelegramRoute[] => {
    const preview = config.channelPreviewMode ?? false;
    const disabledKeys = config.disabledRouteKeys;
    const defaultTargetStr =
      config.chatId ||
      config.chatIds?.[0] ||
      (config.routes?.[0] ? formatTelegramRoute(config.routes[0]) : "");

    const explicitSourceStr =
      source === "market"
        ? config.marketChatId
        : source === "squad"
          ? config.squadChatId
          : undefined;

    // Explicit per-contract destination override (different from primary default).
    if (
      typeof explicitSourceStr === "string" &&
      explicitSourceStr.trim() !== "" &&
      explicitSourceStr.trim() !== defaultTargetStr
    ) {
      const parsed = coerceRouteTarget(explicitSourceStr, preview);
      if (!parsed) return [];
      if (disabledKeys?.has(routeIdentityKey(parsed))) return [];
      return [parsed];
    }

    if (config.routes && config.routes.length > 0) {
      return config.routes.filter(
        (route) =>
          route.enabled !== false && !disabledKeys?.has(routeIdentityKey(route)),
      );
    }

    const singleRaw = explicitSourceStr || defaultTargetStr;
    const single = coerceRouteTarget(singleRaw, preview);
    if (!single) return [];
    if (disabledKeys?.has(routeIdentityKey(single))) return [];
    return [single];
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

    const destinations = resolveDestinations(source);
    if (destinations.length === 0) {
      notifierSkips.disabledRoute += 1;
      return;
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

    // Oversized payloads go out as ordered chunks under Telegram's limit. The
    // thread reply rides on the first chunk and the explorer button on the
    // last, so the message reads exactly like the unsplit one.
    const parts = splitTelegramMessage(text);

    for (const dest of destinations) {
      const chatId = dest.chatId;
      const threadOption =
        dest.topicId !== undefined ? { message_thread_id: dest.topicId } : {};
      const notificationOptions = {
        parse_mode: "MarkdownV2" as const,
        link_preview_options: { is_disabled: linkPreviewDisabled },
        ...silentOption,
        ...threadOption,
      };

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
        continue;
      }

      try {
        await bot.api.sendMessage(chatId, text, {
          ...notificationOptions,
          ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
          ...(extra?.replyToMessageId !== undefined
            ? { reply_parameters: { chat_id: chatId, message_id: extra.replyToMessageId } }
            : {}),
        });
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
  };
}
