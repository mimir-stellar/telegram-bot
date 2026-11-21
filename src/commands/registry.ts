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
import type { FollowStore } from "../subscriptions/store.js";

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
  followStore?: FollowStore | undefined;
}

/** A slash command handler: grammy's command context plus the bot's deps. */
export type CommandHandler = (
  ctx: CommandContext<Context>,
  deps: CommandDeps,
) => Promise<void>;

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
  readonly handler: CommandHandler;
}

/** Menu and `/help` metadata for a registered command. */
export interface CommandMetadata {
  readonly command: string;
  readonly description: string;
  readonly operatorOnly: boolean;
}

/** One consistency mismatch between the command catalogue, menu, and `/help`. */
export interface CommandConsistencyIssue {
  readonly command: string;
  readonly source: "catalogue" | "menu" | "help";
  readonly message: string;
}

/** Inputs for {@link findCommandConsistencyIssues} and {@link validateCommandConsistency}. */
export interface CommandConsistencyOptions {
  /** Registered command modules (defaults to the live registry). */
  readonly modules?: readonly CommandModule[];
  /** Menu/autocomplete descriptions (defaults to `COMMAND_DESCRIPTIONS`). */
  readonly menuDescriptions?: Readonly<Record<string, string>>;
  /** Detailed `/help <command>` entries (pass `COMMAND_DETAILS` to check help parity). */
  readonly helpDetails?: Readonly<Record<string, { readonly operatorOnly?: boolean }>>;
}

/**
 * Thrown at startup when an advertised command has no live registered handler
 * or when the catalogue, menu descriptions, and `/help` details disagree.
 */
export class CommandConsistencyError extends Error {
  readonly issues: readonly CommandConsistencyIssue[];

  constructor(issues: readonly CommandConsistencyIssue[]) {
    const summary = issues.map((issue) => `/${issue.command}: ${issue.message}`).join("; ");
    super(`command consistency check failed: ${summary}`);
    this.name = "CommandConsistencyError";
    this.issues = issues;
  }
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
 * Commands to advertise to this deployment: localized descriptions, and
 * operator-only entries only when an operator is configured (there is no one
 * to run them otherwise).
 */
export function visibleCommandMetadata(config?: BotConfig): CommandMetadata[] {
  const descriptions = messagesFor(config?.locale).commandDescriptions;
  const operatorConfigured = config === undefined || config.operatorTelegramUserId !== null;
  return registeredCommands()
    .filter((module) => module.hidden !== true)
    .filter((module) => operatorConfigured || module.operatorOnly !== true)
    .map((module) => ({
      command: module.command,
      description:
        (descriptions as Readonly<Record<string, string>>)[module.command] ??
        descriptionFor(module.command),
      operatorOnly: module.operatorOnly === true,
    }));
}

/**
 * Inspect the command catalogue, menu descriptions, and `/help` detail entries
 * for drift — in particular, any advertised command without a live registered
 * handler.
 */
export function findCommandConsistencyIssues(
  options?: CommandConsistencyOptions,
): CommandConsistencyIssue[] {
  const modules = options?.modules ?? registeredCommands();
  const menuDescriptions =
    options?.menuDescriptions ?? (COMMAND_DESCRIPTIONS as Readonly<Record<string, string>>);
  const helpDetails = options?.helpDetails;

  const issues: CommandConsistencyIssue[] = [];
  const byName = new Map<string, CommandModule>();

  for (const module of modules) {
    byName.set(module.command, module);

    if (typeof module.handler !== "function") {
      issues.push({
        command: module.command,
        source: "catalogue",
        message: "registered command has no callable handler",
      });
    }

    if (module.hidden !== true) {
      const description = menuDescriptions[module.command];
      if (typeof description !== "string" || description.trim().length === 0) {
        issues.push({
          command: module.command,
          source: "menu",
          message: "advertised command is missing a menu description in COMMAND_DESCRIPTIONS",
        });
      }

      if (helpDetails !== undefined) {
        const detail = helpDetails[module.command];
        if (detail === undefined) {
          issues.push({
            command: module.command,
            source: "help",
            message: "advertised command is missing a help entry in COMMAND_DETAILS",
          });
        } else if (
          detail.operatorOnly !== undefined &&
          Boolean(detail.operatorOnly) !== Boolean(module.operatorOnly)
        ) {
          issues.push({
            command: module.command,
            source: "help",
            message: "help entry operatorOnly flag disagrees with registered module",
          });
        }
      }
    }
  }

  for (const command of Object.keys(menuDescriptions)) {
    const module = byName.get(command);
    if (module === undefined) {
      issues.push({
        command,
        source: "menu",
        message: "advertised in COMMAND_DESCRIPTIONS without a live registered handler",
      });
    } else if (module.hidden === true) {
      issues.push({
        command,
        source: "menu",
        message: "hidden command must not be advertised in COMMAND_DESCRIPTIONS",
      });
    }
  }

  if (helpDetails !== undefined) {
    for (const command of Object.keys(helpDetails)) {
      const module = byName.get(command);
      if (module === undefined) {
        issues.push({
          command,
          source: "help",
          message: "advertised in COMMAND_DETAILS without a live registered handler",
        });
      } else if (module.hidden === true) {
        issues.push({
          command,
          source: "help",
          message: "hidden command must not be advertised in COMMAND_DETAILS",
        });
      }
    }
  }

  return issues;
}

/**
 * Throw {@link CommandConsistencyError} naming every inconsistent command if
 * the catalogue, menu, and `/help` tables disagree.
 */
export function validateCommandConsistency(options?: CommandConsistencyOptions): void {
  const issues = findCommandConsistencyIssues(options);
  if (issues.length > 0) {
    throw new CommandConsistencyError(issues);
  }
}
