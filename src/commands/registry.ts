/**
 * The slash-command registry.
 *
 * A command is a self-contained module under `src/commands/` (see
 * {@link CommandModule} in `./types.ts`): it declares its name, menu
 * description, who may run it, and its handler. `src/commands/index.ts` lists
 * the modules in menu order and registers that list here; `src/bot.ts` only
 * walks the registry, so adding a command no longer means editing a shared
 * `handlers` record there. Authorization is declared, not repeated: the
 * registrar applies `operatorOnly` and `allowlisted` before the handler runs.
 */

import type { BotConfig } from "../config.js";
import { COMMAND_DESCRIPTIONS, messagesFor } from "../i18n.js";
import type {
  CommandDefinition,
  CommandHandler,
  CommandMetadata,
  CommandModule,
} from "./types.js";

export type {
  CommandDefinition,
  CommandDeps,
  CommandHandler,
  CommandMetadata,
  CommandModule,
} from "./types.js";

const registered = new Map<string, CommandModule>();
const normalized = new WeakSet<object>();

/**
 * The English description registered with Telegram's command menu. A missing
 * entry for an advertised command is a boot-time programming error, not a
 * silently blank menu line.
 */
function defaultDescription(command: string, hidden: boolean): string {
  const description = (COMMAND_DESCRIPTIONS as Readonly<Record<string, string>>)[command];
  if (description !== undefined) return description;
  if (hidden) return "";
  throw new Error(`no COMMAND_DESCRIPTIONS entry for /${command}`);
}

/**
 * Build a {@link CommandModule} from what a command file writes: fills in the
 * flag defaults and the menu description. Does not register anything — the
 * catalogue in `src/commands/index.ts` decides what is registered, and in
 * which order.
 */
export function createCommandModule(definition: CommandDefinition | CommandModule): CommandModule {
  if (normalized.has(definition)) return definition as CommandModule;

  const handle: CommandHandler | undefined = definition.handle ?? definition.handler;
  if (typeof handle !== "function") {
    throw new Error(`/${definition.command} has no handler`);
  }
  const hidden = definition.hidden === true;
  const allowlisted = definition.allowlisted === true || definition.chatAllowlist === true;
  const module: CommandModule = {
    command: definition.command,
    description: definition.description ?? defaultDescription(definition.command, hidden),
    operatorOnly: definition.operatorOnly === true,
    allowlisted,
    hidden,
    handle,
    handler: handle,
    chatAllowlist: allowlisted,
  };
  normalized.add(module);
  return module;
}

/**
 * Register a command module. Registering the same module twice is harmless;
 * registering two different modules for one command is a programming error
 * and throws at boot.
 */
export function defineCommand(definition: CommandDefinition | CommandModule): CommandModule {
  const module = createCommandModule(definition);
  const existing = registered.get(module.command);
  if (existing !== undefined && existing !== module) {
    throw new Error(`duplicate command registration: /${module.command}`);
  }
  registered.set(module.command, module);
  return module;
}

/** Register an ordered list of modules; list order becomes menu order. */
export function registerCommandModules(
  modules: readonly (CommandDefinition | CommandModule)[],
): readonly CommandModule[] {
  return modules.map((module) => defineCommand(module));
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
    .filter((module) => !module.hidden)
    .map((module) => ({
      command: module.command,
      description: module.description,
      operatorOnly: module.operatorOnly,
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
    .filter((module) => !module.hidden)
    .filter((module) => operatorConfigured || !module.operatorOnly)
    .map((module) => ({
      command: module.command,
      description:
        (descriptions as Readonly<Record<string, string>>)[module.command] ?? module.description,
      operatorOnly: module.operatorOnly,
    }));
}
