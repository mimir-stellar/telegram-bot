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
import type { BotCommand, UserFromGetMe } from "grammy/types";

import type { AuditLog } from "../audit.js";
import type { BotConfig } from "../config.js";
import { COMMAND_DESCRIPTIONS, messagesFor } from "../i18n.js";
import type { LogCapture } from "../logger.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "../poller.js";
import type { BroadcastStore } from "./broadcast.js";
import type { FollowStore } from "../subscriptions/store.js";
import type { PendingDigestWindow } from "../notifications/digest-preview.js";

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
  /**
   * Follow store for subscription data. When provided, the operator can use
   * `/matchpreview` to count how many chats follow a given event reference.
   * Absent means that command reports zero matches.
   */
  follows?: FollowStore | undefined;
  /**
   * Optional read-only view of the current pending digest window backing
   * `/digestpreview`. Absent means `/digestpreview` reports that no pending
   * digest window is configured.
   */
  digestWindow?: PendingDigestWindow | undefined;
}

/** A slash command handler: grammy's command context plus the bot's deps. */
export type CommandHandler = (
  ctx: CommandContext<Context>,
  deps: CommandDeps,
) => Promise<void>;

/** Result of checking whether a command's optional runtime dependencies are satisfied. */
export interface CommandAvailabilityCheckResult {
  readonly available: boolean;
  /** Human-readable explanation when `available` is false. */
  readonly reason?: string;
}

/**
 * Runtime availability predicate for a command that depends on an optional
 * data source or capability (e.g. log ring, audit log, broadcast store).
 */
export type CommandAvailabilityCheck = (
  deps?: Partial<CommandDeps>,
) => CommandAvailabilityCheckResult;

/** One self-contained slash command. */
export interface CommandModule {
  /**
   * Telegram command name, without the leading slash. Advertised commands must
   * also have an entry in `COMMAND_DESCRIPTIONS` (and a `COMMAND_DETAILS`
   * entry); hidden operator tools such as `/export` need neither.
   */
  readonly command: string;
  /**
   * Operator-only commands answer only the configured operator. They are kept
   * out of the default Telegram menu and advertised only in the operator's
   * private chat; with no operator configured they are omitted entirely.
   * Non-operators are ignored silently: an error reply would confirm the
   * command exists, and a cached Telegram menu is never an authorization gate.
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
   * Optional runtime dependency check. When it reports `available: false`, the
   * command is excluded from the public menu (when deps are supplied) and
   * included with its reason in {@link commandAvailabilityReport}.
   */
  readonly availability?: CommandAvailabilityCheck;
  readonly handler: CommandHandler;
}

/** Menu and `/help` metadata for a registered command. */
export interface CommandMetadata {
  readonly command: string;
  readonly description: string;
  readonly operatorOnly: boolean;
}

/** Availability status for a single registered command. */
export interface CommandAvailabilityEntry {
  readonly command: string;
  readonly available: boolean;
  readonly hidden: boolean;
  readonly operatorOnly: boolean;
  /** Explains why the command is disabled when `available` is false. */
  readonly reason?: string;
}

