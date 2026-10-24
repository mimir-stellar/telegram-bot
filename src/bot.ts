/**
 * The grammy bot: command wiring, callback wiring, and the one send path the
 * poller uses.
 *
 * Slash commands live in `src/commands/`, one self-contained module per
 * command: each declares its own name, visibility, authorization and handler,
 * and registers itself through `defineCommand`. This file only builds the bot,
 * walks the registry, and owns the notifier the poller sends through — so
 * adding a command no longer means editing this file.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, type Context, type CommandContext } from "grammy";

import { safeErrorMessage } from "./notifications/format.js";
import { type BotConfig } from "./config.js";

// Importing the catalogue registers every command module as a side effect.
import {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  chatAllowed,
  commandMetadata,
  operatorAllowed,
  registeredCommands,
  visibleCommandMetadata,
  type CommandDeps,
  type CommandModule,
} from "./commands/index.js";
import { handlePauseConfirmCallback, registerCallbackHandlers } from "./callbacks.js";
import { registerBroadcastHandlers } from "./commands/broadcast.js";
import {
  canSendHint,
  closestCommand,
  recordHint,
  unknownCommandReply,
} from "./commands/unknown.js";

// ── Public surface ───────────────────────────────────────────────────────────
// bot.ts stays the stable entry point for index.ts and the tests; the
// implementations live with the commands.

export { previewMessage } from "./notifications/format.js";
export { clearHintState } from "./commands/unknown.js";
export { helpDetailMessage, COMMAND_DETAILS, type CommandDetail } from "./commands/help-detail.js";
export {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  contractsKeyboard,
  operatorKeyboard,
  pauseConfirmKeyboard,
  pauseConfirmKeyboard as pauseConfirmationKeyboard,
  statusKeyboard,
} from "./commands/keyboards.js";
export { TELEGRAM_OPTIONS, isChatAllowed, isOperator } from "./commands/runtime.js";
export {
  aboutMessage,
  helpMessage,
  contractsMessage,
  healthMessage,
  lastEventMessage,
  pauseMessage,
  resumeMessage,
  statusMessage,
} from "./commands/index.js";
export {
  CALLBACK_FALLBACK_FEEDBACK,
  CALLBACK_FALLBACK_PAYLOAD,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  CALLBACK_UNAUTHORIZED_PAYLOAD,
  PAUSE_CONFIRM_TTL_MS,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  handleCallbackQuery,
  handlePauseConfirmCallback,
  registerCallbackHandlers,
  updateOrReplyMessage,
  validateCallbackData,
  validatePauseConfirmData,
  type CallbackActionType,
  type CallbackValidationResult,
  type ValidCallbackAction,
} from "./callbacks.js";
export {
  handleBroadcastCallback,
  registerBroadcastHandlers,
  handleBroadcastCommand,
  getConfiguredBroadcastChats,
  BroadcastStore,
  sendBroadcast,
} from "./commands/broadcast.js";

/**
 * Shared metadata for handlers, help, and Telegram's command menu.
 *
 * Derived from the registry: a command module is the single place that decides
 * whether a command exists, so this list cannot drift from what is registered.
 */
export const COMMANDS = commandMetadata();

/** Legacy alias kept for callers/tests: accepts only the pause confirm/cancel payloads. */
export function validatePauseCallbackData(
  data: unknown,
): typeof CALLBACK_PAUSE_CONFIRM | typeof CALLBACK_PAUSE_CANCEL | null {
  return data === CALLBACK_PAUSE_CONFIRM || data === CALLBACK_PAUSE_CANCEL ? data : null;
}

