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
import {
  OrphanDecisionRequiredError,
  type JournalEntry,
  type JournalRuntimeConfig,
  type OrphanedJournalEntry,
  type OrphanRecoveryDecision,
  type SendJournal,
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

// ── Route & Journal Orphan Recovery ──────────────────────────────────────────

export interface NotifierRouteConfig {
  chatId?: string;
  chatIds?: string[];
  marketChatId?: string;
  squadChatId?: string;
  network?: string;
  networkPassphrase?: string;
}

/**
 * Build the active `route -> chatId` table from bot configuration. Routes with
 * an empty or unconfigured destination are omitted so removed routes are
 * cleanly detected on startup.
 */
export function resolveNotifierRoutes(config: NotifierRouteConfig): Record<string, string> {
  const defaultChat = (config.chatId ?? config.chatIds?.[0] ?? "").trim();
  const marketChat = (config.marketChatId ?? defaultChat).trim();
  const squadChat = (config.squadChatId ?? defaultChat).trim();
  const routes: Record<string, string> = {};
  if (defaultChat !== "") routes.default = defaultChat;
  if (marketChat !== "") routes.market = marketChat;
  if (squadChat !== "") routes.squad = squadChat;
  return routes;
}

/** Derive {@link JournalRuntimeConfig} from the active notifier configuration. */
export function buildJournalRuntimeConfig(
  config: NotifierRouteConfig & { activeRoutes?: readonly string[] },
): JournalRuntimeConfig {
  const routeMap = resolveNotifierRoutes(config);
  const activeRoutes = config.activeRoutes ?? Object.keys(routeMap);
  const filteredMap: Record<string, string> = {};
  for (const route of activeRoutes) {
    const dest = routeMap[route];
    if (typeof dest === "string" && dest.trim() !== "") {
      filteredMap[route] = dest.trim();
    }
  }
  return {
    activeRoutes: [...activeRoutes],
    activeDestinations: filteredMap,
    network: config.network,
    networkPassphrase: config.networkPassphrase,
  };
}

export interface RecoverOrphanedJournalOptions {
  journal: SendJournal;
  config: NotifierRouteConfig & { activeRoutes?: readonly string[] };
  /**
   * Explicit operator decisions keyed by journal entry `id`, or a callback.
   * Orphaned entries without an explicit `discard` or `reroute` decision are
   * never silently replayed; when `strict` is true (or `replay` is provided
   * without a decision), {@link OrphanDecisionRequiredError} is thrown.
   */
  decisions?:
    | Readonly<Record<string, OrphanRecoveryDecision>>
    | ((orphan: OrphanedJournalEntry) => OrphanRecoveryDecision | undefined);
  /** Optional replay callback invoked only for explicitly rerouted entries. */
  replay?: (entry: JournalEntry, destination: { route: string; chatId: string }) => Promise<void>;
  /** When true, throw {@link OrphanDecisionRequiredError} if any orphan lacks a decision. */
  strict?: boolean;
}

export interface RecoverOrphanedJournalResult {
  activePending: JournalEntry[];
  discardedIds: string[];
  rerouted: JournalEntry[];
  replayedIds: string[];
  unresolvedOrphans: OrphanedJournalEntry[];
}

/**
 * Inspect and recover orphaned send-journal entries after configuration changes.
 *
 * Entries orphaned by a removed route or changed network identity are never
 * silently replayed: each requires an explicit `discard` or `reroute` decision.
 */
export async function recoverOrphanedJournalEntries(
  options: RecoverOrphanedJournalOptions,
): Promise<RecoverOrphanedJournalResult> {
  const runtime = buildJournalRuntimeConfig(options.config);
  const routeMap = resolveNotifierRoutes(options.config);
  const { activePending, orphaned } = await options.journal.inspectRecovery(runtime);

  const discardedIds: string[] = [];
  const rerouted: JournalEntry[] = [];
  const replayedIds: string[] = [];
  const unresolvedOrphans: OrphanedJournalEntry[] = [];

  for (const orphan of orphaned) {
    const decision =
      typeof options.decisions === "function"
        ? options.decisions(orphan)
        : options.decisions?.[orphan.entry.id];

    if (!decision) {
      if (options.strict === true || options.replay !== undefined) {
        throw new OrphanDecisionRequiredError(orphan.entry.id, orphan.reasons);
      }
      unresolvedOrphans.push(orphan);
      continue;
    }

    const updated = await options.journal.resolveOrphan(orphan.entry.id, decision, runtime);
    if (updated === null) {
      discardedIds.push(orphan.entry.id);
      continue;
    }

    rerouted.push(updated);
    if (options.replay) {
      const targetRoute = updated.route ?? "default";
      const chatId =
        (decision.action === "reroute" ? decision.targetChatId : undefined) ??
        routeMap[targetRoute] ??
        "";
      await options.replay(updated, { route: targetRoute, chatId });
      await options.journal.recordDone(updated.id);
      replayedIds.push(updated.id);
    }
  }

  await options.journal.compact();
  return {
    activePending,
    discardedIds,
    rerouted,
    replayedIds,
    unresolvedOrphans,
  };
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
