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
import { helpDetailMessage } from "./help-detail.js";
import { defineCommand, visibleCommandMetadata } from "./registry.js";
import { commandArgument, replyMarkdown } from "./runtime.js";

/** The help overview: title, intro, and one line per advertised command. */
export function helpMessage(config?: BotConfig): string {
  const messages = messagesFor(config?.locale);
  return [
    messages.helpTitle,
    "",
    escapeMd(messages.helpIntro),
    "",
    ...visibleCommandMetadata(config).map(({ command, description }) =>
      escapeMd(`/${command} — ${description}`),
    ),
  ].join("\n");
}

export const startCommand = defineCommand({
  command: "start",
  handler: async (ctx, deps) => {
    await replyMarkdown(ctx, helpMessage(deps.config));
  },
});

export const helpCommand = defineCommand({
  command: "help",
  handler: async (ctx, deps) => {
    const arg = commandArgument(ctx);
    await replyMarkdown(
      ctx,
      arg ? helpDetailMessage(arg, deps.config) : helpMessage(deps.config),
    );
  },
});
