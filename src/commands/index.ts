/**
 * The command catalogue — the one place that knows which commands exist.
 *
 * Every module below calls `defineCommand` when it loads, and the import order
 * here is the order Telegram's menu and `/help` list them in. Adding a command:
 *
 *   1. create `src/commands/<name>.ts` and export a module from
 *      `defineCommand({ command, operatorOnly?, chatAllowlist?, hidden?, handler })`
 *   2. add one import line here — in menu order — and re-export anything
 *      `src/bot.ts` or the tests need
 *   3. if the command is advertised, add its description to
 *      `COMMAND_DESCRIPTIONS` (both locales) in `src/i18n.ts` and its entry to
 *      `COMMAND_DETAILS` in `src/commands/help-detail.ts`
 *
 * `src/bot.ts` never needs editing: it registers whatever the registry holds.
 */

// Registration order = menu order. Keep this list in sync with the menu.
import "./help.js"; // registers /start and /help, in that order
import "./about.js";
import "./status.js";
import "./audit.js";
import "./contracts.js";
import "./health.js";
import "./preview.js";
import "./pause.js";
import "./resume.js";
import "./log-export.js"; // hidden: operator log export

export {
  commandMetadata,
  commandModule,
  defineCommand,
  registeredCommands,
  visibleCommandMetadata,
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
