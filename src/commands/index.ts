/**
 * The command catalogue — the one place that knows which commands exist.
 *
 * {@link COMMAND_MODULES} is the ordered list of slash commands; its order is
 * the order Telegram's menu and `/help` list them in. Adding a command:
 *
 *   1. create `src/commands/<name>.ts` exporting a module from
 *      `createCommandModule({ command, description?, operatorOnly?, allowlisted?, hidden?, handle })`
 *      (see `CommandModule` in `./types.ts`)
 *   2. add it to `COMMAND_MODULES` below — in menu order — and re-export
 *      anything `src/bot.ts` or the tests need
 *   3. if the command is advertised, add its description to
 *      `COMMAND_DESCRIPTIONS` (both locales) in `src/i18n.ts` and its entry to
 *      `COMMAND_DETAILS` in `src/commands/help-detail.ts`
 *
 * `src/bot.ts` never needs editing: it registers whatever the registry holds
 * and applies `operatorOnly` / `allowlisted` centrally.
 */

import { aboutCommand } from "./about.js";
import { auditCommand } from "./audit.js";
import { contractsCommand } from "./contracts.js";
import { healthCommand } from "./health.js";
import { helpCommand, startCommand } from "./help.js";
import { logExportCommand } from "./log-export.js";
import { pauseCommand } from "./pause.js";
import { previewCommand } from "./preview.js";
import { registerCommandModules } from "./registry.js";
import { resumeCommand } from "./resume.js";
import { statusCommand } from "./status.js";
import type { CommandModule } from "./types.js";

/** Every slash command, in menu order. */
export const COMMAND_MODULES: readonly CommandModule[] = Object.freeze([
  startCommand,
  helpCommand,
  aboutCommand,
  statusCommand,
  auditCommand,
  contractsCommand,
  healthCommand,
  previewCommand,
  pauseCommand,
  resumeCommand,
  logExportCommand, // hidden: operator log export
]);

registerCommandModules(COMMAND_MODULES);

export {
  commandMetadata,
  commandModule,
  createCommandModule,
  defineCommand,
  registerCommandModules,
  registeredCommands,
  visibleCommandMetadata,
  type CommandDefinition,
  type CommandDeps,
  type CommandHandler,
  type CommandMetadata,
  type CommandModule,
} from "./registry.js";
export {
  TELEGRAM_OPTIONS,
  chatAllowed,
  commandArgument,
  isChatAllowed,
  isOperator,
  operatorAllowed,
  replyMarkdown,
} from "./runtime.js";
export {
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  contractsKeyboard,
  operatorKeyboard,
  pauseConfirmKeyboard,
  statusKeyboard,
} from "./keyboards.js";
export { aboutMessage, aboutCommand } from "./about.js";
export { helpCommand, helpMessage, startCommand } from "./help.js";
export { auditCommand, renderAuditForTelegram } from "./audit.js";
export { contractsCommand, contractsMessage } from "./contracts.js";
export { healthCommand, healthMessage } from "./health.js";
export { pauseCommand, pauseMessage, PAUSE_PROMPT } from "./pause.js";
export { previewCommand } from "./preview.js";
export { resumeCommand, resumeMessage } from "./resume.js";
export { lastEventMessage, statusCommand, statusMessage } from "./status.js";
export { logExportCommand } from "./log-export.js";
