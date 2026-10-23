/**
 * The shape of a slash-command module.
 *
 * Every command under `src/commands/` exports one {@link CommandModule}. The
 * module carries everything the bot needs to advertise and run it — its name,
 * its menu description, who may run it, and its handler — so `src/bot.ts`
 * only iterates the ordered catalogue in `src/commands/index.ts` and never
 * needs a per-command edit.
 *
 * Authorization is data, not code: the registrar reads `operatorOnly` and
 * `allowlisted` and applies the shared gates before `handle` runs, so a new
 * command cannot forget its check.
 */

import type { CommandContext, Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import type { AuditLog } from "../audit.js";
import type { BotConfig } from "../config.js";
import type { LogSampler } from "../log-sampler.js";
import type { LogCapture } from "../logger.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "../poller.js";
import type { BroadcastStore } from "./broadcast.js";
import type { CommandRateLimiter } from "./rate-limit.js";

/** Everything a command handler may need, supplied once by `createBot`. */
export interface CommandDeps {
  config: BotConfig;
  status: () => PollerStatus;
  pause: () => PollerPauseResult;
  resume: () => PollerResumeResult;
  /** Bot version string, typically read from package.json. */
  version?: string | undefined;
  /** Live in-memory audit window; renders immediately even before a flush. */
  audit?: AuditLog | undefined;
  /** Where the audit JSONL file lives, for the file-backed report. */
  auditFile?: string | undefined;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe | undefined;
  /** Bounded redacted log ring backing /export. Absent = command disabled. */
  logs?: LogCapture | undefined;
  /** In-memory broadcast confirmation store. */
  broadcastStore?: BroadcastStore | undefined;
  /** Per-chat command rate limiter. Defaults to a fresh limiter per bot. */
  rateLimiter?: CommandRateLimiter | undefined;
  /** Sampler for the "rate limit exceeded" warning. */
  rateLimitSampler?: LogSampler | undefined;
  /** Injected clock (epoch ms) for the default rate limiter and sampler. */
  now?: (() => number) | undefined;
}

/** A slash command handler: grammy's command context plus the bot's deps. */
export type CommandHandler = (
  ctx: CommandContext<Context>,
  deps: CommandDeps,
) => Promise<void>;

/** One self-contained slash command, as the registry stores it. */
export interface CommandModule {
  /**
   * Telegram command name, without the leading slash. Advertised commands also
   * need a `COMMAND_DETAILS` entry in `src/commands/help-detail.ts`.
   */
  readonly command: string;
  /**
   * English menu description (Telegram `setMyCommands` and `/help`). A locale's
   * `commandDescriptions` entry overrides it at render time. Empty for hidden
   * commands, which are never advertised.
   */
  readonly description: string;
  /**
   * Operator-only commands answer only the configured operator and are hidden
   * from the menu when no operator is configured. Non-operators are ignored
   * silently: an error reply would confirm the command exists.
   */
  readonly operatorOnly: boolean;
  /**
   * Restricts the command to chats in `ALLOWED_CHAT_IDS`. Restricted commands
   * are ignored silently for the same reason as operator commands.
   */
  readonly allowlisted: boolean;
  /**
   * Registered and usable, but not advertised in the Telegram command menu or
   * `/help` (e.g. `/export`, an operator recovery tool).
   */
  readonly hidden: boolean;
  /** Runs the command. Called only after the declared gates pass. */
  handle(ctx: CommandContext<Context>, deps: CommandDeps): Promise<void>;
  /** @deprecated Alias of {@link CommandModule.handle}, kept for existing callers. */
  readonly handler: CommandHandler;
  /** @deprecated Alias of {@link CommandModule.allowlisted}, kept for existing callers. */
  readonly chatAllowlist: boolean;
}

/**
 * What a command file writes. Flags default to `false`; `description` defaults
 * to the command's `COMMAND_DESCRIPTIONS` entry. `handler` and `chatAllowlist`
 * are accepted as older spellings of `handle` and `allowlisted`.
 */
export interface CommandDefinition {
  readonly command: string;
  readonly description?: string;
  readonly operatorOnly?: boolean;
  readonly allowlisted?: boolean;
  readonly hidden?: boolean;
  readonly handle?: CommandHandler;
  /** @deprecated Use `handle`. */
  readonly handler?: CommandHandler;
  /** @deprecated Use `allowlisted`. */
  readonly chatAllowlist?: boolean;
}

/** Menu and `/help` metadata for a registered command. */
export interface CommandMetadata {
  readonly command: string;
  readonly description: string;
  readonly operatorOnly: boolean;
}
