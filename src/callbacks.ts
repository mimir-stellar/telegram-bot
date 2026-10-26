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
 *    `resume`, `broadcast`), handled by {@link handleCallbackQuery}
 *  - the `/pause` confirmation buttons, which carry their own payloads and a
 *    TTL, handled by {@link handlePauseConfirmCallback}
 */

import { InlineKeyboard, type Bot, type Context } from "grammy";

import { safeErrorMessage } from "./notifications/format.js";
import { handleBroadcastCallback } from "./commands/broadcast.js";
import {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  contractsKeyboard,
  operatorKeyboard,
  statusKeyboard,
} from "./commands/keyboards.js";
import { helpMessage } from "./commands/help.js";
import { contractsMessage } from "./commands/contracts.js";
import { pauseMessage } from "./commands/pause.js";
import { resumeMessage } from "./commands/resume.js";
import { statusMessage } from "./commands/status.js";
import type { CommandDeps } from "./commands/registry.js";
import { TELEGRAM_OPTIONS, isOperator, safeAnswerCallback } from "./commands/runtime.js";
import { canControl } from "./commands/admin-check.js";

// ── Callback payload validation ──────────────────────────────────────────────

export type CallbackActionType = "status" | "contracts" | "help" | "pause" | "resume" | "broadcast";

export interface ValidCallbackAction {
  type: CallbackActionType;
  raw: string;
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

function isKnownAction(val: string): val is CallbackActionType {
  return ["status", "contracts", "help", "pause", "resume", "broadcast"].includes(val);
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

  // 1. JSON payload: e.g. {"action":"status"}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { action?: unknown };
      if (typeof parsed?.action === "string" && isKnownAction(parsed.action)) {
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

  // 2. Colon-delimited: e.g. "status:refresh", "mimir:contracts", etc.
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
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

function isMessageNotModified(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

export async function updateOrReplyMessage(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboard,
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

export async function handleCallbackQuery(
  ctx: Context,
  deps: CommandDeps,
): Promise<void> {
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
    console.warn(
      `[bot] rejected invalid callback query (${validation.reason}) on update ${ctx.update.update_id}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: validation.fallbackText,
      show_alert: false,
    });
    return;
  }

  const { action } = validation;

  // Enforce operator role authorization
  if (action.type === "pause" || action.type === "resume" || action.type === "broadcast") {
    if (!(await canControl(ctx, config, ctx.api))) {
      console.warn(
        `[bot] ignored unauthorized callback /${action.type} on update ${ctx.update.update_id}`,
      );
      await safeAnswerCallback(ctx, config, {
        text: CALLBACK_UNAUTHORIZED_FEEDBACK,
        show_alert: true,
      });
      return;
    }
  }

  // Execute validated action
  try {
    switch (action.type) {
      case "broadcast": {
        await handleBroadcastCallback(ctx, deps, action.raw);
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
      `[bot] callback error on action ${action.type}: ${safeErrorMessage(err, [config.botToken])}`,
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
  if (ageMs > PAUSE_CONFIRM_TTL_MS) {
    await ctx.answerCallbackQuery({ text: "Confirmation expired.", show_alert: true });
    await ctx.editMessageText(
      "⏱ *Pause confirmation expired\\.* Run /pause again\\.",
      TELEGRAM_OPTIONS,
    );
    return;
  }

  if (action === CALLBACK_PAUSE_CONFIRM) {
    const result = pause();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(pauseMessage(result), TELEGRAM_OPTIONS);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Cancelled." });
  await ctx.editMessageText("*Pause cancelled\\.* Polling continues\\.", TELEGRAM_OPTIONS);
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
