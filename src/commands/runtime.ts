/**
 * Shared plumbing for command modules: Telegram send options, MarkdownV2
 * replies, and the two authorization gates the registry applies.
 *
 * These helpers live outside `src/bot.ts` on purpose — command modules depend
 * on them, and bot.ts depends on the modules, so keeping them here avoids a
 * cycle between the composition root and the commands.
 */

import type { CommandContext, Context } from "grammy";

import type { BotConfig } from "../config.js";
import { isTimeoutError, splitTelegramMessage } from "../notifications/format.js";
import { redactText } from "../redact.js";

/** MarkdownV2 reply options used by every command message. */
export const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2" as const,
  link_preview_options: { is_disabled: true },
};

/**
 * Reply with MarkdownV2, splitting when the payload exceeds Telegram's
 * 4096-character `sendMessage` limit. `/help` grows with the command list
 * and `/status` with the watched targets, so either can cross it; the chunks
 * are sent in order.
 */
export async function replyMarkdown(
  ctx: CommandContext<Context>,
  text: string,
  options: typeof TELEGRAM_OPTIONS = TELEGRAM_OPTIONS,
): Promise<void> {
  for (const part of splitTelegramMessage(text)) {
    await ctx.reply(part, options);
  }
}

/**
 * Returns true when the chat is permitted to use restricted commands.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use the
 *   gated commands: /status, /health, /contracts, /preview).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (stored as a number in grammy's ctx.chat.id) and its string form are
 *   compared so that negative group ids such as -1001234567890 match correctly.
 */
export function isChatAllowed(
  allowedChatIds: readonly string[] | undefined,
  chatId: number,
): boolean {
  // Hand-built configs (tests, embedders) may omit the list: treat it as open.
  if (!allowedChatIds || allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

/** True when the update comes from the configured operator. */
export function isOperator(ctx: Pick<Context, "from">, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

/**
 * Returns true when the incoming slash command explicitly targets a different
 * bot (`/<cmd>@<otherbot>`). Commands without a `@mention` or addressed to
 * `ctx.me.username` (case-insensitive) return false.
 */
export function isCommandForAnotherBot(ctx: Pick<Context, "message" | "me">): boolean {
  const text = ctx.message?.text ?? "";
  const entities = ctx.message?.entities ?? [];
  const cmdEntity = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  const raw = cmdEntity
    ? text.slice(1, cmdEntity.length)
    : text.startsWith("/")
      ? (text.slice(1).split(/\s/, 1)[0] ?? "")
      : "";
  const atIndex = raw.indexOf("@");
  if (atIndex === -1) return false;
  const mention = raw.slice(atIndex + 1);
  if (mention.length === 0) return false;
  const myUsername = ctx.me?.username;
  if (!myUsername) return true;
  return mention.toLowerCase() !== myUsername.toLowerCase();
}

/**
 * Gate for commands that expose deployment details. Requests from unapproved
 * chats are silently ignored: an error reply would leak the existence of the
 * restriction, and silence matches privacy-mode bots that never see most
 * messages. The log lets operators spot misconfigured ids.
 */
export function chatAllowed(
  ctx: CommandContext<Context>,
  config: BotConfig,
  command: string,
): boolean {
  const chatId = ctx.chat?.id;
  if (chatId !== undefined && isChatAllowed(config.allowedChatIds, chatId)) return true;
  console.warn(`[bot] /${command} denied for chat ${chatId ?? "unknown"} (not in ALLOWED_CHAT_IDS)`);
  return false;
}

/**
 * Gate for operator commands. Non-operators get no reply at all, matching the
 * silent-ignore policy above; the log records the ignored attempt.
 */
export function operatorAllowed(
  ctx: CommandContext<Context>,
  config: BotConfig,
  command: string,
): boolean {
  if (isOperator(ctx, config)) return true;
  console.warn(`[bot] ignored unauthorized /${command} on update ${ctx.update.update_id}`);
  return false;
}

export const MAX_CALLBACK_LOG_ID_LEN = 64;
export const MAX_CALLBACK_ERROR_LOG_LEN = 240;

export interface CallbackLogIds {
  updateId: string;
  callbackQueryId: string;
}

export interface CallbackErrorLogParams {
  ctx: unknown;
  action?: string;
  broadcastId?: string;
  error: unknown;
  secrets?: readonly string[];
  prefix?: string;
}

function safeIdToken(value: unknown, maxLen: number = MAX_CALLBACK_LOG_ID_LEN): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : null;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[\x00-\x1F\x7F\s]+/g, "");
    if (cleaned.length === 0) return null;
    return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
  }
  return null;
}

