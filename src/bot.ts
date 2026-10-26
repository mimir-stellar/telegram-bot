/**
 * The grammy bot: command wiring, callback wiring, and the one send path the
 * poller uses.
 *
 * Slash commands live in `src/commands/`, one self-contained module per
 * command (see `CommandModule` in `src/commands/types.ts`): each declares its
 * own name, description, visibility, authorization and handler, and
 * `src/commands/index.ts` lists them in menu order. This file only builds the
 * bot, walks that registry, and applies the shared gates — so adding a command
 * no longer means editing this file.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, type CommandContext, type Context } from "grammy";

import { safeErrorMessage } from "./notifications/format.js";
import type { BotConfig } from "./config.js";
import { formatSuppressedRepeats, LogSampler } from "./log-sampler.js";

// Importing the catalogue registers every command module as a side effect.
import {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  chatAllowed,
  commandMetadata,
  isOperator,
  operatorAllowed,
  registeredCommands,
  visibleCommandMetadata,
  type CommandDeps,
  type CommandModule,
} from "./commands/index.js";
import {
  handlePauseConfirmCallback,
  registerCallbackHandlers,
  validatePauseConfirmData,
} from "./callbacks.js";
import { registerBroadcastHandlers } from "./commands/broadcast.js";
import { pauseConfirmKeyboard } from "./commands/keyboards.js";
import { CommandRateLimiter } from "./commands/rate-limit.js";
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
export { helpDetailMessage, COMMAND_DETAILS, type CommandDetail } from "./commands/help-detail.js";
export {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  contractsKeyboard,
  operatorKeyboard,
  pauseConfirmKeyboard,
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
export { clearHintState } from "./commands/unknown.js";

/** Older names for the pause-confirmation helpers, kept for existing imports. */
export const validatePauseCallbackData = validatePauseConfirmData;
export const pauseConfirmationKeyboard = pauseConfirmKeyboard;

/**
 * Telegram bot tokens have the shape `<digits>:<35+ url-safe chars>`.
 * Values pasted from dashboards frequently arrive wrapped in quotes or with
 * trailing whitespace/newlines, which only surface as a `getMe` failure at
 * startup. Validate the shape up front and name the problem without ever
 * echoing the token (or any part of it) into a message or log.
 */
export type BotTokenShapeProblem =
  | "empty"
  | "surrounding-quotes"
  | "whitespace"
  | "missing-colon"
  | "bad-prefix"
  | "bad-suffix"
  | "wrong-shape";

export interface BotTokenShapeResult {
  ok: boolean;
  problem?: BotTokenShapeProblem;
  message?: string;
}

const BOT_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{35,}$/;

/**
 * Validate a `BOT_TOKEN` value without ever including the token (or any
 * substring of it) in the returned message. The messages are intentionally
 * generic so they are safe to log and to surface in a startup error.
 *
 * Exported for embedders and for callers that build a bot from their own
 * configuration; `loadConfig` applies the same rules at startup, so
 * `createBot` does not reject placeholder tokens.
 */
export function validateBotTokenShape(raw: unknown): BotTokenShapeResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      problem: "empty",
      message: "BOT_TOKEN is empty; expected <digits>:<35+ url-safe chars>.",
    };
  }

  // Surrounding quotes are the most common paste artefact.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return {
      ok: false,
      problem: "surrounding-quotes",
      message:
        "BOT_TOKEN is wrapped in quotes; remove the surrounding quotes and retry.",
    };
  }

  // Any whitespace anywhere (leading, trailing, or embedded) is rejected.
  if (/\s/.test(raw)) {
    return {
      ok: false,
      problem: "whitespace",
      message:
        "BOT_TOKEN contains whitespace (leading, trailing, or embedded); trim it and retry.",
    };
  }

  if (!raw.includes(":")) {
    return {
      ok: false,
      problem: "missing-colon",
      message: "BOT_TOKEN is missing the ':' separator; expected <digits>:<35+ url-safe chars>.",
    };
  }

  if (!BOT_TOKEN_SHAPE.test(raw)) {
    return {
      ok: false,
      problem: "wrong-shape",
      message:
        "BOT_TOKEN has the wrong shape; expected <digits>:<35+ url-safe chars>.",
    };
  }

  return { ok: true };
}

