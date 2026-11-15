/**
 * Startup consistency check across the command catalogue, `/help`, Telegram's
 * command menu, and live registered handlers.
 *
 * Catching drift at boot prevents deploying a bot whose menu or `/help`
 * advertises a slash command that has no live handler wired to answer it.
 */

import type { BotConfig } from "../config.js";
import {
  COMMAND_DESCRIPTIONS,
  COMMAND_NAMES,
  SUPPORTED_LOCALES,
  messagesFor,
} from "../i18n.js";
import { COMMAND_DETAILS, type CommandDetail } from "./help-detail.js";
import { helpMessage } from "./help.js";
import {
  registeredCommands,
  visibleCommandMetadata,
  type CommandMetadata,
  type CommandModule,
} from "./registry.js";

/** Error thrown when an advertised command has no live handler or surface metadata drifts. */
export class CommandSurfaceValidationError extends Error {
  readonly problems: readonly string[];
  readonly missingCommands: readonly string[];

  constructor(problems: readonly string[], missingCommands: readonly string[]) {
    const uniqueMissing = [...new Set(missingCommands)];
    const formattedMissing = uniqueMissing.map((cmd) => `/${cmd}`).join(", ");
    const header =
      uniqueMissing.length > 0
        ? `Invalid command surface (unhandled or inconsistent: ${formattedMissing}):`
        : "Invalid command surface:";
    super([header, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
    this.name = "CommandSurfaceValidationError";
    this.problems = [...problems];
    this.missingCommands = uniqueMissing;
  }
}

export interface CommandSurfaceInput {
  readonly config?: BotConfig | undefined;
  readonly modules?:
    | readonly Pick<CommandModule, "command" | "hidden" | "operatorOnly" | "handler">[]
    | undefined;
  readonly boundHandlers?: Iterable<string> | undefined;
  readonly catalogueCommands?: readonly string[] | undefined;
  readonly localeDescriptions?:
    | Readonly<Record<string, Readonly<Record<string, string>>>>
    | undefined;
  readonly helpDetails?: Readonly<Record<string, CommandDetail>> | undefined;
  readonly helpOverviewText?: string | undefined;
  readonly menuMetadata?:
    | readonly Pick<CommandMetadata, "command" | "description" | "operatorOnly">[]
    | undefined;
}

/**
 * Parse advertised `/command — description` lines from rendered MarkdownV2
 * `/help` output.
 */
export function extractHelpOverviewCommands(helpText: string): string[] {
  const unescaped = helpText.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
  const commands: string[] = [];
  for (const rawLine of unescaped.split("\n")) {
    const match = /^\/([a-z0-9_-]+)\s+—\s+\S/.exec(rawLine.trim());
    if (match?.[1]) {
      commands.push(match[1]);
    }
  }
  return commands;
}

/**
 * Validate that every command advertised in the catalogue, `/help`, and
 * Telegram's command menu has a live registered callable handler, and that
 * every non-hidden registered command is documented consistently.
 *
 * Throws {@link CommandSurfaceValidationError} naming any missing or mismatched
 * command so an invalid deployment stops immediately at startup.
 */
export function validateCommandSurface(input: CommandSurfaceInput = {}): void {
  const problems: string[] = [];
  const missingCommands: string[] = [];

  const modules = input.modules ?? registeredCommands();
  const moduleByName = new Map<
    string,
    Pick<CommandModule, "command" | "hidden" | "operatorOnly" | "handler">
  >();
  const callableRegistered = new Set<string>();

  for (const mod of modules) {
    const name = (mod.command ?? "").trim();
    if (!name) {
      problems.push("Encountered a command module with an empty command name.");
      continue;
    }
    if (moduleByName.has(name)) {
      problems.push(`Duplicate command module entry for /${name}.`);
      missingCommands.push(name);
      continue;
    }
    moduleByName.set(name, mod);
    if (typeof mod.handler !== "function") {
      problems.push(`Command /${name} is registered without a callable handler.`);
      missingCommands.push(name);
      continue;
    }
    callableRegistered.add(name);
  }

  let liveHandlers: Set<string>;
  if (input.boundHandlers !== undefined) {
    const boundSet = new Set(input.boundHandlers);
    liveHandlers = new Set<string>();
    for (const cmd of callableRegistered) {
      if (boundSet.has(cmd)) {
        liveHandlers.add(cmd);
      } else {
        problems.push(
          `Registered command /${cmd} is not bound to a live handler on the bot registrar.`,
        );
        missingCommands.push(cmd);
      }
    }
  } else {
    liveHandlers = callableRegistered;
  }

  const catalogueList =
    input.catalogueCommands ?? [
      ...new Set([...COMMAND_NAMES, ...Object.keys(COMMAND_DESCRIPTIONS)]),
    ];
  const catalogueSet = new Set(catalogueList);

  for (const cmd of catalogueSet) {
    if (!liveHandlers.has(cmd)) {
      problems.push(`Catalogue advertises /${cmd} without a live registered handler.`);
      missingCommands.push(cmd);
      continue;
    }
    if (moduleByName.get(cmd)?.hidden === true) {
      problems.push(`Catalogue advertises hidden command /${cmd}.`);
      missingCommands.push(cmd);
    }
  }

  const localeTables: Readonly<Record<string, Readonly<Record<string, string>>>> =
    input.localeDescriptions ??
    (input.catalogueCommands === undefined
      ? Object.fromEntries(
          SUPPORTED_LOCALES.map((locale) => [
            locale,
            messagesFor(locale).commandDescriptions as unknown as Readonly<Record<string, string>>,
          ]),
        )
      : {});

  for (const [locale, descriptions] of Object.entries(localeTables)) {
    for (const [cmd, text] of Object.entries(descriptions)) {
      if (!liveHandlers.has(cmd)) {
        problems.push(
          `Locale "${locale}" commandDescriptions advertises /${cmd} without a live registered handler.`,
        );
        missingCommands.push(cmd);
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        problems.push(`Locale "${locale}" has an empty command description for /${cmd}.`);
        missingCommands.push(cmd);
      }
    }
  }

  const helpDetails = input.helpDetails ?? COMMAND_DETAILS;
  for (const cmd of Object.keys(helpDetails)) {
    if (!liveHandlers.has(cmd)) {
      problems.push(`Help details (COMMAND_DETAILS) advertise /${cmd} without a live registered handler.`);
      missingCommands.push(cmd);
      continue;
    }
    if (moduleByName.get(cmd)?.hidden === true) {
      problems.push(`Help details (COMMAND_DETAILS) advertise hidden command /${cmd}.`);
      missingCommands.push(cmd);
    }
  }

  const helpText =
    input.helpOverviewText ??
    (input.modules === undefined && input.catalogueCommands === undefined
      ? helpMessage(input.config)
      : undefined);

  if (helpText !== undefined) {
    for (const cmd of extractHelpOverviewCommands(helpText)) {
      if (!liveHandlers.has(cmd)) {
        problems.push(`Help overview (/help) advertises /${cmd} without a live registered handler.`);
        missingCommands.push(cmd);
      }
      if (!(cmd in helpDetails)) {
        problems.push(`Help overview (/help) advertises /${cmd} without a COMMAND_DETAILS entry.`);
        missingCommands.push(cmd);
      }
    }
  }

  const menuItems =
    input.menuMetadata ??
    (input.modules === undefined && input.catalogueCommands === undefined
      ? visibleCommandMetadata(input.config)
      : []);

  for (const item of menuItems) {
    if (!liveHandlers.has(item.command)) {
      problems.push(`Command menu advertises /${item.command} without a live registered handler.`);
      missingCommands.push(item.command);
    }
    if (typeof item.description !== "string" || item.description.trim().length === 0) {
      problems.push(`Command menu advertises /${item.command} with an empty description.`);
      missingCommands.push(item.command);
    }
  }

  for (const mod of modules) {
    const name = (mod.command ?? "").trim();
    if (!name || mod.hidden === true) continue;
    if (!catalogueSet.has(name)) {
      problems.push(`Advertised command module /${name} is missing from the command catalogue.`);
      missingCommands.push(name);
    }
    if (!(name in helpDetails)) {
      problems.push(`Advertised command module /${name} is missing from COMMAND_DETAILS.`);
      missingCommands.push(name);
    }
  }

  if (problems.length > 0) {
    throw new CommandSurfaceValidationError(problems, missingCommands);
  }
}