function safeProp(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function hasProp(obj: object, key: string): boolean {
  try {
    return key in obj;
  } catch {
    return false;
  }
}

/**
 * Extract only stable, bounded correlation IDs from a callback context.
 * Never serializes `ctx`, `ctx.update`, or `ctx.callbackQuery`.
 */
export function extractCallbackLogIds(
  ctx: unknown,
  secrets: readonly string[] = [],
): CallbackLogIds {
  let rawUpdateId: unknown;
  let rawCallbackQueryId: unknown;

  if (ctx !== null && typeof ctx === "object") {
    const update = safeProp(ctx, "update");
    if (update !== null && typeof update === "object") {
      rawUpdateId = safeProp(update, "update_id");
    }

    const cq = safeProp(ctx, "callbackQuery");
    if (cq !== null && typeof cq === "object") {
      rawCallbackQueryId = safeProp(cq, "id");
    }
  }

  const updateIdRaw = safeIdToken(rawUpdateId) ?? "unknown";
  const callbackQueryIdRaw = safeIdToken(rawCallbackQueryId) ?? "unknown";

  return {
    updateId: redactText(updateIdRaw, { secrets, maxLen: MAX_CALLBACK_LOG_ID_LEN }) || "unknown",
    callbackQueryId:
      redactText(callbackQueryIdRaw, { secrets, maxLen: MAX_CALLBACK_LOG_ID_LEN }) || "unknown",
  };
}

/**
 * Map a thrown callback error to a bounded, redacted error category without
 * serializing full Telegram updates or traversing hostile nested objects.
 */
export function classifyCallbackError(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  if (error === null || error === undefined) {
    return "unknown_error";
  }

  try {
    if (isTimeoutError(error)) {
      return "timeout";
    }
  } catch {
    // Throwing getters on hostile error objects fall through to safe classification.
  }

  if (typeof error !== "object") {
    return typeof error === "string" ? "non_error_string" : "non_error_value";
  }

  const rawErrorCode = safeProp(error, "error_code");
  const rawMethod = safeProp(error, "method");
  const safeMethod =
    typeof rawMethod === "string" && /^[A-Za-z0-9_]{1,40}$/.test(rawMethod) ? rawMethod : null;

  if (typeof rawErrorCode === "number" && Number.isFinite(rawErrorCode)) {
    const codeNum = Math.trunc(rawErrorCode);
    const cat = safeMethod ? `telegram_api_${codeNum}:${safeMethod}` : `telegram_api_${codeNum}`;
    return redactText(cat, { secrets, maxLen: 80 });
  }

  const rawMessage = safeProp(error, "message");
  if (typeof rawMessage === "string") {
    if (/message is not modified/i.test(rawMessage)) return "telegram_not_modified";
    if (/query is too old|QUERY_ID_INVALID/i.test(rawMessage)) return "telegram_query_expired";
    if (/too many requests|retry after/i.test(rawMessage)) return "telegram_rate_limit";
    if (/bot was blocked|chat not found|user is deactivated|forbidden/i.test(rawMessage)) {
      return "telegram_unreachable";
    }
    if (/bad request|can't parse entities/i.test(rawMessage)) return "telegram_bad_request";
  }

  const rawCode = safeProp(error, "code");
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    return redactText(`code:${Math.trunc(rawCode)}`, { secrets, maxLen: 80 });
  }
  if (typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(rawCode)) {
    return redactText(`code:${rawCode}`, { secrets, maxLen: 80 });
  }

  const isUpdateShaped =
    !(error instanceof Error) &&
    (hasProp(error, "update_id") ||
      hasProp(error, "callback_query") ||
      hasProp(error, "update") ||
      hasProp(error, "ctx"));
  if (isUpdateShaped) {
    return "unstructured_update_error";
  }

  if (error instanceof Error) {
    const rawName = safeProp(error, "name");
    if (
      typeof rawName === "string" &&
      rawName !== "Error" &&
      /^[A-Za-z0-9_.-]{1,40}$/.test(rawName)
    ) {
      return redactText(`error:${rawName}`, { secrets, maxLen: 80 });
    }
    return "runtime_error";
  }

  return "non_error_object";
}

/**
 * Format a callback error log line containing only stable IDs and a redacted
 * error category, strictly bounded in length.
 */
export function formatCallbackErrorLog(params: CallbackErrorLogParams): string {
  const secrets = params.secrets ?? [];
  const ids = extractCallbackLogIds(params.ctx, secrets);
  const category = classifyCallbackError(params.error, secrets);
  const prefix = params.prefix ?? "[bot] callback error";

  const parts: string[] = [
    prefix,
    `update_id=${ids.updateId}`,
    `callback_query_id=${ids.callbackQueryId}`,
  ];

  const safeAction = safeIdToken(params.action, 32);
  if (safeAction) {
    parts.push(`action=${redactText(safeAction, { secrets, maxLen: 32 })}`);
  }

  const safeBroadcastId = safeIdToken(params.broadcastId, 48);
  if (safeBroadcastId) {
    parts.push(`broadcast_id=${redactText(safeBroadcastId, { secrets, maxLen: 48 })}`);
  }

  parts.push(`category=${category}`);

  return redactText(parts.join(" "), { secrets, maxLen: MAX_CALLBACK_ERROR_LOG_LEN });
}

/**
 * Answer a callback query, tolerating a missing query id and rate-limit or
 * timeout failures: the button's spinner is cosmetic, the action is not.
 */
export async function safeAnswerCallback(
  ctx: Context,
  config: BotConfig,
  params: { text?: string; show_alert?: boolean } = {},
): Promise<void> {
  if (ctx.callbackQuery?.id) {
    try {
      await ctx.answerCallbackQuery(params);
    } catch (err) {
      console.warn(
        formatCallbackErrorLog({
          ctx,
          prefix: "[bot] answerCallbackQuery failed",
          error: err,
          secrets: [config.botToken],
        }),
      );
    }
  }
}

/**
 * Maximum UTF-8 byte length accepted for slash-command arguments before
 * individual command handlers run.
 */
export const MAX_COMMAND_ARGUMENT_BYTES = 256;

/**
 * Bounded MarkdownV2 reply sent when a slash-command argument exceeds
 * {@link MAX_COMMAND_ARGUMENT_BYTES}. Never echoes user input.
 */
export function commandArgumentTooLongMessage(
  maxBytes: number = MAX_COMMAND_ARGUMENT_BYTES,
): string {
  return `Command argument is too long \\(maximum ${maxBytes} bytes\\)\\.`;
}

/** Result of checking a slash-command argument against the shared byte bound. */
export type CommandArgumentCheck =
  | { ok: true; argument: string; bytes: number }
  | { ok: false; bytes: number; maxBytes: number };

/**
 * Argument text following the command, without the command or its leading
 * space. grammy's `ctx.match` is used when present; hand-built contexts in
 * tests often omit it, so the message text is the fallback.
 */
export function commandArgument(ctx: CommandContext<Context>): string {
  if (typeof ctx.match === "string" && ctx.match.trim().length > 0) {
    return ctx.match.trim();
  }
  const text = ctx.message?.text ?? "";
  const spaceIndex = text.indexOf(" ");
  return spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
}

/**
 * Check whether the slash-command argument in `ctx` fits within `maxBytes`
 * UTF-8 bytes.
 */
export function checkCommandArgumentLength(
  ctx: CommandContext<Context>,
  maxBytes: number = MAX_COMMAND_ARGUMENT_BYTES,
): CommandArgumentCheck {
  const argument = commandArgument(ctx);
  const bytes = Buffer.byteLength(argument, "utf8");
  if (bytes > maxBytes) {
    return { ok: false, bytes, maxBytes };
  }
  return { ok: true, argument, bytes };
}

/**
 * Shared gate applied before individual slash-command handlers run.
 *
 * When the argument exceeds `maxBytes` UTF-8 bytes, logs a bounded warning
 * containing only the command name, update id, and byte count (never user
 * input), replies with a fixed bounded error message, and returns `false`.
 */
export async function commandArgumentAllowed(
  ctx: CommandContext<Context>,
  command: string,
  maxBytes: number = MAX_COMMAND_ARGUMENT_BYTES,
): Promise<boolean> {
  const check = checkCommandArgumentLength(ctx, maxBytes);
  if (check.ok) return true;
  console.warn(
    `[bot] rejected /${command} on update ${ctx.update?.update_id ?? "unknown"}: ` +
      `argument exceeds ${check.maxBytes} bytes (${check.bytes} bytes)`,
  );
  await ctx.reply(commandArgumentTooLongMessage(check.maxBytes), TELEGRAM_OPTIONS);
  return false;
}