// ── Command registry ─────────────────────────────────────────────────────────

/**
 * Shared metadata for handlers, help, and Telegram's command menu.
 *
 * Derived from the registry: a command module is the single place that decides
 * whether a command exists, so this list cannot drift from what is registered.
 */
export const COMMANDS = commandMetadata();

/** Everything a command handler may need. Kept as an alias for callers/tests. */
export type BotDeps = CommandDeps;

type CommandRegistrar = {
  command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => unknown;
  callbackQuery?: (filter: string | string[], handler: (ctx: Context) => Promise<void>) => unknown;
  on?: (filter: "message:entities:bot_command", handler: (ctx: Context) => Promise<void>) => unknown;
};

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(bot: Bot | CommandRegistrar, deps: BotDeps): void {
  const registrar = bot as CommandRegistrar;

  const rateLimiter =
    deps.rateLimiter ?? new CommandRateLimiter(deps.now ? { now: deps.now } : {});
  const sampler =
    deps.rateLimitSampler ??
    new LogSampler({ maxPerWindow: 1, windowMs: 60_000, now: deps.now ?? rateLimiter.now });

  /**
   * Per-chat token bucket for everyone but the operator. Over-limit commands
   * are dropped silently; the warning is sampled so a flood cannot flood logs.
   */
  const withinRateLimit = (ctx: CommandContext<Context>, command: string): boolean => {
    if (isOperator(ctx, deps.config)) return true;
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    if (chatId === undefined || rateLimiter.consume(chatId)) return true;
    const sample = sampler.record(String(chatId));
    if (sample.log) {
      const repeats = formatSuppressedRepeats(sample.suppressed, sampler.windowMs);
      console.warn(`[bot] rate limit exceeded for chat ${chatId}, ignoring /${command}${repeats}`);
    }
    return false;
  };

  const modules = registeredCommands();
  for (const module of modules) {
    registrar.command(module.command, async (ctx) => {
      if (!withinRateLimit(ctx, module.command)) return;
      await dispatch(module, ctx, deps);
    });
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

  if (typeof registrar.on === "function") {
    registerUnknownCommandFallback(
      registrar as Required<Pick<CommandRegistrar, "on">>,
      deps.config,
      modules.map(({ command }) => command),
    );
  }
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

/**
 * Unknown-command hint (private chats only). Registered AFTER all known
 * commands so grammy's command middleware matches known ones first. Groups and
 * channels stay silent, and commands addressed to another bot
 * (`/cmd@otherbot`) are skipped.
 */
function registerUnknownCommandFallback(
  bot: Required<Pick<CommandRegistrar, "on">>,
  config: BotConfig,
  knownCommandNames: readonly string[],
): void {
  bot.on("message:entities:bot_command", async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;

    const text = ctx.message?.text ?? "";
    const entities = ctx.message?.entities ?? [];

    // Find the first bot_command entity at offset 0.
    const cmdEntity = entities.find((e) => e.type === "bot_command" && e.offset === 0);
    if (!cmdEntity) return;

    // Extract the raw command token, e.g. "/status@mybot" → "status@mybot".
    const raw = text.slice(1, cmdEntity.length);
    const atIndex = raw.indexOf("@");
    const cmdName = atIndex === -1 ? raw : raw.slice(0, atIndex);
    const mention = atIndex === -1 ? null : raw.slice(atIndex + 1);

    // If it targets another bot, ignore.
    if (mention !== null) {
      const myUsername = (ctx as unknown as { me?: { username?: string } }).me?.username;
      if (myUsername && mention.toLowerCase() !== myUsername.toLowerCase()) return;
    }

    // Already handled by a known-command handler — do nothing.
    if (knownCommandNames.includes(cmdName)) return;

    // Rate-limit: one hint per chat per HINT_COOLDOWN_MS.
    const chatId = ctx.chat.id;
    if (!canSendHint(chatId)) return;

    const reply = unknownCommandReply(cmdName, closestCommand(cmdName, knownCommandNames));
    try {
      await ctx.reply(reply);
      recordHint(chatId);
    } catch (err) {
      console.warn(`[bot] unknown-command hint failed: ${safeErrorMessage(err, [config.botToken])}`);
    }
  });
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
