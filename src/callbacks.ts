/**
 * Inline-keyboard callbacks: validation, dispatch, and the pause confirmation.
 *
 * Callback data is untrusted user input. Every payload is validated against a
 * small known set before any action runs, operator actions are authorized
 * exactly like `/pause` and `/resume`, and anything unrecognized is answered
 * with a generic message rather than silently swallowed (Telegram otherwise
 * shows a spinner on the button forever).
 *
 * Two families of callbacks share this module:
 *  - navigation/operator actions (`status`, `contracts`, `help`, `pause`,
 *    `resume`, `broadcast`, `confirmations`), handled by {@link handleCallbackQuery}.
 *    Broadcast confirmations are bound to a fingerprint of the reviewed destination
 *    set and cancel if route configuration changes before confirmation.
 *  - the `/pause` confirmation buttons, which carry their own payloads and a
 *    TTL, handled by {@link handlePauseConfirmCallback}
 */

import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { messagesFor } from "./i18n.js";
import {
  handleBroadcastCallback,
  handleConfirmationsCallback,
} from "./commands/broadcast.js";
import {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  contractsKeyboard,
  operatorKeyboard,
  statusKeyboard,
} from "./commands/keyboards.js";
import { helpMessage } from "./commands/help.js";
import { contractsMessage } from "./commands/contracts.js";
import { menuKeyboard, menuMessage } from "./commands/menu.js";
import { pauseMessage } from "./commands/pause.js";
import { resumeMessage } from "./commands/resume.js";
import { statusMessage } from "./commands/status.js";
import { eventsMessage, eventsPage, resolveRecentEvents } from "./commands/events.js";
import { pageKeyboard, parsePaginationCallback } from "./notifications/pagination.js";
import type { CommandDeps } from "./commands/registry.js";
import { TELEGRAM_OPTIONS, isChatAllowed, isOperator, safeAnswerCallback } from "./commands/runtime.js";

// ── Callback payload validation ──────────────────────────────────────────────

export type CallbackActionType =
  | "menu"
  | "status"
  | "contracts"
  | "help"
  | "pause"
  | "resume"
  | "broadcast";

export interface ValidCallbackAction {
  type: CallbackActionType;
  raw: string;
  page?: number;
}

export type CallbackValidationResult =
  | { ok: true; action: ValidCallbackAction }
  | { ok: false; reason: string; fallbackText: string };

/** Telegram's Bot API limits callback_data to 1-64 bytes. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export const CALLBACK_FALLBACK_PAYLOAD =
  "*Invalid request*\nThe requested action is unrecognized or malformed\\.";

export const CALLBACK_UNAUTHORIZED_PAYLOAD =
  "*Unauthorized*\nThis action requires operator privileges\\.";

export const CALLBACK_FALLBACK_FEEDBACK = "Invalid or unrecognized action";
export const CALLBACK_UNAUTHORIZED_FEEDBACK = "Unauthorized: operator only";
export const CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK = "Unauthorized: chat not allowed";

function isKnownAction(val: string): val is CallbackActionType {
  return ["menu", "status", "contracts", "help", "pause", "resume", "broadcast"].includes(val);
}

/**
 * Validate untrusted callback-query data before any action is executed.
 * Treats all callback data as untrusted external user input.
 */