/** Summary report of command availability for a set of runtime dependencies. */
export interface CommandAvailabilityReport {
  readonly entries: readonly CommandAvailabilityEntry[];
  readonly available: readonly CommandAvailabilityEntry[];
  readonly unavailable: readonly CommandAvailabilityEntry[];
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

const DEFAULT_UNAVAILABLE_REASON = "Required runtime dependency is not configured.";

function evaluateAvailability(
  module: CommandModule,
  deps?: Partial<CommandDeps>,
): CommandAvailabilityEntry {
  const hidden = module.hidden === true;
  const operatorOnly = module.operatorOnly === true;

  if (operatorOnly && deps?.config?.operatorTelegramUserId === null) {
    return {
      command: module.command,
      available: false,
      hidden,
      operatorOnly,
      reason: "No operator is configured (OPERATOR_TELEGRAM_USER_ID is unset).",
    };
  }

  if (module.availability !== undefined) {
    const result = module.availability(deps);
    if (!result.available) {
      const reason = result.reason?.trim() || DEFAULT_UNAVAILABLE_REASON;
      return {
        command: module.command,
        available: false,
        hidden,
        operatorOnly,
        reason,
      };
    }
  }

  return {
    command: module.command,
    available: true,
    hidden,
    operatorOnly,
  };
}

/**
 * Report command availability for the supplied runtime dependencies, explaining
 * why each disabled command cannot run when its optional data source is absent.
 */
export function commandAvailabilityReport(
  deps?: Partial<CommandDeps>,
): CommandAvailabilityReport {
  const entries = registeredCommands().map((module) => evaluateAvailability(module, deps));
  return {
    entries,
    available: entries.filter((entry) => entry.available),
    unavailable: entries.filter((entry) => !entry.available),
  };
}

/** Render a concise human-readable summary of a {@link CommandAvailabilityReport}. */
export function formatCommandAvailabilityReport(report: CommandAvailabilityReport): string {
  const header = `Command availability: ${report.available.length} available, ${report.unavailable.length} disabled`;
  if (report.unavailable.length === 0) {
    return header;
  }
  const disabledLines = report.unavailable.map(
    (entry) => `- /${entry.command}: ${entry.reason ?? DEFAULT_UNAVAILABLE_REASON}`,
  );
  return [header, "Disabled:", ...disabledLines].join("\n");
}

/**
 * Commands to advertise to this deployment: localized descriptions, operator-only
 * entries only when an operator is configured, and — when `deps` is supplied —
 * only commands whose optional runtime dependencies are available.
 */
export function visibleCommandMetadata(
  config?: BotConfig,
  deps?: Partial<CommandDeps>,
): CommandMetadata[] {
  const descriptions = messagesFor(config?.locale).commandDescriptions;
  const operatorConfigured = config === undefined || config.operatorTelegramUserId !== null;
  const effectiveDeps: Partial<CommandDeps> | undefined =
    deps !== undefined ? (config !== undefined ? { config, ...deps } : deps) : undefined;
  return registeredCommands()
    .filter((module) => module.hidden !== true)
    .filter((module) => operatorConfigured || module.operatorOnly !== true)
    .filter((module) => {
      if (effectiveDeps === undefined || module.availability === undefined) {
        return true;
      }
      return module.availability(effectiveDeps).available;
    })
    .map((module) => ({
      command: module.command,
      description:
        (descriptions as Readonly<Record<string, string>>)[module.command] ??
        descriptionFor(module.command),
      operatorOnly: module.operatorOnly === true,
    }));
}

/** One Telegram `setMyCommands` payload and the scope where it should apply. */
export interface CommandMenu {
  /** Commands to advertise, in registration (menu) order. */
  readonly commands: readonly BotCommand[];
  /** Absent means Telegram's default scope: every chat that has not got a narrower menu. */
  readonly scope?: {
    readonly type: "chat";
    /** `OPERATOR_TELEGRAM_USER_ID`; a user's private chat id is their user id. */
    readonly chat_id: string;
  };
}

/**
 * Build the menus `registerCommands` sends to Telegram.
 *
 * The default menu deliberately excludes operator-only commands: Telegram
 * caches menus per chat and may keep showing them after configuration changes,
 * so a menu entry is advertising, not authorization. When an operator is
 * configured, the full menu is registered for that operator's private chat so
 * they keep every command they can already run. Runtime gates in `src/bot.ts`
 * continue to decide who may actually execute a command.
 */
export function commandMenus(config?: BotConfig): readonly CommandMenu[] {
  const visible = visibleCommandMetadata(config);
  const telegramCommands = (items: readonly CommandMetadata[]): readonly BotCommand[] =>
    items.map(({ command, description }) => ({ command, description }));

  const menus: CommandMenu[] = [
    { commands: telegramCommands(visible.filter(({ operatorOnly }) => !operatorOnly)) },
  ];

  const operatorChatId = config?.operatorTelegramUserId;
  if (operatorChatId !== null && operatorChatId !== undefined && operatorChatId.length > 0) {
    menus.push({
      commands: telegramCommands(visible),
      scope: { type: "chat", chat_id: operatorChatId },
    });
  }

  return menus;
}
