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
  const parsed = parseSlashCommand(text, ctx.message?.entities);
  if (parsed !== null) {
    return parsed.args;
  }
  const spaceIndex = text.indexOf(" ");
  return spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
}

export interface ParsedCommandTarget {
  /** Normalized lowercase command name without leading `/` or `@username`. */
  readonly command: string;
  /**
   * Bot username suffix after `@` (without `@`), `""` when `@` has no username
   * (`/cmd@`), or `null` when the command has no `@` suffix (`/cmd`).
   */
  readonly targetBotUsername: string | null;
  /** Trimmed argument text after the command token. */
  readonly args: string;
}

const SLASH_COMMAND_RE = /^\/([A-Za-z0-9_-]+)(?:@([^\s]*))?(?:\s+([\s\S]*))?$/;
const VALID_BOT_USERNAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Parse a leading slash command token and optional `@bot_username` target from
 * message text (using a leading `bot_command` entity when present).
 */
export function parseSlashCommand(
  text: string | undefined,
  entities?: readonly { type: string; offset: number; length: number }[],
): ParsedCommandTarget | null {
  if (typeof text !== "string" || !text.startsWith("/")) return null;

  const leadEntity = entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (leadEntity && leadEntity.length > 1 && leadEntity.length <= text.length) {
    const rawToken = text.slice(1, leadEntity.length);
    if (rawToken.length === 0 || /\s/.test(rawToken)) return null;
    const atIndex = rawToken.indexOf("@");
    const command = (atIndex === -1 ? rawToken : rawToken.slice(0, atIndex)).toLowerCase();
    if (!command || !/^[a-z0-9_-]+$/.test(command)) return null;
    const targetBotUsername = atIndex === -1 ? null : rawToken.slice(atIndex + 1);
    const args = text.slice(leadEntity.length).trim();
    return { command, targetBotUsername, args };
  }

  const match = SLASH_COMMAND_RE.exec(text);
  if (!match || !match[1]) return null;
  return {
    command: match[1].toLowerCase(),
    targetBotUsername: match[2] !== undefined ? match[2] : null,
    args: (match[3] ?? "").trim(),
  };
}

/**
 * Return `true` when the slash command in `ctx` has no `@bot` suffix or is
 * addressed (case-insensitively) to this bot's username. Commands carrying a
 * different or malformed `@bot` username return `false` so they are ignored.
 */
export function isCommandAddressedToBot(
  ctx: {
    message?: {
      text?: string | undefined;
      entities?: readonly { type: string; offset: number; length: number }[] | undefined;
    } | undefined;
    me?: { username?: string | undefined } | undefined;
  },
  fallbackBotUsername?: string | undefined,
): boolean {
  const text = ctx.message?.text;
  if (typeof text !== "string" || text.length === 0) {
    return true;
  }

  const parsed = parseSlashCommand(text, ctx.message?.entities);
  if (parsed === null) {
    return true;
  }

  if (parsed.targetBotUsername === null) {
    return true;
  }

  const target = parsed.targetBotUsername.trim();
  if (!VALID_BOT_USERNAME_RE.test(target)) {
    return false;
  }

  const ownUsername = (ctx.me?.username ?? fallbackBotUsername ?? "").trim();
  if (!ownUsername) {
    return false;
  }

  return target.toLowerCase() === ownUsername.toLowerCase();
}