export function validateCallbackData(raw: unknown): CallbackValidationResult {
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason: "missing-or-non-string",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "empty",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return {
      ok: false,
      reason: "exceeds-max-length",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // Reject ASCII control characters (including null bytes)
  if (/[\x00-\x1F\x7F]/.test(raw)) {
    return {
      ok: false,
      reason: "control-characters",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // Reject top-level noncanonical numeric identifiers
  if (isNoncanonicalNumericId(trimmed)) {
    return {
      ok: false,
      reason: "noncanonical-numeric-id",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // 1. JSON payload: e.g. {"action":"status"}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { action?: unknown; [key: string]: unknown };
      if (typeof parsed?.action === "string" && isKnownAction(parsed.action)) {
        if (hasNoncanonicalNumericField(parsed)) {
          return {
            ok: false,
            reason: "noncanonical-numeric-id",
            fallbackText: CALLBACK_FALLBACK_FEEDBACK,
          };
        }
        return {
          ok: true,
          action: { type: parsed.action, raw },
        };
      }
      return {
        ok: false,
        reason: "unknown-json-action",
        fallbackText: CALLBACK_FALLBACK_FEEDBACK,
      };
    } catch {
      return {
        ok: false,
        reason: "malformed-json",
        fallbackText: CALLBACK_FALLBACK_FEEDBACK,
      };
    }
  }

  // 2. Pagination callback: "pg:v1:events:<page>"
  const pagination = parsePaginationCallback(trimmed);
  if (pagination !== null) {
    if (pagination.kind === "events") {
      return {
        ok: true,
        action: { type: "events_page", page: pagination.page, raw },
      };
    }
    return {
      ok: false,
      reason: "unknown-action",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // 3. Colon-delimited: e.g. "status:refresh", "mimir:contracts", etc.
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    for (const part of parts) {
      if (isNoncanonicalNumericId(part)) {
        return {
          ok: false,
          reason: "noncanonical-numeric-id",
          fallbackText: CALLBACK_FALLBACK_FEEDBACK,
        };
      }
    }
    if (parts[0] === "mimir" && parts[1] && isKnownAction(parts[1])) {
      return {
        ok: true,
        action: { type: parts[1], raw },
      };
    }
    if (parts[0] && isKnownAction(parts[0])) {
      return {
        ok: true,
        action: { type: parts[0], raw },
      };
    }
    return {
      ok: false,
      reason: "unknown-action",
      fallbackText: CALLBACK_FALLBACK_FEEDBACK,
    };
  }

  // 3. Direct action token: "status", "contracts", "help", "pause", "resume"
  if (isKnownAction(trimmed)) {
    return {
      ok: true,
      action: { type: trimmed, raw },
    };
  }

  return {
    ok: false,
    reason: "unknown-action",
    fallbackText: CALLBACK_FALLBACK_FEEDBACK,
  };
}

// ── Message helpers ──────────────────────────────────────────────────────────

/**
 * Detects errors indicating that the Telegram message being edited or deleted
 * no longer exists on Telegram's servers (error_code 400 or matching message).
 */
export function isDeletedMessageError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const errorObj = err as Record<string, unknown>;
  if (typeof errorObj.error_code === "number" && errorObj.error_code !== 400) {
    return false;
  }
  const text =
    typeof errorObj.description === "string"
      ? errorObj.description
      : typeof errorObj.message === "string"
      ? errorObj.message
      : undefined;
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return (
    lower.includes("message to edit not found") ||
    lower.includes("message can't be edited") ||
    lower.includes("message to delete not found")
  );
}

function isMessageNotModified(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

export async function updateOrReplyMessage(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboard | InlineKeyboardMarkup,
): Promise<void> {
  const options = {
    ...TELEGRAM_OPTIONS,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      if (isMessageNotModified(err)) {
        return;
      }
      // If edit failed (e.g. message too old or deleted), fall through to reply
    }
  }

  if (ctx.chat) {
    await ctx.reply(text, options);
    return;
  }

  // no-op: callers that need to target the configured chat should call
  // `ctx.api.sendMessage(config.chatId, ...)` directly when `ctx.chat` is
  // unavailable. handleCallbackQuery does this.
}

// ── Action callbacks ─────────────────────────────────────────────────────────

export interface HandleCallbackQueryOptions {
  deletedToast?: string;
  deletedFallbackReply?: string;
}

export async function handleCallbackQuery(
  ctx: Context,
  deps: CommandDeps,
): Promise<void>;
export async function handleCallbackQuery(
  ctx: Context,
  handler: (data: string) => Promise<void>,
  opts?: HandleCallbackQueryOptions,
): Promise<void>;
export async function handleCallbackQuery(
  ctx: Context,
  depsOrHandler: CommandDeps | ((data: string) => Promise<void>),
  opts?: HandleCallbackQueryOptions,
): Promise<void> {
  if (typeof depsOrHandler === "function") {
    const rawData = ctx.callbackQuery?.data ?? "";
    try {
      await depsOrHandler(rawData);
    } catch (err) {
      if (isDeletedMessageError(err)) {
        try {
          let toast = opts?.deletedToast ?? "The original message was deleted.";
          if (Array.from(toast).length > 200) {
            toast = Array.from(toast).slice(0, 199).join("") + "…";
          }
          await ctx.answerCallbackQuery({
            text: toast,
            show_alert: false,
          });
        } catch {
          // swallow answerCallbackQuery failure
        }

        if (opts?.deletedFallbackReply) {
          let replyText = opts.deletedFallbackReply;
          if (Array.from(replyText).length > 4000) {
            replyText = Array.from(replyText).slice(0, 4000).join("");
          }
          await ctx.reply(replyText);
        }
        return;
      }
      throw err;
    }
    return;
  }

  const deps = depsOrHandler;
  const { config, status } = deps;
  const pause = deps.pause ?? (() => "stopped");
  const resume = deps.resume ?? (() => "stopped");
  const rawData = ctx.callbackQuery?.data;

  // The pause confirmation buttons carry their own payloads and TTL and are
  // registered separately (`handlePauseConfirmCallback`); answering them here
  // as unknown actions would double-handle the same tap.
  if (validatePauseConfirmData(rawData) !== null) return;

  // Validate callback query data before acting
  const validation = validateCallbackData(rawData);

  if (!validation.ok) {
    const ids = extractCallbackLogIds(ctx, [config.botToken]);
    console.warn(
      `[bot] rejected invalid callback query (${validation.reason}) update_id=${ids.updateId} callback_query_id=${ids.callbackQueryId}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: validation.fallbackText,
      show_alert: false,
    });
    return;
  }

  const { action } = validation;

  // Enforce operator role authorization
  if (
    action.type === "pause" ||
    action.type === "resume" ||
    action.type === "broadcast" ||
    action.type === "confirmations"
  ) {
    if (!isOperator(ctx, config)) {
      const ids = extractCallbackLogIds(ctx, [config.botToken]);
      console.warn(
        `[bot] ignored unauthorized callback action=${action.type} update_id=${ids.updateId} callback_query_id=${ids.callbackQueryId}`,
      );
      await safeAnswerCallback(ctx, config, {
        text: CALLBACK_UNAUTHORIZED_FEEDBACK,
        show_alert: true,
      });
      return;
    }
  } else {
    // Enforce chat allowlist authorization on every navigation callback
    const allowedChatIds = config.allowedChatIds;
    if (allowedChatIds && allowedChatIds.length > 0) {
      const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
      if (chatId === undefined || !isChatAllowed(allowedChatIds, chatId)) {
        console.warn(
          `[bot] ignored unauthorized callback /${action.type} for chat ${chatId ?? "unknown"} (not in ALLOWED_CHAT_IDS) on update ${ctx.update.update_id}`,
        );
        await safeAnswerCallback(ctx, config, {
          text: CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK,
          show_alert: true,
        });
        return;
      }
    }
  }

  // Execute validated action
  try {
    switch (action.type) {
      case "menu": {
        const text = menuMessage();
        const keyboard = menuKeyboard();
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, keyboard);
        } else {
          await ctx.api.sendMessage(config.chatId, text, {
            ...TELEGRAM_OPTIONS,
            reply_markup: keyboard,
          });
        }
        await safeAnswerCallback(ctx, config, { text: "Menu" });
        break;
      }

      case "broadcast": {
        await handleBroadcastCallback(ctx, deps, action.raw);
        break;
      }

      case "confirmations": {
        await handleConfirmationsCallback(ctx, deps, action.raw);
        break;
      }

      case "status": {
        const text = statusMessage(config, status());
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, statusKeyboard(config));
        } else {
          await ctx.api.sendMessage(config.chatId, text, {
            ...TELEGRAM_OPTIONS,
            reply_markup: statusKeyboard(config),
          });
        }
        await safeAnswerCallback(ctx, config, { text: "Status refreshed" });
        break;
      }

      case "contracts": {
        const text = contractsMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, contractsKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Contracts" });
        break;
      }

      case "help": {
        const text = helpMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text);
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Help" });
        break;
      }

      case "pause": {
        const result = pause();
        const text = pauseMessage(result, config.locale);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "paused" ? "Polling paused" : result === "already-paused" ? "Already paused" : "Cannot pause",
        });
        break;
      }

      case "resume": {
        const result = resume();
        const text = resumeMessage(result, config.locale);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "resumed" ? "Polling resumed" : result === "already-running" ? "Already running" : "Cannot resume",
        });
        break;
      }
    }
  } catch (err) {
    console.error(
      formatCallbackErrorLog({
        ctx,
        action: action.type,
        error: err,
        secrets: [config.botToken],
      }),
    );
    await safeAnswerCallback(ctx, config, { text: "Action failed" });
  }
}

// ── Pause confirmation callbacks ─────────────────────────────────────────────

/**
 * How long a pause-confirmation message stays valid.
 * Callbacks arriving after this window are rejected as stale.
 */
export const PAUSE_CONFIRM_TTL_MS = 60_000;

const VALID_CALLBACK_DATA = new Set<string>([
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_PAUSE_CANCEL,
]);

/**
 * Returns the validated pause-confirm action or `null` when the payload is
 * unknown/missing. Keeps the handler from acting on arbitrary payloads from
 * third parties.
 */
export function validatePauseConfirmData(
  data: string | undefined,
): typeof CALLBACK_PAUSE_CONFIRM | typeof CALLBACK_PAUSE_CANCEL | null {
  if (data !== undefined && VALID_CALLBACK_DATA.has(data)) {
    return data as typeof CALLBACK_PAUSE_CONFIRM | typeof CALLBACK_PAUSE_CANCEL;
  }
  return null;
}

/**
 * Shared handler for pause inline-keyboard callbacks.
 *
 * Exported for unit testing without needing a live grammy `Bot` instance.
 * Callers must pass a grammy-compatible `ctx` that exposes:
 *   - `ctx.from`
 *   - `ctx.callbackQuery.data`
 *   - `ctx.callbackQuery.message.date` (Unix seconds, set by Telegram)
 *   - `ctx.answerCallbackQuery(text?, opts?)`
 *   - `ctx.editMessageText(text, opts)`
 */
export async function handlePauseConfirmCallback(
  ctx: Context,
  deps: Pick<CommandDeps, "config" | "pause">,
  nowMs: number = Date.now(),
): Promise<void> {
  const { config, pause } = deps;

  const action = validatePauseConfirmData(ctx.callbackQuery?.data);
  if (action === null) return; // unknown payload — silently ignore

  // Only the operator may act on these buttons.
  if (!isOperator(ctx, config)) {
    await ctx.answerCallbackQuery({ text: "Only the operator can do that.", show_alert: true });
    return;
  }

  // Reject stale confirmations so an old message cannot stop the poller later.
  const messageDate = ctx.callbackQuery?.message?.date ?? 0;
  const ageMs = nowMs - messageDate * 1000;
  const actionName = action === CALLBACK_PAUSE_CONFIRM ? "pause_confirm" : "pause_cancel";
  let answered = false;
  try {
    if (ageMs > PAUSE_CONFIRM_TTL_MS) {
      answered = true;
      const messages = messagesFor(config.locale).callbackMessages;
      await ctx.answerCallbackQuery({ text: messages.pauseExpiredAlert, show_alert: true });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            messages.pauseExpiredMessage,
            TELEGRAM_OPTIONS,
          );
        } catch {
          // ignore edit failure (e.g. message deleted or cannot be edited)
        }
      }
      return;
    }

    if (action === CALLBACK_PAUSE_CONFIRM) {
      const result = pause();
      answered = true;
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(pauseMessage(result, config.locale), TELEGRAM_OPTIONS);
      return;
    }

    answered = true;
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("*Pause cancelled\\.* Polling continues\\.", TELEGRAM_OPTIONS);
  } catch (err) {
    console.error(
      formatCallbackErrorLog({
        ctx,
        action: actionName,
        error: err,
        secrets: [config.botToken],
      }),
    );
    if (!answered) {
      await safeAnswerCallback(ctx, config, { text: "Action failed" });
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Register callback handlers on a grammy-compatible bot or mock. */
export function registerCallbackHandlers(
  bot: Bot | { on: (event: string, handler: (ctx: Context) => Promise<void>) => void },
  deps: CommandDeps,
): void {
  (bot as { on: (event: string, handler: (ctx: Context) => Promise<void>) => void }).on(
    "callback_query",
    async (ctx: Context) => {
      await handleCallbackQuery(ctx, deps);
    },
  );
}
