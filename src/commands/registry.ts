/**
 * The slash-command registry.
 *
 * A command is a self-contained module under `src/commands/`: it declares its
 * name, who may run it, and its handler (plus, where useful, the message
 * renderer that handler uses). Modules register themselves through
 * {@link defineCommand} at load time; `src/commands/index.ts` is the single
 * place that imports them, which fixes menu order.
 *
 * `src/bot.ts` only walks the registry, so adding a command no longer means
 * editing a shared `handlers` record there. Authorization is declared, not
 * repeated: the registrar applies {@link CommandModule.operatorOnly} and
 * {@link CommandModule.chatAllowlist} before the handler runs, so a new
 * operator command cannot forget its check.
 */

import type { CommandContext, Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import type { AuditLog } from "../audit.js";
import type { BotConfig } from "../config.js";
import { COMMAND_DESCRIPTIONS, messagesFor } from "../i18n.js";
import type { LogCapture } from "../logger.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "../poller.js";
import type { BroadcastStore } from "./broadcast.js";

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
}

/** A slash command handler: grammy's command context plus the bot's deps. */
export type CommandHandler = (
  ctx: CommandContext<Context>,
  deps: CommandDeps,
) => Promise<void>;

/** Context inspected when evaluating whether a command's runtime dependencies are available. */
export interface CommandAvailabilityContext {
  readonly config?: Partial<BotConfig> | undefined;
  readonly deps?: Partial<CommandDeps> | undefined;
}

/** Result returned by {@link CommandModule.availability}. */
export interface CommandAvailabilityCheck {
  readonly available: boolean;
  readonly reason?: string | null | undefined;
}

/** Per-command availability status produced by {@link commandAvailabilityReport}. */
export interface CommandAvailabilityEntry {
  readonly command: string;
  readonly hidden: boolean;
  readonly operatorOnly: boolean;
  readonly available: boolean;
  readonly menuVisible: boolean;
  readonly reason: string | null;
}

/** One self-contained slash command. */
export interface CommandModule {
  /**
   * Telegram command name, without the leading slash. Advertised commands must
   * also have an entry in `COMMAND_DESCRIPTIONS` (and a `COMMAND_DETAILS`
   * entry); hidden operator tools such as `/export` need neither.
   */
  readonly command: string;
  /**
   * Operator-only commands answer only the configured operator and are hidden
   * from the menu when no operator is configured. Non-operators are ignored
   * silently: an error reply would confirm the command exists.
   */
  readonly operatorOnly?: boolean;
  /**
   * Restricts the command to chats in `ALLOWED_CHAT_IDS`. Restricted commands
   * are ignored silently for the same reason as operator commands.
   */
  readonly chatAllowlist?: boolean;
  /**
   * Registered and usable, but not advertised in the Telegram command menu or
   * `/help` (e.g. `/export`, an operator recovery tool).
   */
  readonly hidden?: boolean;
  /**
   * Optional runtime dependency check. Returning `{ available: false, reason }`
   * marks the command disabled in {@link commandAvailabilityReport}, excludes it
   * from the public menu, and surfaces `reason` when explaining why it is off.
   */
  readonly availability?: (context: CommandAvailabilityContext) => CommandAvailabilityCheck;
  readonly handler: CommandHandler;
}

/** Menu and `/help` metadata for a registered command. */
export interface CommandMetadata {
  readonly command: string;
  readonly description: string;
  readonly operatorOnly: boolean;
}

const registered = new Map<string, CommandModule>();

/**
 * The English description registered with Telegram's command menu. A missing
 * entry is a boot-time programming error, not a silently blank menu line.
 */
function descriptionFor(command: string): string {
  const description = (COMMAND_DESCRIPTIONS as Readonly<Record<string, string>>)[command];
  if (description === undefined) {
    throw new Error(`no COMMAND_DESCRIPTIONS entry for /${command}`);
  }
  return description;
}

/**
 * Register a command module. Called at module load from each file in this
 * directory; importing a command module twice is harmless, registering two
 * modules for the same command is a programming error and throws at boot.
 */
export function defineCommand(module: CommandModule): CommandModule {
  const existing = registered.get(module.command);
  if (existing !== undefined && existing !== module) {
    throw new Error(`duplicate command registration: /${module.command}`);
  }
  registered.set(module.command, module);
  return module;
}

/** Every registered command, in registration (menu) order. */
export function registeredCommands(): readonly CommandModule[] {
  return [...registered.values()];
}

/** The module for a command name, or undefined when it is not registered. */
export function commandModule(command: string): CommandModule | undefined {
  return registered.get(command);
}