/** Everything a command handler may need. Kept as an alias for callers/tests. */
export type BotDeps = CommandDeps;

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(
  bot:
    | Bot
    | {
        command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => unknown;
        callbackQuery?: (
          filter: string | string[],
          handler: (ctx: Context) => Promise<void>,
        ) => unknown;
      },
  deps: BotDeps,
): void {
  const registrar = bot as {
    command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => unknown;
    callbackQuery?: (
      filter: string | string[],
      handler: (ctx: Context) => Promise<void>,
    ) => unknown;
  };

  for (const module of registeredCommands()) {
    registrar.command(module.command, (ctx) => dispatch(module, ctx, deps));
  }

  // The pause confirmation prompt is produced by /pause, so its buttons are
  // registered alongside it rather than with the generic action callbacks.
  registrar.callbackQuery?.(
    [CALLBACK_PAUSE_CONFIRM, CALLBACK_PAUSE_CANCEL],
    async (ctx: Context) =>
      handlePauseConfirmCallback(ctx, {
        config: deps.config,
        pause: deps.pause ?? (() => "stopped"),
      }),
  );

  // ── Unknown-command fallback (private chats only) ──────────────────────
  // Must be registered AFTER all known commands so grammy's command middleware
  // matches known ones first. Groups and channels are left silent, and
  // commands addressed to another bot (/cmd@otherbot) are skipped.
  const knownCommandNames = COMMANDS.map((c) => c.command);
  if (typeof (bot as unknown as Partial<Bot>).on !== "function") return;

  (bot as unknown as Bot).on("message:entities:bot_command", async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;

    const text = ctx.message?.text ?? "";
    const entities = ctx.message?.entities ?? [];
    const cmdEntity = entities.find((e) => e.type === "bot_command" && e.offset === 0);
    if (!cmdEntity) return;

    // "/status@mybot" → "status@mybot".
    const raw = text.slice(1, cmdEntity.length);
    const atIndex = raw.indexOf("@");
    const cmdName = atIndex === -1 ? raw : raw.slice(0, atIndex);
    const mention = atIndex === -1 ? null : raw.slice(atIndex + 1);

    if (mention !== null) {
      const myUsername = (ctx as unknown as { me?: { username?: string } }).me?.username;
      if (myUsername && mention.toLowerCase() !== myUsername.toLowerCase()) return;
    }

    if (knownCommandNames.includes(cmdName)) return;

    const chatId = ctx.chat.id;
    if (!canSendHint(chatId)) return;

    const suggestion = closestCommand(cmdName, knownCommandNames);
    const reply = unknownCommandReply(cmdName, suggestion);

    try {
      await ctx.reply(reply);
      recordHint(chatId);
    } catch (err) {
      console.warn(
        `[bot] unknown-command hint failed: ${safeErrorMessage(err, [deps.config.botToken])}`,
      );
    }
  });
}

/**
 * Run one command module: apply the authorization its metadata declares, then
 * the handler. Gating here — instead of inside each handler — means a new
 * operator-only or allowlisted command cannot forget its check.
 */
function dispatch(
  module: CommandModule,
  ctx: CommandContext<Context>,
  deps: BotDeps,
): Promise<void> {
  if (module.operatorOnly === true && !operatorAllowed(ctx, deps.config, module.command)) {
    return Promise.resolve();
  }
  if (module.chatAllowlist === true && !chatAllowed(ctx, deps.config, module.command)) {
    return Promise.resolve();
  }
  return module.handler(ctx, deps);
}

export function createBot(deps: BotDeps): Bot {
  const clientOptions =
    deps.config.telegramApiRoot !== undefined && deps.config.telegramApiRoot !== null
      ? { client: { apiRoot: deps.config.telegramApiRoot } }
      : undefined;
  // Token shape is validated by `loadConfig` at startup, where the operator
  // can act on the message (`BOT_TOKEN is not a valid Telegram bot token: …`).
  // It is deliberately not re-litigated here: `createBot` is also the entry
  // point for tests and embedders that never speak to Telegram, and a
  // placeholder token must not stop them building a bot.
  const bot = new Bot(
    deps.config.botToken,
    deps.botInfo !== undefined
      ? { botInfo: deps.botInfo, ...clientOptions }
      : clientOptions,
  );
  registerCommandHandlers(bot, deps);
  registerCallbackHandlers(bot, deps);
  registerBroadcastHandlers(bot, deps);

  // grammy rethrows handler errors by default, which would take the process
  // with it. Keep Telegram/RPC error text bounded and redact known secrets.
  bot.catch((err) => {
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ` +
        safeErrorMessage(err.error, [deps.config.botToken]),
    );
  });

  return bot;
}

// Notifier moved to src/notifications/notifier.ts — re-exported here so all
// existing imports from "bot.js" keep resolving without modification.
export {
  createNotifier,
  isMarkdownParseError,
  notifierSkips,
  type SendExtra,
} from "./notifications/notifier.js";

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot, config?: BotConfig): Promise<void> {
  try {
    await bot.api.setMyCommands(
      visibleCommandMetadata(config).map(({ command, description }) => ({ command, description })),
    );
  } catch (err) {
    // Cosmetic. Never worth failing a boot over, and never log an unbounded API error.
    console.warn(`[bot] setMyCommands failed: ${safeErrorMessage(err)}`);
  }
}
