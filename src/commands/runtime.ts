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
import { safeErrorMessage, splitTelegramMessage } from "../notifications/format.js";

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
        `[bot] answerCallbackQuery failed: ${safeErrorMessage(err, [config.botToken])}`,
      );
    }
  }
}

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