/**
 * Static command list: every advertised command with its English description.
 * Used by `/help`'s detail index and the i18n tests, which must see the full
 * list regardless of who is asking.
 */
export function commandMetadata(): CommandMetadata[] {
  return registeredCommands()
    .filter((module) => module.hidden !== true)
    .map((module) => ({
      command: module.command,
      description: descriptionFor(module.command),
      operatorOnly: module.operatorOnly === true,
    }));
}

/**
 * Evaluate whether one registered command module has its required runtime
 * configuration and optional data sources available.
 */
export function evaluateCommandAvailability(
  module: CommandModule,
  context: CommandAvailabilityContext = {},
): CommandAvailabilityEntry {
  const config = context.config ?? context.deps?.config;
  const deps = context.deps;
  const hidden = module.hidden === true;
  const operatorOnly = module.operatorOnly === true;

  if (operatorOnly && config !== undefined && config.operatorTelegramUserId === null) {
    return {
      command: module.command,
      hidden,
      operatorOnly,
      available: false,
      menuVisible: false,
      reason: "OPERATOR_TELEGRAM_USER_ID is not configured",
    };
  }

  if (
    (module.command === "status" || module.command === "health") &&
    deps !== undefined &&
    "status" in deps &&
    typeof deps.status !== "function"
  ) {
    return {
      command: module.command,
      hidden,
      operatorOnly,
      available: false,
      menuVisible: false,
      reason: "Poller status provider is absent",
    };
  }

  if (
    module.command === "pause" &&
    deps !== undefined &&
    "pause" in deps &&
    typeof deps.pause !== "function"
  ) {
    return {
      command: module.command,
      hidden,
      operatorOnly,
      available: false,
      menuVisible: false,
      reason: "Poller pause control is absent",
    };
  }

  if (
    module.command === "resume" &&
    deps !== undefined &&
    "resume" in deps &&
    typeof deps.resume !== "function"
  ) {
    return {
      command: module.command,
      hidden,
      operatorOnly,
      available: false,
      menuVisible: false,
      reason: "Poller resume control is absent",
    };
  }

  if (typeof module.availability === "function") {
    const check = module.availability({ config, deps });
    if (!check.available) {
      const reasonText = typeof check.reason === "string" ? check.reason.trim() : "";
      return {
        command: module.command,
        hidden,
        operatorOnly,
        available: false,
        menuVisible: false,
        reason: reasonText || `Optional runtime dependency for /${module.command} is absent`,
      };
    }
  }

  return {
    command: module.command,
    hidden,
    operatorOnly,
    available: true,
    menuVisible: !hidden,
    reason: null,
  };
}

/**
 * Inspect every registered command and report whether its runtime dependencies
 * are available, whether it belongs in the public menu, and why any disabled
 * command is unavailable.
 */
export function commandAvailabilityReport(
  config?: Partial<BotConfig>,
  deps?: Partial<CommandDeps>,
): CommandAvailabilityEntry[] {
  return registeredCommands().map((module) =>
    evaluateCommandAvailability(module, { config, deps }),
  );
}

/**
 * Render a concise, secret-free summary of command availability and disabled
 * data-source explanations for startup diagnostics or operator tooling.
 */
export function formatCommandAvailabilityReport(
  entries: readonly CommandAvailabilityEntry[],
): string {
  if (entries.length === 0) {
    return "No commands registered.";
  }
  const availableCount = entries.filter((entry) => entry.available).length;
  const lines = [`Command availability (${availableCount}/${entries.length} available):`];
  for (const entry of entries) {
    const scope = entry.hidden
      ? " [hidden]"
      : entry.menuVisible
        ? " [menu]"
        : " [excluded from menu]";
    if (entry.available) {
      lines.push(`- /${entry.command}: available${scope}`);
    } else {
      lines.push(
        `- /${entry.command}: disabled — ${entry.reason ?? "data source absent"}${scope}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Commands to advertise to this deployment: localized descriptions, operator-only
 * entries only when an operator is configured, and optional-dependency commands
 * only when their backing data source is available.
 */
export function visibleCommandMetadata(
  config?: BotConfig,
  deps?: Partial<CommandDeps>,
): CommandMetadata[] {
  const descriptions = messagesFor(config?.locale).commandDescriptions;
  return registeredCommands()
    .filter((module) => evaluateCommandAvailability(module, { config, deps }).menuVisible)
    .map((module) => ({
      command: module.command,
      description:
        (descriptions as Readonly<Record<string, string>>)[module.command] ??
        descriptionFor(module.command),
      operatorOnly: module.operatorOnly === true,
    }));
}
