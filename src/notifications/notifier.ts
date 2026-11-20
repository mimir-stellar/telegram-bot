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

import { DEFAULT_ROUTE_COOLDOWN_MS, type BotConfig } from "../config.js";
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

/**
 * True when a Telegram send failed due to missing chat/channel permissions
 * (e.g. 403 Forbidden, bot kicked/blocked/not a member, or 400 lacking send
 * rights). Rate limits (429), auth errors (401), entity-parse errors (400),
 * and transient network errors never qualify.
 */
export function isPermissionFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
  if (typeof record.error_code === "number") {
    if (record.error_code === 403) return true;
    if (record.error_code !== 400) return false;
  }
  const text = [record.description, record.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  return /not enough rights|have no rights to send|chat_write_forbidden|bot was kicked|bot was blocked|bot is not a member|need administrator rights/i.test(
    text,
  );
}

// ── Route Cooldowns ──────────────────────────────────────────────────────────

export interface RouteCooldownState {
  chatId: string;
  until: number;
  failures: number;
  reason: string;
}

export interface RouteCooldownTracker {
  isInCooldown(chatId: string): boolean;
  getCooldown(chatId: string): RouteCooldownState | undefined;
  recordPermissionFailure(chatId: string, reason: string): RouteCooldownState | undefined;
  clearCooldown(chatId: string): boolean;
  clearAllCooldowns(): void;
}

export function createRouteCooldownTracker(
  cooldownMs: number,
  now: () => number = Date.now,
): RouteCooldownTracker {
  const entries = new Map<string, RouteCooldownState>();
  const duration = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0;

  function activeEntry(chatId: string): RouteCooldownState | undefined {
    const entry = entries.get(chatId);
    if (!entry) return undefined;
    if (now() >= entry.until) {
      entries.delete(chatId);
      return undefined;
    }
    return entry;
  }

  return {
    isInCooldown(chatId: string): boolean {
      return activeEntry(chatId) !== undefined;
    },
    getCooldown(chatId: string): RouteCooldownState | undefined {
      const entry = activeEntry(chatId);
      return entry ? { ...entry } : undefined;
    },
    recordPermissionFailure(chatId: string, reason: string): RouteCooldownState | undefined {
      if (duration <= 0 || !chatId) return undefined;
      const prev = entries.get(chatId);
      const next: RouteCooldownState = {
        chatId,
        until: now() + duration,
        failures: (prev?.failures ?? 0) + 1,
        reason,
      };
      entries.set(chatId, next);
      return { ...next };
    },
    clearCooldown(chatId: string): boolean {
      return entries.delete(chatId);
    },
    clearAllCooldowns(): void {
      entries.clear();
    },
  };
}

export interface NotifierOptions {
  /** Override per-route permission-failure cooldown in ms (`0` disables). */
  cooldownMs?: number | undefined;
  /** Clock override for cooldown timing (defaults to `Date.now`). */
  now?: (() => number) | undefined;
  /** Optional external cooldown tracker shared across callers. */
  cooldowns?: RouteCooldownTracker | undefined;
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
 * Sends suppressed by notifier guards (empty render or route permission
 * cooldown), counted so callers can prove a skipped send never reached the
 * Telegram API.
 */
export const notifierSkips = { emptyText: 0, routeCooldown: 0 };

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
  clearCooldown: (chatId: string) => boolean;
  clearAllCooldowns: () => void;
  isInCooldown: (chatId: string) => boolean;
  getCooldown: (chatId: string) => RouteCooldownState | undefined;
};

export function createNotifier(
  bot: Pick<Bot, "api">,
  config: Pick<BotConfig, "chatId" | "marketChatId" | "squadChatId" | "botToken"> &
    Partial<
      Pick<
        BotConfig,
        "chatIds" | "linkPreviewMarket" | "linkPreviewSquad" | "silentEvents" | "routeCooldownMs"
      >
    >,
  options?: NotifierOptions,
): Notifier {
  const now = options?.now ?? Date.now;
  const cooldownMs = options?.cooldownMs ?? config.routeCooldownMs ?? DEFAULT_ROUTE_COOLDOWN_MS;
  const cooldowns = options?.cooldowns ?? createRouteCooldownTracker(cooldownMs, now);
  const secrets = typeof config.botToken === "string" ? [config.botToken] : [];

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

    if (cooldowns.isInCooldown(chatId)) {
      notifierSkips.routeCooldown += 1;
      console.warn(
        `[notifier] skipped send during permission cooldown${eventRefLabel(extra?.eventRef)} ` +
          `(source=${typeof source === "string" && source ? source.slice(0, 32) : "default"})`,
      );
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
    const notificationOptions = {
      parse_mode: "MarkdownV2" as const,
      link_preview_options: { is_disabled: linkPreviewDisabled },
      ...silentOption,
    };

    try {
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
        cooldowns.clearCooldown(chatId);
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
        cooldowns.clearCooldown(chatId);
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
            `retrying as plain text: ${safeErrorMessage(err, secrets)}`,
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
        cooldowns.clearCooldown(chatId);
      }
    } catch (err) {
      if (isPermissionFailure(err)) {
        const reason = safeErrorMessage(err, secrets);
        const state = cooldowns.recordPermissionFailure(chatId, reason);
        if (state) {
          console.warn(
            `[notifier] route entered permission cooldown for ${cooldownMs}ms` +
              `${eventRefLabel(extra?.eventRef)}: ${reason}`,
          );
        }
      }
      throw err;
    }
  };

  return Object.assign(notify, {
    clearCooldown: (chatId: string) => cooldowns.clearCooldown(chatId),
    clearAllCooldowns: () => cooldowns.clearAllCooldowns(),
    isInCooldown: (chatId: string) => cooldowns.isInCooldown(chatId),
    getCooldown: (chatId: string) => cooldowns.getCooldown(chatId),
  });
}
