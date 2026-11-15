/**
 * `/start` and `/help`.
 *
 * `/start` is the welcome — the same command overview `/help` prints — and it
 * is registered first so the menu opens with it. `/help <command>` narrows to
 * usage, arguments and examples via {@link helpDetailMessage}. The overview is
 * generated from the command registry, so a new command appears here without
 * editing this file.
 */

import { escapeMd } from "../notifications/format.js";
import { messagesFor } from "../i18n.js";
import type { BotConfig } from "../config.js";
import { COMMAND_DETAILS, helpDetailMessage } from "./help-detail.js";
import { defineCommand, publicCommandMetadata, visibleCommandMetadata } from "./registry.js";
import { commandArgument, isOperator, replyMarkdown } from "./runtime.js";

export interface HelpMessageOptions {
  includeOperator?: boolean | undefined;
}

/** The help overview: title, intro, and one line per advertised command. */
export function helpMessage(config?: BotConfig, options?: HelpMessageOptions): string {
  const messages = messagesFor(config?.locale);
  const entries =
    options?.includeOperator === false
      ? publicCommandMetadata(config)
      : visibleCommandMetadata(config);
  return [
    messages.helpTitle,
    "",
    escapeMd(messages.helpIntro),
    "",
    ...entries.map(({ command, description }) => escapeMd(`/${command} — ${description}`)),
  ].join("\n");
}

function shouldShowOperatorCommands(
  ctx: { from?: { id: number } | undefined; chat?: { type?: string } | undefined },
  config: BotConfig,
): boolean {
  if (ctx.from === undefined) {
    return config.operatorTelegramUserId !== null;
  }
  if (!isOperator(ctx as Parameters<typeof isOperator>[0], config)) {
    return false;
  }
  if (ctx.chat?.type !== undefined && ctx.chat.type !== "private") {
    return false;
  }
  return true;
}

export const startCommand = defineCommand({
  command: "start",
  handler: async (ctx, deps) => {
    const includeOperator = shouldShowOperatorCommands(ctx, deps.config);
    await replyMarkdown(ctx, helpMessage(deps.config, { includeOperator }));
  },
});

export const helpCommand = defineCommand({
  command: "help",
  handler: async (ctx, deps) => {
    const includeOperator = shouldShowOperatorCommands(ctx, deps.config);
    const arg = commandArgument(ctx);
    if (!arg) {
      await replyMarkdown(ctx, helpMessage(deps.config, { includeOperator }));
      return;
    }
    const normalized = arg.trim().replace(/^\//, "").toLowerCase();
    const detail = COMMAND_DETAILS[normalized];
    if (!detail || (detail.operatorOnly && !includeOperator)) {
      await replyMarkdown(ctx, helpMessage(deps.config, { includeOperator }));
      return;
    }
    await replyMarkdown(ctx, helpDetailMessage(arg, deps.config));
  },
});
